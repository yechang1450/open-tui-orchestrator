// L5 恢复演练（orch 报级用，零模型调用：caller-driven 通道）
// 两条腿：
//   ① 默认（自动接管）：控制器进程被杀 → 守护进程自动接管（restarts>=1）→ 跑完并收口；
//   ② --no-resume-budget（让恢复失败）：预算 1 → 杀掉接管的引擎 → 守护进程必须**可见地**停下
//      （guardian.json status=exhausted + 日志一行），run 保持未收口，再由手动 --resume-run 收口
//      （收口须重交同一份 --unit-cmd-file；salvage 输出入 report——2026-09-16 收尾件①）。
//   载体口径（2026-09-16 收尾件②）：两条腿显式 headless、零弹窗；可见窗手动调试用 ORCH_DRILL_WINDOW=1。
// 证据：<根目录>/report-auto.json 与 report-fail.json（含 steps 布尔逐条 + 账本/守护数据）。
// 用法: node tools/l5-recovery-drill.mjs [--no-resume-budget]
//   env: ORCH_REPO（默认=本仓）、ORCH_L5_ROOT（默认 D:/temp/orch-l5，不放义为临时目录）
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {assertNoSymlinkComponents, containedBy, realpathWithMissing} from '../scripts/core/path-security.mjs';

let processSnapshot;
let sameProcess;

const REPO = process.env.ORCH_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const log = (...a) => console.log('[drill]', ...a);
const cwdRoot = path.resolve(process.cwd());
const repoRoot = path.resolve(REPO);
const defaultWorkspace = process.env.ORCH_L5_WORKSPACE
  ? path.resolve(process.env.ORCH_L5_WORKSPACE)
  : path.resolve(REPO, '..', '..', 'workspace');
const defaultRoot = path.join(defaultWorkspace, 'temp', `orch-l5-${process.pid}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`);
const ROOT = path.resolve(process.env.ORCH_L5_ROOT || defaultRoot);
const rootBase = path.basename(ROOT).toLowerCase();
const failMode = process.argv.includes('--no-resume-budget');
const runId = 'l5-drill-' + (failMode ? 'fail' : 'auto') + '-' + Date.now().toString(36);
const ROOT_MARKER = path.join(ROOT, '.orch-l5-root');
const ROOT_MARKER_TEXT = 'open-tui-orchestrator l5 root v1\n';

const canonicalOrThrow = (label, target) => {
  const resolved = realpathWithMissing(target);
  if (!resolved) throw new Error(`${label} cannot be resolved safely: ${target}`);
  return resolved;
};
const containsEither = (left, right) => containedBy(left, right) || containedBy(right, left);
const assertNoSymlinkPath = target => {
  const components = [];
  let current = path.resolve(String(target));
  for (;;) {
    components.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const component of components) assertNoSymlinkComponents(component);
};

// Validate before touching ROOT. The path-security helper walks every existing
// ancestor, so this also rejects a junction above ROOT and a dangling link.
assertNoSymlinkComponents(ROOT);
const rootReal = canonicalOrThrow('ORCH_L5_ROOT', ROOT);
const repoReal = canonicalOrThrow('ORCH_REPO', repoRoot);
const cwdReal = canonicalOrThrow('current working directory', cwdRoot);
if (path.parse(ROOT).root === ROOT || !/^orch-l5[-_.][a-z0-9][a-z0-9_.-]*$/i.test(rootBase)) {
  throw new Error('ORCH_L5_ROOT must be a unique dedicated orch-l5-* directory');
}
if (containsEither(rootReal, repoReal) || containsEither(rootReal, cwdReal)) {
  throw new Error('ORCH_L5_ROOT must not contain or be contained by ORCH_REPO or the current working directory');
}

const ensureOwnedRoot = () => {
  if (fs.existsSync(ROOT)) {
    const stat = fs.lstatSync(ROOT);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('ORCH_L5_ROOT must be a real directory, not a symlink or junction');
    assertNoSymlinkPath(ROOT);
    let markerStat;
    try { markerStat = fs.lstatSync(ROOT_MARKER); } catch { markerStat = null; }
    if (!markerStat || !markerStat.isFile() || markerStat.isSymbolicLink() || fs.readFileSync(ROOT_MARKER, 'utf8') !== ROOT_MARKER_TEXT) {
      throw new Error('ORCH_L5_ROOT exists but is not owned by this L5 drill (missing or invalid .orch-l5-root marker)');
    }
  } else {
    fs.mkdirSync(ROOT, {recursive: true});
    assertNoSymlinkPath(ROOT);
    fs.writeFileSync(ROOT_MARKER, ROOT_MARKER_TEXT, {encoding: 'utf8', flag: 'wx'});
  }
};
ensureOwnedRoot();

