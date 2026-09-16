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
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';

const REPO = process.env.ORCH_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const ROOT = process.env.ORCH_L5_ROOT || 'D:/temp/orch-l5';
const WS = path.join(ROOT, 'ws');
const failMode = process.argv.includes('--no-resume-budget');
const runId = 'l5-drill-' + (failMode ? 'fail' : 'auto') + '-' + Date.now().toString(36);
const runDir = path.join(WS, 'temp', 'orchestrator', 'runs', runId);
const summaryFile = path.join(runDir, 'summary.json');
const guardianFile = path.join(runDir, 'guardian.json');
const GUARDIAN_LOG = path.join(runDir, 'guardian.log');
const barrier = path.join(ROOT, 'release');
const waiting = path.join(ROOT, 'waiting');

fs.rmSync(WS, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
for (const f of ['release', 'waiting', 'alpha.txt', 'beta.txt', 'unit-runs.json']) { try { fs.rmSync(path.join(ROOT, f), {force: true}); } catch {} }
fs.mkdirSync(path.join(WS), {recursive: true});

const coreHash = () => crypto.createHash('sha256')
  .update(fs.readdirSync(path.join(REPO, 'scripts', 'core')).filter((n) => /\.(mjs|ps1|txt)$/.test(n)).sort()
    .map((n) => n + ':' + crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, 'scripts', 'core', n))).digest('hex')).join('\n'))
  .digest('hex');
const hashBefore = coreHash();

// ---- unit：写产品文件、走检查点协议、B 块卡在屏障上（保证被杀时 run 仍在飞） ------------------
const unitMjs = path.join(ROOT, 'unit.mjs');
fs.writeFileSync(unitMjs, `
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const args = process.argv.slice(2);
const i = args.indexOf('--prompt-file');
const pf = i >= 0 ? args[i + 1] : args[args.length - 1];
const prompt = fs.readFileSync(pf, 'utf8');
const token = /【本块唯一标识】\\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(prompt)?.[1] || 'tok';
const cp = (h, f, id, s) => spawnSync(process.execPath, [h, f, id, s], {windowsHide: true});
for (const m of prompt.matchAll(/开始前：node "([^"]+)" "([^"]+)" (\\S+) started/g)) cp(m[1], m[2], m[3], 'started');
const counter = ${JSON.stringify(path.join(ROOT, 'unit-runs.json'))};
const runs = fs.existsSync(counter) ? JSON.parse(fs.readFileSync(counter, 'utf8')) : {};
const key = /alpha/.test(prompt) ? 'T001' : 'T002';
runs[key] = (runs[key] || 0) + 1;
fs.writeFileSync(counter, JSON.stringify(runs));
if (/alpha/.test(prompt)) fs.writeFileSync(${JSON.stringify(path.join(ROOT, 'alpha.txt'))}, 'ALPHA_OK\\n');
if (/beta/.test(prompt)) {
  fs.writeFileSync(${JSON.stringify(waiting)}, 'waiting');
  const until = Date.now() + 600000;
  while (!fs.existsSync(${JSON.stringify(barrier)})) { if (Date.now() > until) throw new Error('barrier timeout'); await new Promise(r => setTimeout(r, 200)); }
  fs.writeFileSync(${JSON.stringify(path.join(ROOT, 'beta.txt'))}, 'BETA_OK\\n');
}
console.log(JSON.stringify({unit: 'l5-probe', token, key}));
for (const m of prompt.matchAll(/完成自验后：node "([^"]+)" "([^"]+)" (\\S+) completed/g)) cp(m[1], m[2], m[3], 'completed');
console.log('__ORCH_DONE__ ' + token);
`);

