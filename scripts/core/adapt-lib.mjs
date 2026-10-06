import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {probeCli} from './host-probe.mjs';
import {profilesDir,loadProfile} from './print-profile.mjs';
import {detectHostAgent} from './host-cli.mjs';
import {readProfileKey,readSectionKey} from './host-model.mjs';
import {readMaintenanceLock,acquireMaintenanceLock,releaseMaintenanceLock} from './maintenance-lock.mjs';

// 自动适配（print-class 画像管线）：
//   探测 CLI 表面 → 生成画像 → 解析自检 → 活体验证（真实调用一次，取回探活令牌）
//   → 重封 → 自动提交（默认开）。任何一步失败都回滚，仓库保持原状（fail-closed）。
// 成功 = 表面探测 + 解析自检 + 活体验证；测试套件可用 --suite 追加。

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILTIN = new Set(['pi', 'openclaw', 'opencode', 'kimi', 'claude', 'codex']);
export const PROMPT_FLAG_CANDIDATES = ['-p', '--print', '-z', '--oneshot', '--prompt', '--message', '--ask', '--run', '--exec', '-m'];
export const APPROVE_CANDIDATES = ['--yes-always', '--dangerously-skip-permissions', '--yolo', '--auto', '--approve', '--full-auto', '--dangerously-bypass-approvals-and-sandbox'];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: 120000, ...opts });
}