const WS = path.join(ROOT, 'ws');
assertNoSymlinkPath(WS);
canonicalOrThrow('L5 workspace', WS);
if (fs.existsSync(WS)) {
  const wsStat = fs.lstatSync(WS);
  if (!wsStat.isDirectory() || wsStat.isSymbolicLink()) throw new Error('L5 workspace must be a real directory, not a symlink or junction');
}

// Keep path rejection independent from the PowerShell-backed process scanner.
// Invalid roots must fail before importing the runtime that needs PS7.
({processSnapshot, sameProcess} = await import('../scripts/core/leases.mjs'));

const runDir = path.join(WS, 'temp', 'orchestrator', 'runs', runId);
const summaryFile = path.join(runDir, 'summary.json');
const guardianFile = path.join(runDir, 'guardian.json');
const GUARDIAN_LOG = path.join(runDir, 'guardian.log');
// These are run-scoped workspace files. Never reuse ROOT/release or ROOT/waiting
// across runs: a stale barrier must not release a later unit.
const barrier = path.join(WS, `.l5-release-${runId}`);
const waiting = path.join(WS, `.l5-waiting-${runId}`);

try {
  fs.rmSync(WS, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
} catch (error) {
  throw new Error(`Cannot reset L5 workspace ${WS}; refusing to continue: ${error?.code || error?.message || error}`);
}
if (fs.existsSync(WS)) throw new Error(`Cannot reset L5 workspace ${WS}; it still exists after cleanup`);
fs.mkdirSync(WS, {recursive: true});
assertNoSymlinkPath(WS);

const coreHash = () => crypto.createHash('sha256')
  .update(fs.readdirSync(path.join(REPO, 'scripts', 'core')).filter((n) => /\.(mjs|ps1|txt)$/.test(n)).sort()
    .map((n) => n + ':' + crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, 'scripts', 'core', n))).digest('hex')).join('\n'))
  .digest('hex');
const hashBefore = coreHash();

// ---- unit：写产品文件、走检查点协议、B 块卡在屏障上（保证被杀时 run 仍在飞） ------------------
const unitMjs = path.join(ROOT, 'unit.mjs');
fs.writeFileSync(unitMjs, `
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const args = process.argv.slice(2);
const i = args.indexOf('--prompt-file');
const pf = i >= 0 ? args[i + 1] : args[args.length - 1];
const prompt = fs.readFileSync(pf, 'utf8');
const token = /【本块唯一标识】\\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(prompt)?.[1] || 'tok';
const runCheckpoint = command => {
 const text = String(command).trim();
 if (text.startsWith('\"')) {
  const end = text.indexOf('\"', 1);
  const file = end > 1 ? text.slice(1, end) : '';
  const args = end > 1 ? text.slice(end + 1).trim().split(' ').filter(Boolean) : [];
  if (/\.cmd$/i.test(file) && args.length === 2) {
    const commandLine = '\"' + file + '\" ' + args.join(' ');
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {windowsHide: true, windowsVerbatimArguments: true});
    if (result.error || result.status !== 0) throw new Error('checkpoint command failed: ' + (result.error?.message || 'exit ' + result.status));
    const checkpoint = path.join(path.dirname(file), 'checkpoints', args[0] + '.json');
    if (!fs.existsSync(checkpoint)) throw new Error('checkpoint command returned without writing ' + checkpoint);
    return result;
  }
 }
 throw new Error('unsupported checkpoint command in L5 fixture: ' + text);
};
for (const line of prompt.split(String.fromCharCode(10))) if (line.startsWith('开始前：')) runCheckpoint(line.slice('开始前：'.length));
const counter = ${JSON.stringify(path.join(WS, `.l5-unit-runs-${runId}.json`))};
const runs = fs.existsSync(counter) ? JSON.parse(fs.readFileSync(counter, 'utf8')) : {};
const key = /alpha/.test(prompt) ? 'T001' : 'T002';
runs[key] = (runs[key] || 0) + 1;
fs.writeFileSync(counter, JSON.stringify(runs));
if (/alpha/.test(prompt)) fs.writeFileSync(${JSON.stringify(path.join(WS, 'alpha.txt'))}, 'ALPHA_OK\\n');
if (/beta/.test(prompt)) {
  fs.writeFileSync(${JSON.stringify(waiting)}, 'waiting');
  const until = Date.now() + 600000;
  while (!fs.existsSync(${JSON.stringify(barrier)})) { if (Date.now() > until) throw new Error('barrier timeout'); await new Promise(r => setTimeout(r, 200)); }
  fs.writeFileSync(${JSON.stringify(path.join(WS, 'beta.txt'))}, 'BETA_OK\\n');
}
console.log(JSON.stringify({unit: 'l5-probe', token, key}));
for (const line of prompt.split(String.fromCharCode(10))) if (line.startsWith('完成自验后：')) runCheckpoint(line.slice('完成自验后：'.length));
console.log('__ORCH_DONE__ ' + token);
`);

