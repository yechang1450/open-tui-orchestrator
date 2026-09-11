import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {probeCli} from './host-probe.mjs';
import {profilesDir,loadProfile} from './print-profile.mjs';
import {detectHostAgent} from './host-cli.mjs';
import {readMaintenanceLock,acquireMaintenanceLock,releaseMaintenanceLock} from './maintenance-lock.mjs';

// 自动适配（print-class 画像管线）：
//   探测 CLI 表面 → 生成画像 → 解析自检 → 活体验证（真实调用一次，取回探活令牌）
//   → 重封 → 自动提交（默认开）。任何一步失败都回滚，仓库保持原状（fail-closed）。
// 成功 = 表面探测 + 解析自检 + 活体验证；测试套件可用 --suite 追加。

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILTIN = new Set(['pi', 'openclaw', 'opencode', 'kimi', 'claude', 'codex']);
export const PROMPT_FLAG_CANDIDATES = ['-p', '--print', '--message', '-m'];
export const APPROVE_CANDIDATES = ['--yes-always', '--dangerously-skip-permissions', '--yolo', '--auto', '--approve', '--full-auto', '--dangerously-bypass-approvals-and-sandbox'];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: 120000, ...opts });
}

export function locateCli(id, env = process.env, explicit) {
  const path0 = explicit || env.ORCH_CLI || env[String(id).toUpperCase() + '_EXE'];
  if (path0) {
    const file = path.resolve(path0);
    if (!fs.existsSync(file)) return { missing: file };
    if (/\.m?js$/i.test(file)) { const sibling = path.join(path.dirname(file), 'node.exe'); return { bin: fs.existsSync(sibling) ? sibling : process.execPath, prefixArgs: [file], source: file }; }
    return { bin: file };
  }
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exe = dirs.map((d) => path.join(d, id + '.exe')).find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  if (exe) return { bin: exe };
  const shim = [...dirs.map((d) => path.join(d, id + '.cmd')), ...dirs.map((d) => path.join(d, id))].find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  if (shim) return { shim };
  return { missing: id };
}