const request = '在项目81创建文件 alpha.txt 内容 ALPHA_OK；在项目84创建文件 beta.txt 内容 BETA_OK';
fs.writeFileSync(path.join(ROOT, 'plan.json'), JSON.stringify({schema: 1, kind: 'tasks', tasks: [
  {id: 'T001', prompt: '在项目81创建文件 alpha.txt 内容 ALPHA_OK', summary: '在项目81创建文件 alpha.txt 内容 ALPHA_OK', kind: 'project', project: '81', conflict_hints: ['file:alpha.txt'], depends_on: []},
  {id: 'T002', prompt: '在项目84创建文件 beta.txt 内容 BETA_OK', summary: '在项目84创建文件 beta.txt 内容 BETA_OK', kind: 'project', project: '84', conflict_hints: ['file:beta.txt'], depends_on: []},
]}, null, 2), 'utf-8');
fs.writeFileSync(path.join(ROOT, 'unit.json'), JSON.stringify({schema: 1, id: 'l5-probe', label: 'L5 probe unit', bin: process.execPath.replaceAll('\\', '/'), args: [unitMjs.replaceAll('\\', '/'), '--prompt-file', '{promptFile}'], promptDelivery: 'file'}));
fs.writeFileSync(path.join(ROOT, 'acceptance.json'), JSON.stringify({
  T001: [{type: 'file', path: path.join(ROOT, 'alpha.txt').replaceAll('\\', '/')}],
  T002: [{type: 'file', path: path.join(ROOT, 'beta.txt').replaceAll('\\', '/')}],
}));

const env = {...process.env};
for (const key of ['WORKSPACE_DIR', 'ORCH_STATE_DIR', 'ORCH_TUI', 'ORCH_APPROVAL', 'ORCH_SANDBOX', 'NODE_TEST_CONTEXT']) delete env[key];
env.ORCH_GUARDIAN = '1';
// 收尾件②：非交互自动化一律显式 headless、零弹窗（不继承本壳 ORCH_SPAWN_MODE）；
// 需要可见窗口的手动调试才显式 ORCH_DRILL_WINDOW=1。
env.ORCH_SPAWN_MODE = process.env.ORCH_DRILL_WINDOW === '1' ? 'window' : 'headless';
if (failMode) { env.ORCH_GUARDIAN_MAX_RESTARTS = '1'; }

const read = () => { try { return JSON.parse(fs.readFileSync(summaryFile, 'utf8')); } catch { return null; } };
const readGuardian = () => { try { return JSON.parse(fs.readFileSync(guardianFile, 'utf8')); } catch { return null; } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, ms = 240000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await pause(500); } return false; };
const log = (...a) => console.log('[drill]', ...a);

log('runId =', runId, failMode ? '(让恢复失败模式：MAX_RESTARTS=1，两次杀控制器)' : '(自动接管模式：MAX_RESTARTS=默认 3)');
const child = spawn(NODE, [path.join(REPO, 'cli.mjs'), '--plan-file', path.join(ROOT, 'plan.json'), '--unit-cmd-file', path.join(ROOT, 'unit.json'),
  '--run-id', runId, '--acceptance-file', path.join(ROOT, 'acceptance.json'), '--run-windows', request],
  {cwd: WS, env, windowsHide: true});
let out = '';
for (const p of [child.stdout, child.stderr]) p.on('data', (b) => { out += b.toString(); });
const exited = new Promise((r) => child.on('exit', (c) => r(c)));