const request = '在项目81创建文件 alpha.txt 内容 ALPHA_OK；在项目84创建文件 beta.txt 内容 BETA_OK';
fs.writeFileSync(path.join(ROOT, 'plan.json'), JSON.stringify({schema: 1, kind: 'tasks', tasks: [
  {id: 'T001', prompt: '在项目81创建文件 alpha.txt 内容 ALPHA_OK', summary: '在项目81创建文件 alpha.txt 内容 ALPHA_OK', kind: 'project', project: '81', conflict_hints: ['file:alpha.txt'], depends_on: []},
  {id: 'T002', prompt: '在项目84创建文件 beta.txt 内容 BETA_OK', summary: '在项目84创建文件 beta.txt 内容 BETA_OK', kind: 'project', project: '84', conflict_hints: ['file:beta.txt'], depends_on: []},
]}, null, 2), 'utf-8');
fs.writeFileSync(path.join(ROOT, 'unit.json'), JSON.stringify({schema: 1, id: 'l5-probe', label: 'L5 probe unit', bin: process.execPath.replaceAll('\\', '/'), args: [unitMjs.replaceAll('\\', '/'), '--prompt-file', '{promptFile}'], promptDelivery: 'file'}));
fs.writeFileSync(path.join(ROOT, 'acceptance.json'), JSON.stringify({
  T001: [{type: 'file', path: path.join(WS, 'alpha.txt').replaceAll('\\', '/')}],
  T002: [{type: 'file', path: path.join(WS, 'beta.txt').replaceAll('\\', '/')}],
}));

const env = {...process.env};
for (const key of ['WORKSPACE_DIR', 'ORCH_STATE_DIR', 'ORCH_TUI', 'ORCH_APPROVAL', 'ORCH_SANDBOX', 'NODE_TEST_CONTEXT']) delete env[key];
// L5 is an isolated drill: never inherit or consult the machine-wide HKCU
// coordinator locator, which may point at a deleted or unrelated run.
env.ORCH_COORDINATOR_DIR = path.join(WS, 'temp', 'orchestrator', 'coordinator');
env.ORCH_GUARDIAN = '1';
// 收尾件②：非交互自动化一律显式 headless、零弹窗（不继承本壳 ORCH_SPAWN_MODE）；
// 需要可见窗口的手动调试才显式 ORCH_DRILL_WINDOW=1。
env.ORCH_SPAWN_MODE = process.env.ORCH_DRILL_WINDOW === '1' ? 'window' : 'headless';
if (failMode) { env.ORCH_GUARDIAN_MAX_RESTARTS = '1'; }