// 精确候选发现：只读固定键名与固定候选路径，绝不猜测值。
// 供 adapt 写入画像的 modelDetection（engine 端 host-model.detectProfile 消费）。
export function discoverModelDetection(id, { home = process.env.USERPROFILE || process.env.HOME || '', env = process.env } = {}) {
  const spec = {};
  const up = String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const envHit = [up + '_MODEL', up + '_DEFAULT_MODEL'].find((n) => env[n] && String(env[n]).trim());
  if (envHit) spec.env = [envHit];
  const effortEnvHit = [up + '_EFFORT', up + '_THINKING'].find((n) => env[n] && String(env[n]).trim());
  if (effortEnvHit) spec.effortEnv = [effortEnvHit];
  const MODEL_KEYS = ['model', 'defaultModel', 'default_model'];
  const EFFORT_KEYS = ['effort', 'defaultEffort', 'thinking', 'defaultThinkingLevel'];
  const candidates = [
    '.' + id + '.conf.yml', '.' + id + '.conf.yaml', '.' + id + '.json',
    path.join('.' + id, 'settings.json'), path.join('.' + id, 'config.json'),
    path.join('.config', id, 'config.json'), path.join('.config', id, 'config.jsonc'),
    path.join('.config', id, 'settings.json'),
  ];
  if (home) for (const rel of candidates) {
    const file = path.join(home, rel);
    try { if (!fs.statSync(file).isFile()) continue; } catch { continue; }
    let modelKey = '', effortKey = '';
    for (const k of MODEL_KEYS) { try { if (readProfileKey(file, k)) { modelKey = k; break; } } catch { /* try next key */ } }
    for (const k of EFFORT_KEYS) { try { if (readProfileKey(file, k)) { effortKey = k; break; } } catch { /* try next key */ } }
    if (modelKey || effortKey) { spec.config = [{ file: '~/' + rel.split(path.sep).join('/'), modelKey: modelKey || undefined, effortKey: effortKey || undefined }]; break; }
  }
  // <ID>_HOME / <ID>_CONFIG_DIR（如 HERMES_HOME）指向的配置目录：v0 风格 config.yaml/json 里
  // 档位常嵌在 model 节内（model.default / model.reasoning_effort）。落成 $VAR 引用，画像机器无关。
  if (!spec.config) {
    const homeVar = [up + '_HOME', up + '_CONFIG_DIR'].find((n) => env[n] && String(env[n]).trim());
    if (homeVar) {
      const homeDir = String(env[homeVar]).trim();
      for (const name of ['config.yaml', 'config.yml', 'config.json']) {
        const file = path.join(homeDir, name);
        try { if (!fs.statSync(file).isFile()) continue; } catch { continue; }
        let modelKey = '', effortKey = '', effortSection = '';
        for (const k of ['default', 'name', ...MODEL_KEYS]) { try { if (readSectionKey(file, 'model', k)) { modelKey = k; break; } } catch { /* next */ } }
        // effort 不一定与 model 同节（hermes：model.default 在 model 节、reasoning_effort 在 agent 节）
        for (const sec of ['model', 'agent']) {
          if (effortKey) break;
          for (const k of ['reasoning_effort', ...EFFORT_KEYS]) { try { if (readSectionKey(file, sec, k)) { effortKey = k; effortSection = sec; break; } } catch { /* next */ } }
        }
        if (modelKey || effortKey) { spec.config = [{ file: '$' + homeVar + '/' + name, section: 'model', modelKey: modelKey || undefined, effortKey: effortKey || undefined, effortSection: effortSection && effortSection !== 'model' ? effortSection : undefined }]; break; }
      }
    }
  }
  return (spec.env || spec.effortEnv || spec.config) ? spec : null;
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

export async function adaptAgent({ id, cli, env = process.env, live = true, commit = true, suite = false, force = false, writeProfile = true, smoke = false } = {}) {
  const report = { id, cli: null, version: null, profile: null, live: null, smoke: null, committed: false, passed: false };
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
  const flagBoundary = (f) => new RegExp('(^|[\\s,|\\[\\]()])' + f.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '([\\s,|\\[\\]()]|$)', 'm');
  // 模型旗标的短别名（形如 "-m MODEL, --model MODEL"）：短别名绝不能被当作 prompt 旗标
  // 误取——否则提示词会被喂给 model 参数、CLI 掉进交互模式（无终端即崩），探活与单元双失败。
  const modelAlias = /(^|\n)\s*(-[A-Za-z])\s+[A-Z_.]+(?:\s*,\s*|\s{2,})--model\b/.exec(helpText)?.[2] || null;
  const promptFlag = PROMPT_FLAG_CANDIDATES.find((f) => f !== modelAlias && flagBoundary(f).test(helpText));
  if (!promptFlag) { report.reason = 'no one-shot prompt flag found (candidates: ' + PROMPT_FLAG_CANDIDATES.join(' ') + '); not a print-class CLI — needs a manual adapter'; return report; }
  const approve = APPROVE_CANDIDATES.filter((f) => flagBoundary(f).test(helpText));
  const model = flagBoundary('--model').test(helpText) ? ['--model'] : null;
  const effortFlag = ['--effort', '--reasoning', '--thinking'].find((f) => flagBoundary(f).test(helpText));
  const effort = effortFlag ? [effortFlag] : null;
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
    adaptedFrom: { cli: path.basename(located.source || located.bin), version, prefixArgs: prefixArgs.length ? prefixArgs : undefined },
  };
  const detection = discoverModelDetection(id, { env });
  if (detection) profile.modelDetection = detection;
  report.modelDetection = detection || null;
  report.profile = profile;

  const profileFile = path.join(profilesDir(env), id + '.json');
  const releaseFile = path.join(REPO, 'release.json');
  fs.mkdirSync(path.dirname(profileFile), { recursive: true });
  const prev = fs.existsSync(profileFile) ? fs.readFileSync(profileFile, 'utf8') : null;
  const prevRelease = fs.existsSync(releaseFile) ? fs.readFileSync(releaseFile, 'utf8') : null;
  const rollback = () => {
    const failures = [];
    try {
      if (prev === null) fs.rmSync(profileFile, { force: true }); else fs.writeFileSync(profileFile, prev, 'utf8');
    } catch (error) { failures.push('profile: ' + (error instanceof Error ? error.message : String(error))); }
    try {
      if (prevRelease === null) fs.rmSync(releaseFile, { force: true }); else fs.writeFileSync(releaseFile, prevRelease, 'utf8');
    } catch (error) { failures.push('release: ' + (error instanceof Error ? error.message : String(error))); }
    if (!failures.length) return true;
    report.rollbackError = failures.join('; ');
    report.reason = (report.reason ? report.reason + '; ' : '') + 'rollback failed: ' + report.rollbackError;
    return false;
  };
  try {
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

  if (smoke) {
    // 块级真实验收：用画像 agent 走一遍真实的 orch 单块执行（checkpoint 协议 + 验收契约），
    // 把"能接上"验证到"跑得通"。消耗该 agent 的真实额度，需其已登录。
    const os = await import('node:os');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-adapt-smoke-'));
    try {
      fs.writeFileSync(path.join(ws, 'acceptance.json'), JSON.stringify({ T001: [{ type: 'json', path: 'receipt.json', equals: { ok: true } }] }));
      const smokeEnv = {
        ...env, ORCH_AGENT: id, ORCH_CLI: located.source || located.bin, ORCH_AGENT_PROFILES_DIR: profilesDir(env),
        ORCH_ACCEPTANCE_FILE: path.join(ws, 'acceptance.json'), ORCH_MAINTENANCE_LOCK: path.join(ws, 'no-lock.json'),
        ORCH_MAX_POLL_MS: '300000', WORKSPACE_DIR: ws, ORCH_STATE_DIR: path.join(ws, 'temp', 'orchestrator'),
        // 一次性验收工作区：协调器必须留在本工作区，否则这次 smoke 会把机器级 HKCU 定位器钉到
        // 一个随后被删掉的临时目录上（真实用户的下一次运行就会对着死路径建协调器）。
        ORCH_COORDINATOR_DIR: path.join('temp', 'orchestrator', 'coordinator'),
        // 块级验收是非交互自动化：显式钉 headless，绝不继承本壳 ORCH_SPAWN_MODE（不弹窗、判据不随壳变色）。
        ORCH_SPAWN_MODE: 'headless',
      };
      delete smokeEnv.NODE_TEST_CONTEXT;
      const t0 = Date.now();
      const res = run(process.execPath, [path.join(REPO, 'orch.mjs'), '--run-id', 'adapt-smoke', '创建 receipt.json 内容为 {"ok":true} 并读回核验'], { env: smokeEnv, cwd: ws, timeout: 420000 });
      let success = false;
      try { success = JSON.parse(fs.readFileSync(path.join(ws, 'temp', 'orchestrator', 'runs', 'adapt-smoke', 'summary.json'), 'utf8')).success === true; } catch { /* no summary */ }
      report.smoke = { exit: res.status, ms: Date.now() - t0, success };
      if (!success) { report.reason = 'block-level smoke failed (exit=' + res.status + '); the CLI may need login/quota — rerun after configuring it'; rollback(); return report; }
    } finally {
      for (let i = 0; i < 5; i++) { try { fs.rmSync(ws, { recursive: true, force: true }); break; } catch { spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', ws], { windowsHide: true }); } }
    }
  }

  if (suite) {
    const s = run(process.execPath, ['--test', 'test/print-profile.test.mjs'], { cwd: REPO, env: { ...env, ORCH_AGENT: 'codex', ORCH_MAINTENANCE_LOCK: path.join(REPO, 'temp', 'adapt-suite-lock-none.json'), ORCH_SPAWN_MODE: 'headless' }, timeout: 300000 });
    report.suite = { exit: s.status };
    if (s.status !== 0) { report.reason = 'print-profile suite failed'; rollback(); return report; }
  }

  if (writeProfile && commit) {
    const maintenanceLock = acquireMaintenanceLock({ reason: 'auto-adapt ' + id, ttlMinutes: 30, env });
    try {
      const seal = run(process.execPath, [path.join(REPO, 'scripts', 'release-integrity.mjs'), '--seal'], { cwd: REPO, env });
      if (seal.status !== 0) {
        report.reason = 'reseal failed: ' + String(seal.stderr || '').slice(0, 200);
        rollback();
        const compensation = run(process.execPath, [path.join(REPO, 'scripts', 'release-integrity.mjs'), '--seal'], { cwd: REPO, env });
        report.rollbackResealExit = compensation.status;
        if (compensation.status !== 0) report.reason += '; rollback reseal failed: ' + String(compensation.stderr || '').slice(0, 200);
        return report;
      }
      const rel = path.relative(REPO, profileFile).split(path.sep).join('/');
      const add = run('git', ['add', '--', rel, 'release.json'], { cwd: REPO, env });
      report.gitAdd = add.status;
      if (add.status !== 0) { report.reason = 'git add failed: ' + String(add.stderr || add.stdout || add.error || add.status); rollback(); return report; }
      const commitResult = run('git', ['commit', '-m', 'feat(adapt): print-class profile for ' + id + ' (' + version + ') [auto-generated]', '--', rel, 'release.json'], { cwd: REPO, env });
      report.committed = commitResult.status === 0;
      if (!report.committed) { report.reason = 'git commit failed: ' + String(commitResult.stderr || commitResult.stdout || commitResult.error || commitResult.status); rollback(); return report; }
    } finally { releaseMaintenanceLock(env, maintenanceLock.ownerToken); }
  }

  report.passed = true;
  return report;
  } catch (error) {
    report.reason = 'adapt failed: ' + (error instanceof Error ? error.message : String(error));
    rollback();
    return report;
  }
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