const report = {runId, mode: failMode ? 'no-resume-budget' : 'auto-resume', steps: {}, passed: false};
try {
  report.steps.ledger = await until(() => fs.existsSync(summaryFile) || child.exitCode !== null, 'ledger', 120000);
  report.steps.blockWaiting = await until(() => fs.existsSync(waiting), 'T002 waiting', 240000);
  report.steps.guardianArmed = await until(() => (readGuardian()?.guardianPid || 0) > 0, 'guardian armed', 30000);
  report.guardianPidBefore = readGuardian()?.guardianPid || null;
  const ownerPid = read()?.owner?.ProcessId || null;
  report.controllerPidFromLedger = ownerPid;
  report.generationBefore = read()?.generation ?? null;
  log('killing controller (ledger owner pid', ownerPid, ', child pid', child.pid, ')');
  let killedBy = 'child';
  if (ownerPid) { try { process.kill(ownerPid); killedBy = 'ledger-owner'; } catch (e) { killedBy = 'child-fallback:' + e.message; } }
  child.kill();
  report.killedBy = killedBy;
  await exited;
  await pause(1500);
  report.steps.killed = true;
  const restarted = await until(() => (readGuardian()?.restarts || 0) >= 1, 'guardian restart', failMode ? 25000 : 180000);
  report.steps.guardianRestarted = restarted;
  report.guardianAfterKill = readGuardian();
  if (failMode) {
    // 预算 = 1：第一次自动接管成功；等「接管的引擎」成为新 owner 后再把它杀掉 ⇒ 预算耗尽，
    // 必须**可见地**停止重拉（日志 + guardian.json），run 保持未收口，然后手动 --resume-run 收口。
    report.steps.resumedOwnerAppeared = await until(() => {
      const o = read()?.owner?.ProcessId;
      return !!o && o !== report.controllerPidFromLedger;
    }, 'resumed owner appears', 120000);
    await pause(4000);
    const owner2 = read()?.owner?.ProcessId || null;
    report.secondKill = {owner: owner2};
    if (owner2) { try { process.kill(owner2); report.secondKill.killed = true; } catch (e) { report.secondKill.error = String(e.message); } }
    await pause(45000);
    report.guardianAfterSecondKill = readGuardian();
    report.steps.budgetExhaustedNoSecondRestart = (readGuardian()?.restarts || 0) === 1;
    report.steps.stayedUnfinalized = !read()?.finishedAt;
    report.guardianLogTail = fs.existsSync(GUARDIAN_LOG) ? fs.readFileSync(GUARDIAN_LOG, 'utf8').split('\n').filter(Boolean).slice(-8) : [];
    // 收尾件①：手动收口必须重交同一份 --unit-cmd-file（与 ③ 红/绿口径一致），输出捕获入 report。
    const salvage = spawn(NODE, [path.join(REPO, 'cli.mjs'), '--resume-run', runId, '--unit-cmd-file', path.join(ROOT, 'unit.json')], {cwd: WS, env, windowsHide: true});
    let salvageOut = '';
    for (const p of [salvage.stdout, salvage.stderr]) p.on('data', (b) => { salvageOut += b.toString(); });
    await pause(3000);
    fs.writeFileSync(barrier, 'go');
    report.salvageExit = await Promise.race([new Promise((r) => salvage.on('exit', r)), pause(240000).then(() => 'timeout')]);
    report.steps.manualResumeFinalized = await until(() => !!read()?.finishedAt, 'manual resume finalize', 120000);
    report.salvageOutput = salvageOut.split('\n').filter(Boolean).slice(-20);
    report.summary = read();
    report.passed = report.steps.blockWaiting && report.steps.guardianArmed && report.steps.resumedOwnerAppeared
      && report.steps.budgetExhaustedNoSecondRestart && report.steps.stayedUnfinalized && report.steps.manualResumeFinalized
      && read()?.success === true;
  } else {
    fs.writeFileSync(barrier, 'go');
    report.steps.finalized = await until(() => !!read()?.finishedAt, 'finalize after auto-resume', 300000);
    report.steps.guardianStoodDown = await until(() => readGuardian()?.status === 'done', 'guardian done', 60000);
    report.summary = read();
    report.generationAfter = read()?.generation ?? null;
    report.resumedEngineLogs = fs.existsSync(runDir) ? fs.readdirSync(runDir).filter((n) => n.startsWith('resumed-engine-')) : [];
    report.unitRuns = fs.existsSync(path.join(ROOT, 'unit-runs.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'unit-runs.json'), 'utf8')) : {};
    report.coreUnchanged = coreHash() === hashBefore;
    report.passed = report.steps.blockWaiting && report.steps.guardianArmed && report.steps.guardianRestarted && report.steps.finalized
      && (report.summary?.success === true) && report.coreUnchanged;
  }
} catch (error) {
  report.error = String(error);
} finally {
  fs.writeFileSync(barrier, 'go');
  if (failMode && !read()?.finishedAt) {
    try {
      // 收尾件①补：salvage 未收口时兜底再收一次（同样重交 unit 命令），输出捕获入 report。
      const fin = spawnSync(NODE, [path.join(REPO, 'cli.mjs'), '--resume-run', runId, '--unit-cmd-file', path.join(ROOT, 'unit.json')], {cwd: WS, env, windowsHide: true, timeout: 240000, encoding: 'utf8'});
      report.finisherOutput = String((fin.stdout || '') + (fin.stderr || '')).split('\n').filter(Boolean).slice(-20);
    } catch {}
  }
  report.controllerOutputTail = out.split('\n').filter(Boolean).slice(-12);
  fs.writeFileSync(path.join(ROOT, failMode ? 'report-fail.json' : 'report-auto.json'), JSON.stringify(report, null, 2));
  console.log('[drill] passed =', report.passed, report.error ? 'error=' + report.error : '');
  console.log('[drill] report:', path.join(ROOT, failMode ? 'report-fail.json' : 'report-auto.json'));
  process.exitCode = report.passed ? 0 : 1;
}