const read = () => { try { return JSON.parse(fs.readFileSync(summaryFile, 'utf8')); } catch { return null; } };
const readGuardian = () => { try { return JSON.parse(fs.readFileSync(guardianFile, 'utf8')); } catch { return null; } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {runId, mode: failMode ? 'no-resume-budget' : 'auto-resume', steps: {}, passed: false, businessPassed: false};
const until = async (fn, label, ms = 240000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await pause(500);
  }
  report.error ||= `step timed out: ${label} (waited ${Math.round(ms / 1000)}s)`;
  console.log(`[drill] TIMEOUT waiting for ${label} after ${Math.round(ms / 1000)}s`);
  return false;
};
const snapshotAttempt = () => {
  try { return {snapshot: processSnapshot(), error: null}; }
  catch (error) { return {snapshot: null, error}; }
};
const requiredSnapshot = label => {
  const attempt = snapshotAttempt();
  if (attempt.error) throw new Error(`${label}: ${attempt.error?.message || attempt.error}`);
  return attempt.snapshot;
};
const captureIdentity = async (pid, label, ms = 20000) => {
  const end = Date.now() + ms;
  let lastError = null;
  while (Date.now() < end) {
    const attempt = snapshotAttempt();
    if (attempt.error) lastError = attempt.error;
    else {
      const identity = attempt.snapshot.get(Number(pid));
      if (identity) return identity;
    }
    await pause(250);
  }
  throw new Error(`${label} identity unavailable${lastError ? `: ${lastError.message || lastError}` : ''}`);
};
const waitForIdentityGone = async (owner, label, ms = 10000) => {
  const pid = Number(owner?.ProcessId);
  const end = Date.now() + ms;
  let lastError = null;
  while (Date.now() < end) {
    const attempt = snapshotAttempt();
    if (attempt.error) { lastError = attempt.error; await pause(250); continue; }
    const observed = attempt.snapshot.get(pid);
    if (!observed) return {state: 'gone'};
    if (!sameProcess(owner, observed)) return {state: 'mismatch', observed};
    await pause(200);
  }
  return lastError ? {state: 'unknown', error: lastError} : {state: 'alive'};
};
const killVerifiedTree = pid => {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) throw new Error('invalid verified pid');
  if (process.platform === 'win32') spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${String(pid)} /T /F`], {windowsHide: true, stdio: 'ignore'});
  else process.kill(Number(pid), 'SIGKILL');
};
const knownIdentities = [];
const rememberIdentity = (identity, label) => {
  if (!identity?.ProcessId || !identity?.Started || !identity?.Name || identity.CommandLine === undefined) return;
  if (!knownIdentities.some(item => item.identity.ProcessId === identity.ProcessId && item.identity.Started === identity.Started && item.label === label)) knownIdentities.push({identity, label});
};
const killOwned = async (owner, label) => {
  const pid = Number(owner?.ProcessId);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) throw new Error(`${label} pid is invalid or self`);
  const observed = requiredSnapshot(`${label} identity snapshot` ).get(pid);
  if (!observed) throw new Error(`${label} identity is unknown or already gone; refusing to guess`);
  if (!sameProcess(owner, observed)) throw new Error(`${label} identity mismatch`);
  rememberIdentity(owner, label);
  try { process.kill(pid); }
  catch (error) { throw new Error(`${label} kill failed: ${error?.message || error}`); }
  let outcome = await waitForIdentityGone(owner, label);
  if (outcome.state === 'gone') return {exited: true, escalated: false};
  if (outcome.state !== 'alive') throw new Error(`${label} did not exit safely (${outcome.state})`);
  const confirm = requiredSnapshot(`${label} escalation snapshot`).get(pid);
  if (!confirm || !sameProcess(owner, confirm)) throw new Error(`${label} identity changed before escalation`);
  killVerifiedTree(pid);
  outcome = await waitForIdentityGone(owner, label, 5000);
  if (outcome.state !== 'gone') throw new Error(`${label} remains ${outcome.state}; refusing further kill`);
  return {exited: true, escalated: true};
};
const runCommand = value => String(value || '').replaceAll('\\', '/').toLowerCase();
const liveRunProcesses = snapshot => {
  const live = [];
  for (const item of knownIdentities) {
    const observed = snapshot.get(Number(item.identity.ProcessId));
    if (!observed) continue;
    live.push({label: item.label, pid: Number(item.identity.ProcessId), identity: sameProcess(item.identity, observed) ? 'verified-live' : 'identity-mismatch', commandLine: observed.CommandLine});
  }
  const token = runId.toLowerCase();
  for (const observed of snapshot.values()) {
    const command = runCommand(observed.CommandLine);
    if (command.includes(token) && Number(observed.ProcessId) !== process.pid && !live.some(item => item.pid === Number(observed.ProcessId))) {
      live.push({label: 'run-id-process', pid: Number(observed.ProcessId), identity: 'run-id-matched', commandLine: observed.CommandLine});
    }
  }
  return live;
};
const rememberSummaryIdentities = () => {
  const sum = read();
  const visit = (value, label) => {
    if (!value || typeof value !== 'object') return;
    if (value.ProcessId && value.Started && value.Name && value.CommandLine !== undefined) rememberIdentity(value, label);
    if (value.owner) visit(value.owner, `${label}.owner`);
    if (value.launcher) visit(value.launcher, `${label}.launcher`);
    if (value.attempts) for (const attempt of value.attempts) visit(attempt, `${label}.attempt`);
  };
  visit(sum?.owner, 'summary.engine');
  for (const [key, value] of Object.entries(sum?.results || {})) visit(value, `result.${key}`);
};
const waitForQuiescent = async (label, ms = 30000, {ignoreTaskProcesses = false} = {}) => {
  const end = Date.now() + ms;
  let lastError = null;
  let lastLive = [];
  let ignored = [];
  const adoptableTaskProcess = item =>
    (item.identity === 'verified-live' && /^result\..*\.launcher$/i.test(String(item.label || '')))
    || (item.identity === 'run-id-matched' && /unit\.mjs\s+--prompt-file/i.test(String(item.commandLine || '')));
  while (Date.now() < end) {
    const attempt = snapshotAttempt();
    if (attempt.error) { lastError = attempt.error; await pause(300); continue; }
    rememberSummaryIdentities();
    const allLive = liveRunProcesses(attempt.snapshot);
    ignored = ignoreTaskProcesses ? allLive.filter(adoptableTaskProcess) : [];
    lastLive = ignoreTaskProcesses ? allLive.filter(item => !adoptableTaskProcess(item)) : allLive;
    if (!lastLive.length) return {passed: true, status: ignoreTaskProcesses ? 'clean-controllers' : 'clean', live: [], ignored};
    if (lastLive.some(item => item.identity === 'identity-mismatch')) return {passed: false, status: 'identity-mismatch', live: lastLive};
    await pause(500);
  }
  return {passed: false, status: lastError ? 'unknown' : 'live', live: lastLive, ignored, error: lastError?.message || null};
};
const guardianIdentity = () => {
  const record = readGuardian();
  if (!record?.guardianPid) return {state: 'missing'};
  const observed = requiredSnapshot('guardian identity snapshot').get(Number(record.guardianPid));
  if (!observed) return {state: 'gone'};
  const command = runCommand(observed.CommandLine);
  if (!command.includes('run-guardian.mjs') || !command.includes(runId.toLowerCase())) throw new Error('guardian identity mismatch');
  rememberIdentity(observed, 'guardian');
  return {state: 'alive', identity: observed};
};
const stopGuardian = async label => {
  const current = guardianIdentity();
  if (current.state !== 'alive') return {state: current.state};
  const result = await killOwned(current.identity, label);
  return {state: 'stopped', ...result};
};
const startResume = (label, resumeEnv) => {
  const proc = spawn(NODE, [path.join(REPO, 'cli.mjs'), '--resume-run', runId, '--unit-cmd-file', path.join(ROOT, 'unit.json')], {cwd: WS, env: resumeEnv, windowsHide: true});
  let output = '';
  for (const stream of [proc.stdout, proc.stderr]) stream.on('data', buffer => { output += buffer.toString(); });
  const done = new Promise(resolve => proc.on('exit', (code, signal) => resolve({code, signal})));
  return {label, proc, done, output: () => output, identity: null};
};

let child = null;
let childIdentity = null;
let exited = Promise.resolve(null);
let out = '';
let salvageChild = null;
let finisherChild = null;
try {
  // Probe the PS7-backed identity channel before spawning any child. A missing
  // snapshot is unknown, never evidence that a process is gone.
  requiredSnapshot('initial process identity snapshot');
  child = spawn(NODE, [path.join(REPO, 'cli.mjs'), '--plan-file', path.join(ROOT, 'plan.json'), '--unit-cmd-file', path.join(ROOT, 'unit.json'),
    '--run-id', runId, '--acceptance-file', path.join(ROOT, 'acceptance.json'), '--run-windows', request],
  {cwd: WS, env, windowsHide: true});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', buffer => { out += buffer.toString(); });
  exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({code, signal})));

  report.steps.ledger = await until(() => fs.existsSync(summaryFile) || child.exitCode !== null, 'ledger', 120000);
  if (child.exitCode === null) {
    childIdentity = await captureIdentity(child.pid, 'controller child');
    rememberIdentity(childIdentity, 'controller child');
    report.controllerChildIdentity = childIdentity;
  }
  report.steps.blockWaiting = await until(() => fs.existsSync(waiting), 'T002 waiting', 240000);
  report.steps.guardianArmed = await until(() => (readGuardian()?.guardianPid || 0) > 0, 'guardian armed', 30000);
  report.guardianPidBefore = readGuardian()?.guardianPid || null;
  const owner = read()?.owner || null;
  if (!owner?.ProcessId) throw new Error('run ledger has no controller owner identity');
  const ownerPid = Number(owner.ProcessId);
  report.controllerPidFromLedger = ownerPid;
  report.ownerIdentity = {ledger: owner, observed: null, matched: false};
  report.generationBefore = read()?.generation ?? null;
  log('killing controller (ledger owner pid', ownerPid, ', child pid', child.pid, ')');
  if (ownerPid === process.pid || ownerPid === Number(report.guardianPidBefore)) throw new Error('ledger owner is self or guardian; refusing to kill');
  const ownerObserved = requiredSnapshot('ledger owner identity snapshot').get(ownerPid);
  report.ownerIdentity.observed = ownerObserved || null;
  report.ownerIdentity.matched = !!ownerObserved && sameProcess(owner, ownerObserved);
  if (!report.ownerIdentity.matched) throw new Error('ledger owner identity mismatch; refusing controller kill');
  const firstKill = await killOwned(owner, 'ledger-owner');
  report.controllerExited = firstKill.exited;
  report.killedBy = firstKill.escalated ? 'ledger-owner-identity-verified-escalated' : 'ledger-owner-identity-verified';
  if (childIdentity) {
    const childGone = await waitForIdentityGone(childIdentity, 'controller child');
    if (childGone.state !== 'gone') throw new Error(`controller child did not exit safely (${childGone.state})`);
  }
  await Promise.race([exited, pause(10000)]);
  report.steps.killed = report.controllerExited === true;

  const restarted = await until(() => (readGuardian()?.restarts || 0) >= 1, 'guardian restart', failMode ? 25000 : 180000);
  report.steps.guardianRestarted = restarted;
  report.guardianAfterKill = readGuardian();
  if (failMode) {
    // Budget = 1: kill the adopted engine only after its current ledger identity
    // is re-read and matched. A stale PID is not a kill target.
    const resumedOwner = () => {
      const candidate = read()?.owner;
      if (!candidate?.ProcessId || Number(candidate.ProcessId) === ownerPid) return false;
      const attempt = snapshotAttempt();
      if (attempt.error) return false;
      const observed = attempt.snapshot.get(Number(candidate.ProcessId));
      return !!observed && sameProcess(candidate, observed);
    };
    report.steps.resumedOwnerAppeared = await until(resumedOwner, 'resumed owner appears', 120000);
    if (!report.steps.resumedOwnerAppeared) throw new Error('resumed owner identity was not proven');
    await pause(4000);
    const owner2 = read()?.owner || null;
    report.secondKill = {owner: owner2, identityMatched: false, killed: false};
    if (!owner2?.ProcessId) throw new Error('second owner is missing; refusing recovery kill');
    const owner2Observed = requiredSnapshot('second owner identity snapshot').get(Number(owner2.ProcessId));
    report.secondKill.observed = owner2Observed || null;
    report.secondKill.identityMatched = !!owner2Observed && sameProcess(owner2, owner2Observed);
    const guardian2Pid = Number(readGuardian()?.guardianPid || 0);
    if (Number(owner2.ProcessId) === process.pid || Number(owner2.ProcessId) === guardian2Pid) throw new Error('second owner is self or guardian');
    if (!report.secondKill.identityMatched) throw new Error('second owner identity mismatch; refusing second kill');
    const secondKill = await killOwned(owner2, 'second owner');
    report.secondKill.exited = secondKill.exited;
    report.secondKill.killed = secondKill.exited === true;
    report.steps.secondKillIdentityVerified = report.secondKill.killed;

    report.steps.budgetExhaustedNoSecondRestart = await until(() => {
      const guardian = readGuardian();
      return guardian?.restarts === 1 && guardian.status === 'exhausted';
    }, 'guardian exhausted', 60000);
    report.guardianAfterSecondKill = readGuardian();
    report.steps.stayedUnfinalized = !read()?.finishedAt;
    report.guardianLogTail = fs.existsSync(GUARDIAN_LOG) ? fs.readFileSync(GUARDIAN_LOG, 'utf8').split('\n').filter(Boolean).slice(-8) : [];

    // Stop an exhausted guardian before starting manual recovery. This is the
    // same serialization barrier used after a salvage timeout.
    const guardianStopped = await stopGuardian('guardian before manual resume');
    report.guardianBeforeSalvage = guardianStopped;
    // Surviving task windows/processes are the objects manual --resume-run must
    // adopt; only the old controller/guardian tree must be quiescent here.
    const beforeSalvage = await waitForQuiescent('before manual resume', 30000, {ignoreTaskProcesses: true});
    report.preSalvageQuiescent = beforeSalvage;
    if (!beforeSalvage.passed) throw new Error(`old recovery tree is not quiescent before salvage: ${JSON.stringify(beforeSalvage)}`);

    // 收尾件①：manual recovery reuses the same unit command file, but disables
    // a second guardian so only one resume owner can exist.
    const resumeEnv = {...env, ORCH_GUARDIAN: '0'};
    salvageChild = startResume('salvage', resumeEnv);
    salvageChild.identity = await captureIdentity(salvageChild.proc.pid, 'salvage controller');
    rememberIdentity(salvageChild.identity, 'salvage controller');
    await pause(3000);
    fs.writeFileSync(barrier, 'go');
    const salvageTimeoutMs = Math.max(1000, Number(process.env.ORCH_L5_SALVAGE_TIMEOUT_MS) || 240000);
    let salvageOutcome = await Promise.race([
      salvageChild.done.then(value => ({...value, timedOut: false})),
      pause(salvageTimeoutMs).then(() => ({timedOut: true, code: null, signal: null})),
    ]);
    report.salvageExit = salvageOutcome.timedOut ? 'timeout' : salvageOutcome.code;
    report.salvageOutput = salvageChild.output().split('\n').filter(Boolean).slice(-20);
    if (salvageOutcome.timedOut) {
      report.steps.salvageTimedOut = true;
      const stopped = await killOwned(salvageChild.identity, 'salvage timeout');
      report.salvageStoppedBeforeFinisher = stopped.exited === true;
      const preFinisher = await waitForQuiescent('before finisher', 30000);
      report.preFinisherQuiescent = preFinisher;
      if (!preFinisher.passed) throw new Error(`finisher blocked until old recovery tree stops: ${JSON.stringify(preFinisher)}`);
      finisherChild = startResume('finisher', resumeEnv);
      finisherChild.identity = await captureIdentity(finisherChild.proc.pid, 'finisher controller');
      rememberIdentity(finisherChild.identity, 'finisher controller');
      const finisherOutcome = await Promise.race([
        finisherChild.done.then(value => ({...value, timedOut: false})),
        pause(240000).then(() => ({timedOut: true, code: null, signal: null})),
      ]);
      report.finisherExit = finisherOutcome.timedOut ? 'timeout' : finisherOutcome.code;
      report.finisherOutput = finisherChild.output().split('\n').filter(Boolean).slice(-20);
      if (finisherOutcome.timedOut) throw new Error('finisher timed out after salvage was stopped');
    }
    report.steps.manualResumeFinalized = await until(() => !!read()?.finishedAt, 'manual resume finalize', 120000);
    report.summary = read();
    report.guardian = readGuardian();
    report.coreUnchanged = coreHash() === hashBefore;
    report.businessPassed = report.steps.blockWaiting && report.steps.guardianArmed && report.steps.guardianRestarted
      && report.steps.resumedOwnerAppeared && report.steps.secondKillIdentityVerified
      && report.steps.budgetExhaustedNoSecondRestart && report.steps.stayedUnfinalized
      && report.steps.manualResumeFinalized && report.summary?.success === true && report.coreUnchanged;
  } else {
    fs.writeFileSync(barrier, 'go');
    report.steps.finalized = await until(() => !!read()?.finishedAt, 'finalize after auto-resume', 300000);
    report.steps.guardianStoodDown = await until(() => readGuardian()?.status === 'done', 'guardian done', 60000);
    report.summary = read();
    report.guardian = readGuardian();
    report.generationAfter = report.summary?.generation ?? null;
    report.resumedEngineLogs = fs.existsSync(runDir) ? fs.readdirSync(runDir).filter(name => name.startsWith('resumed-engine-')) : [];
    const counter = path.join(WS, `.l5-unit-runs-${runId}.json`);
    report.unitRuns = fs.existsSync(counter) ? JSON.parse(fs.readFileSync(counter, 'utf8')) : {};
    report.coreUnchanged = coreHash() === hashBefore;
    report.businessPassed = report.steps.blockWaiting && report.steps.guardianArmed && report.steps.guardianRestarted
      && report.steps.finalized && report.steps.guardianStoodDown && report.summary?.success === true && report.coreUnchanged;
  }
} catch (error) {
  report.error = String(error);
} finally {
  try { if (fs.existsSync(WS)) fs.writeFileSync(barrier, 'go'); } catch (error) { report.barrierWriteError = String(error?.message || error); }

  const cleanup = [];
  const addCleanup = (label, value) => cleanup.push({label, ...value});
  const stopRecord = async (record, label) => {
    if (!record?.proc) return {state: 'missing'};
    if (record.proc.exitCode !== null) return {state: 'already-exited', exitCode: record.proc.exitCode};
    if (!record.identity) return {state: 'identity-unknown', pid: record.proc.pid};
    const result = await killOwned(record.identity, label);
    return {state: 'stopped', pid: record.proc.pid, ...result};
  };
  const stopIdentity = async (identity, label) => {
    if (!identity?.ProcessId) return {state: 'missing'};
    const snapshot = requiredSnapshot(`${label} cleanup snapshot`);
    const observed = snapshot.get(Number(identity.ProcessId));
    if (!observed) return {state: 'already-gone'};
    if (!sameProcess(identity, observed)) return {state: 'identity-mismatch', pid: Number(identity.ProcessId)};
    return {state: 'stopped', ...(await killOwned(identity, label)), pid: Number(identity.ProcessId)};
  };

  let quiescent = await waitForQuiescent('final process closure', 30000);
  report.orphanCheck = quiescent;
  if (!quiescent.passed) report.businessPassed = false;

  if (!report.businessPassed) {
    // Guardian first: killing the engine first can make it launch a replacement.
    try {
      const guardian = await stopGuardian('guardian cleanup');
      addCleanup('guardian', guardian);
      if (guardian.state === 'alive') addCleanup('cleanup-order', {state: 'guardian-not-stopped; engine cleanup skipped'});
    } catch (error) {
      addCleanup('guardian', {state: 'identity-unknown', error: String(error?.message || error)});
    }
    const guardianBlocked = cleanup.some(item => item.label === 'guardian' && item.state === 'identity-unknown');
    if (!guardianBlocked) {
      try { addCleanup('salvage', await stopRecord(salvageChild, 'salvage cleanup')); } catch (error) { addCleanup('salvage', {state: 'error', error: String(error?.message || error)}); }
      try { addCleanup('finisher', await stopRecord(finisherChild, 'finisher cleanup')); } catch (error) { addCleanup('finisher', {state: 'error', error: String(error?.message || error)}); }
      try { addCleanup('controller', await stopIdentity(childIdentity, 'controller cleanup')); } catch (error) { addCleanup('controller', {state: 'error', error: String(error?.message || error)}); }
      rememberSummaryIdentities();
      const sum = read();
      const engine = sum?.owner;
      if (engine?.ProcessId) {
        try { addCleanup('engine', await stopIdentity(engine, 'engine cleanup')); } catch (error) { addCleanup('engine', {state: 'error', error: String(error?.message || error)}); }
      }
      for (const [key, value] of Object.entries(sum?.results || {})) {
        const launcher = value?.launcher;
        if (!launcher?.ProcessId) continue;
        try { addCleanup(`launcher:${key}`, await stopIdentity(launcher, `launcher cleanup ${key}`)); } catch (error) { addCleanup(`launcher:${key}`, {state: 'error', error: String(error?.message || error)}); }
      }
    }
  }

  quiescent = await waitForQuiescent('post-cleanup process closure', 15000);
  report.orphanCheckAfterCleanup = quiescent;
  report.cleanup = cleanup;
  report.summary = read() || report.summary || null;
  report.guardian = readGuardian() || report.guardian || null;
  report.crossRead = {summaryJson: !!report.summary, guardianJson: !!report.guardian, summarySuccess: report.summary?.success === true};
  report.passed = report.businessPassed === true && report.orphanCheck?.passed === true && report.orphanCheckAfterCleanup?.passed === true;
  report.controllerOutputTail = out.split('\n').filter(Boolean).slice(-12);

  // Revalidate the owned root before writing the report; a path swap is not a
  // reason to follow a new target or to claim that cleanup was complete.
  assertNoSymlinkPath(ROOT);
  const finalRoot = fs.lstatSync(ROOT);
  const finalMarker = fs.lstatSync(ROOT_MARKER);
  if (!finalRoot.isDirectory() || finalRoot.isSymbolicLink() || !finalMarker.isFile() || finalMarker.isSymbolicLink() || fs.readFileSync(ROOT_MARKER, 'utf8') !== ROOT_MARKER_TEXT) {
    throw new Error('L5 root changed ownership before report write');
  }
  const reportPath = path.join(ROOT, failMode ? 'report-fail.json' : 'report-auto.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log('[drill] passed =', report.passed, report.error ? 'error=' + report.error : '');
  console.log('[drill] report:', reportPath);
  process.exit(report.passed ? 0 : 1);
}