export async function adaptAgent({ id, cli, env = process.env, live = true, commit = true, suite = false, force = false, writeProfile = true } = {}) {
  const report = { id, cli: null, version: null, profile: null, live: null, committed: false, passed: false };
  if (!id) { report.reason = 'no agent id (pass --agent or set ORCH_AGENT)'; return report; }
  if (BUILTIN.has(id)) { report.reason = id + ' already has a dedicated adapter; nothing to adapt'; report.passed = true; report.skipped = 'builtin'; return report; }
  const lock = readMaintenanceLock(env);
  if (lock.locked && !force) { report.reason = 'maintenance lock is held; retry after unlock (or force)'; return report; }
  const located = locateCli(id, env, cli);
  if (located.shim) { report.reason = 'only a shell shim found at ' + located.shim + '; point --cli/ORCH_CLI at the real executable (.exe)'; return report; }
  if (located.missing) { report.reason = 'CLI not found for ' + id + ' (looked on PATH; pass --cli/ORCH_CLI)'; return report; }
  report.cli = located.source || located.bin;
  const prefixArgs = located.prefixArgs || [];

  const versionResult = probeCli(located.bin, [...prefixArgs, '--version'], { env });
  const version = /(\d+\.\d+\.\d+)/.exec(String(versionResult.stdout || ''))?.[1];
  if (versionResult.status !== 0 || !version) { report.reason = '--version probe failed: ' + (versionResult.error || 'exit ' + versionResult.status + ' out=' + JSON.stringify(String(versionResult.stdout || '').slice(0, 120))); return report; }
  report.version = version;

  const help = probeCli(located.bin, [...prefixArgs, '--help'], { env });
  if (help.status !== 0) { report.reason = '--help probe failed: ' + (help.error || 'exit ' + help.status); return report; }
  const helpText = help.out;
  const promptFlag = PROMPT_FLAG_CANDIDATES.find((f) => new RegExp('(^|[\\s,])' + f.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '([\\s,]|$)').test(helpText));
  if (!promptFlag) { report.reason = 'no one-shot prompt flag found (candidates: ' + PROMPT_FLAG_CANDIDATES.join(' ') + '); not a print-class CLI — needs a manual adapter'; return report; }
  const approve = APPROVE_CANDIDATES.filter((f) => helpText.includes(f));
  const model = helpText.includes('--model') ? ['--model'] : null;
  const effort = helpText.includes('--effort') ? ['--effort'] : null;
  const probeToken = 'ADAPTOK-' + Math.random().toString(36).slice(2, 10);
  const profile = {
    schema: 1,
    id,
    label: id,
    bin: [id + '.exe', id + '.cmd', id],
    helpFlags: [promptFlag, ...approve],
    versionPattern: '(\\d+\\.\\d+\\.\\d+)',
    probePrompt: 'reply with exactly ' + probeToken + ' and nothing else',
    envMarkers: [],
    processNames: ['^' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\.exe)?$'],
    args: { approve, extra: [], model, effort, prompt: [promptFlag] },
    adaptedAt: new Date().toISOString(),
    adaptedFrom: { cli: located.source || located.bin, version, prefixArgs: prefixArgs.length ? prefixArgs : undefined },
  };
  report.profile = profile;

  const profileFile = path.join(profilesDir(env), id + '.json');
  fs.mkdirSync(path.dirname(profileFile), { recursive: true });
  const prev = fs.existsSync(profileFile) ? fs.readFileSync(profileFile, 'utf8') : null;
  const rollback = () => {
    try { if (prev === null) fs.rmSync(profileFile, { force: true }); else fs.writeFileSync(profileFile, prev, 'utf8'); } catch { /* ignore */ }
  };
  if (writeProfile) fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2) + '\n', 'utf8');

  try {
    const { resolveProfileHost } = await import('./print-profile.mjs');
    const host = resolveProfileHost({ ...env, ORCH_AGENT_PROFILES_DIR: profilesDir(env), ORCH_CLI: located.source || located.bin }, id);
    if (!host || host.config.version !== version) { report.reason = 'resolution self-check failed'; rollback(); return report; }
  } catch (error) { report.reason = 'resolution self-check failed: ' + error.message; rollback(); return report; }

  if (live) {
    const { profileArgs } = await import('./print-profile.mjs');
    const args = [...prefixArgs, ...profileArgs({ prefixArgs: [], profile }, {}), profile.probePrompt];
    const t0 = Date.now();
    const res = run(located.bin, args, { env, cwd: process.cwd(), timeout: 240000 });
    const out = String(res.stdout || '') + String(res.stderr || '');
    const answered = out.split(/\r?\n/).some((line) => line.includes(probeToken) && !/reply with exactly/i.test(line));
    report.live = { exit: res.status, ms: Date.now() - t0, answered, tail: out.trim().slice(-400) };
    if (!answered) { report.reason = 'live probe did not return the token (exit=' + res.status + ')'; rollback(); return report; }
  } else report.live = { skipped: 'no-live' };

  if (suite) {
    const s = run(process.execPath, ['--test', 'test/print-profile.test.mjs'], { cwd: REPO, env: { ...env, ORCH_AGENT: 'codex', ORCH_MAINTENANCE_LOCK: path.join(REPO, 'temp', 'adapt-suite-lock-none.json') }, timeout: 300000 });
    report.suite = { exit: s.status };
    if (s.status !== 0) { report.reason = 'print-profile suite failed'; rollback(); return report; }
  }

  if (writeProfile && commit) {
    acquireMaintenanceLock({ reason: 'auto-adapt ' + id, ttlMinutes: 30, env });
    try {
      const seal = run(process.execPath, [path.join(REPO, 'scripts', 'release-integrity.mjs'), '--seal'], { cwd: REPO, env });
      if (seal.status !== 0) { report.reason = 'reseal failed: ' + String(seal.stderr || '').slice(0, 200); rollback(); run(process.execPath, [path.join(REPO, 'scripts', 'release-integrity.mjs'), '--seal'], { cwd: REPO, env }); return report; }
      const rel = path.relative(REPO, profileFile).split(path.sep).join('/');
      const add = run('git', ['add', '--', rel, 'release.json'], { cwd: REPO, env });
      const commitResult = run('git', ['commit', '-m', 'feat(adapt): print-class profile for ' + id + ' (' + version + ') [auto-generated]'], { cwd: REPO, env });
      report.committed = commitResult.status === 0;
      report.gitAdd = add.status;
    } finally { releaseMaintenanceLock(env); }
  }

  report.passed = true;
  return report;
}

export async function autoAdaptIfNeeded(env = process.env) {
  if (readMaintenanceLock(env).locked) return { skipped: 'maintenance-lock' };
  let id;
  try { id = detectHostAgent(env); } catch { return { skipped: 'host-unknown' }; }
  if (BUILTIN.has(id) || loadProfile(id, env)) return { skipped: 'already-adapted', id };
  const report = await adaptAgent({ id, env, live: true, commit: true, writeProfile: true });
  if (!report.passed) throw new Error('AUTO_ADAPT_FAILED: ' + id + ' — ' + (report.reason || 'unknown') + (report.live ? ' | live: exit=' + (report.live.exit ?? 'n/a') : ''));
  return report;
}
