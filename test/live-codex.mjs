// Opt-in real Codex TUI acceptance test; consumes the configured model's quota.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { powershellExe } from '../scripts/core/contracts.mjs';
import { processSnapshot, sameProcess } from '../scripts/core/leases.mjs';
import { readJsonDiagnostic, captureProcessIdentity, inspectProcess, collectOwnedProcessTargets, shutdownWindowTargets, parentProcessMap, pidsUnder, codexFailureReasons, finalizeCodexReport, ninthOrderedAfterAFreedSlot } from './live-safety.mjs';

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = process.cwd();
const agent=process.env.ORCH_LIVE_AGENT||'codex';
const coreFiles=fs.readdirSync(path.join(repo,'scripts','core')).filter(n=>/\.(mjs|ps1|txt)$/.test(n)).sort();
const coreHash=()=>crypto.createHash('sha256').update(coreFiles.map(n=>n+':'+crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,'scripts','core',n))).digest('hex')).join('\n')).digest('hex');
const coreHashAtLaunch=coreHash();
const parent = path.join(workspace, 'temp');
const name = (agent==='pi'?'pi-live-':'open-live-') + crypto.randomUUID().replace(/[^a-z]/g, '');
const root = path.join(parent, name);
const nonce = crypto.randomUUID();
const runId='acceptance-'+nonce;
const summaryFile=path.join(workspace,'temp','orchestrator','runs',runId,'summary.json');
const acceptanceFile=path.join(root,'acceptance.json');
// This is the documented 9-task / 8-window acceptance contract.  Do not derive
// the barrier from host RAM: a larger machine would wait forever for a ninth
// live unit while a smaller one could never satisfy the fixed assertions below.
const capacity = 8;
const children = [];
let engine = null;
let poll = null;
let report = null;
let peak = 0;
const samples = [];
const samplingErrors = new Map();
const jsonDiagnostics = [];
const noteSamplingError = (stage, error) => {
  const message = String(error?.message || error);
  const key = stage + ': ' + message;
  const current = samplingErrors.get(key) || {stage, message, count: 0, firstAt: Date.now(), lastAt: 0};
  current.count += 1;
  current.lastAt = Date.now();
  samplingErrors.set(key, current);
};
const noteJsonDiagnostic = result => { if (!result.ok && result.kind !== 'missing') jsonDiagnostics.push(result.message); };
const killTree = pid => {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return;
  if (process.platform === 'win32') spawnSync(process.env.ComSpec || 'cmd.exe', ['/d','/s','/c','taskkill /PID '+String(pid)+' /T /F'], {windowsHide:true,stdio:'ignore'});
  else { try { process.kill(Number(pid),'SIGKILL'); } catch {} }
};
const terminateVerified = async run => {
  if (!run) return {state:'missing'};
  const captured=run.identity||((await run.identityPromise)||{}).identity;
  if (!captured) return {state:run.identityState?.state||'unknown',reason:run.identityState?.reason||'process identity unavailable'};
  const current=inspectProcess(captured,()=>processSnapshot());
  if (current.state!=='live') return {state:current.state,reason:current.reason};
  killTree(current.pid);
  return {state:'kill-requested',pid:current.pid};
};
// 窗口收尾（2026-10-11）：温柔关失败时，把 launcher 的窗口句柄找出来发 WM_CLOSE。
// 句柄路由：窗口注册表条目（本 run）pid → pidFile 的 basename → `win-<stem>.window.json`
// （由窗口确认机制写过 hwnd）。找不到就返回 null，交给下一层兜底。
const windowHandleFor = pid => {
  try {
    const registry=readJsonDiagnostic(path.join(workspace,'temp','orchestrator','orchestrator-windows.json'),{label:'orchestrator-windows.json'});
    if(!registry.ok||!Array.isArray(registry.value))return null;
    const entry=registry.value.find(w=>Number(w?.pid)===Number(pid)&&(!w?.runId||w.runId===runId));
    if(!entry?.pidFile)return null;
    const stem=path.basename(String(entry.pidFile)).replace(/^window-/,'').replace(/\.pid$/,'');
    const record=readJsonDiagnostic(path.join(workspace,'temp','win-'+stem+'.window.json'),{label:'window record'});
    return record.ok&&record.value?.hwnd?String(record.value.hwnd):null;
  } catch { return null; }
};
try {
if (process.platform !== 'win32') throw new Error('This acceptance scenario requires Windows');
fs.mkdirSync(root, { recursive: true });
// Deadline is tunable (2026-10-06): the fixed 970s window misreported agent speed as failure --
// hermes units need ~11-13 min each, so correct output landed only seconds after the hardcoded
// deadline and was reported unproven. The engine's own ORCH_MAX_POLL_MS scales with the same knob:
// raising only the harness window left the engine cutting units off at its own fixed 15 min.
// Same class as the other budget fixes: only the budget is configurable, the verdict stays fail-closed.
//
// 2026-10-09: default raised 970s -> 1800s. The release barrier needs eight units CONVENED (all
// past their first checkpoint, probes parked on the release file). Measured codex startups spread
// 4-18 minutes, so a 16-minute window closes before the slowest unit can join while every earlier
// probe's wait expires first, its window dies, and the barrier can never be satisfied (0 of 310
// samples in the round that measured it). 1800s covers the measured spread with margin; nothing
// in the verdict below changes - this is the budget that lets the measurement happen at all.
const liveDeadlineMs = Math.max(300000, Number(process.env.ORCH_LIVE_DEADLINE_MS) || 1800000);
const liveDeadlineAt = Date.now() + liveDeadlineMs;
// The harness verifies that the engine holds EXACTLY `capacity` windows in parallel and queues the
// rest, so the cap has to be handed to the engine: without ORCH_MAX_WINDOWS the engine picks its own
// capacity from memory-fit (measured: 9 against a hardcoded 8), and then `live.length === capacity`
// can never hold while `live.length > capacity` throws 'Capacity exceeded' - the release barrier is
// never written and every probe dies on its own timeout.
const env = { ...process.env, ORCH_AGENT: agent, ORCH_SPAWN_MODE: 'window', ORCH_MAX_POLL_MS: String(Math.max(60000, liveDeadlineMs - 70000)), ORCH_MAX_WINDOWS: String(capacity), ORCH_WINDOW_CONFIRM_MS: String(Math.max(60000, Number(process.env.ORCH_WINDOW_CONFIRM_MS) || 90000)), // First-checkpoint budget (2026-10-09 update): the engine's default is 1200s today, raised from
// 300s because measured codex startups need 4-18 minutes to their first checkpoint. The harness
// pins the same value explicitly. An earlier note here recorded the OPPOSITE for a hermes run
// (retiring at 300s produced 9/9 where a 900s watchdog produced 4/9); both datums are kept rather
// than dropped - the current value is the codex-appropriate one, and the hermes re-run measures
// the trade-off instead of guessing at it.
ORCH_UNIT_FIRST_CHECKPOINT_MS: String(Math.max(1200000, Number(process.env.ORCH_UNIT_FIRST_CHECKPOINT_MS) || 1200000)), // Process-snapshot budget (2026-10-10): with eight live TUI windows the engine's own 15s snapshot default stretched to 15.5s on the hermes round and failed the ninth block's queue-time identity verification with "Cannot verify process identities... raise ORCH_PS_TIMEOUT_MS". Same class as the other budget knobs: the fixture widens the timeout, the verdict is untouched.
ORCH_PS_TIMEOUT_MS: String(Math.max(60000, Number(process.env.ORCH_PS_TIMEOUT_MS) || 60000)), // Unit stall budget (2026-10-10): the fixture units legitimately park in the "rerun the probe until exit 0" loop while waiting for the release barrier, and the parked window logs stop advancing - the engine's 600s production stall default then reaps units that are merely waiting (measured: two of nine units killed ~635s in, after their barriered peers finished 90-180s earlier). The production default stays; the fixture widens the budget for its own wait pattern, same as the other budget knobs on this line.
ORCH_UNIT_STALL_MS: String(Math.max(1500000, Number(process.env.ORCH_UNIT_STALL_MS) || 1500000)), ORCH_RUN_ID:runId, ORCH_ACCEPTANCE_FILE:acceptanceFile };
for (const key of ['WORKSPACE_DIR', 'ORCH_STATE_DIR', 'ORCH_TUI', 'ORCH_SANDBOX', 'ORCH_APPROVAL']) delete env[key];
const config = { nonce, workspace, ids: Array.from({ length: 9 }, (_, i) => String(91 + i)), capacity, deadlineAt: liveDeadlineAt };
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
fs.writeFileSync(acceptanceFile,JSON.stringify(Object.fromEntries(config.ids.map((id,i)=>['T'+String(i+1).padStart(3,'0'),[{type:'json',path:path.join(root,'project-'+id,'result'+id+'.json'),equals:{id,nonce,cwd:workspace,sum:50005000}}]])),null,2));
const probe = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const id = process.argv[2];
assert.ok(config.ids.includes(id));
const out = path.join(root, 'project-' + id);
fs.mkdirSync(out, { recursive: true });
assert.equal(process.cwd(), config.workspace);
// Preserve the EARLIEST attempt timestamp across re-runs: the unit re-executes this probe (exit 3 =
// not released yet) and may even add a redundant run after success. A late re-run must not move the
// task's start marker past the finish of its siblings - the overlap criterion compares [started,
// finished] spans across the first eight tasks.
let started = Date.now();
const attemptStart = started;
try {
  const prev = JSON.parse(fs.readFileSync(path.join(out, 'started.json'), 'utf8'));
  if (Number.isFinite(prev?.started)) started = Math.min(started, Number(prev.started));
} catch { /* first attempt */ }
fs.writeFileSync(path.join(out, 'started.json'), JSON.stringify({id, nonce:config.nonce, pid:process.pid, started}));
const waitBudget = Math.max(600000, Number(config.deadlineAt || 0) - attemptStart);
while (!fs.existsSync(path.join(root, 'release')) && id !== config.ids.at(-1)) {
  if (Date.now() - attemptStart > waitBudget) { console.error('[probe] not released within ' + Math.round(waitBudget/1000) + 's; exiting 3 so the unit re-runs it (and can check in the other tasks of a merged window) while keeping the window held'); process.exit(3); }
  await new Promise(r => setTimeout(r, 500));
}
await new Promise(r => setTimeout(r, 15000));
assert.equal(process.cwd(), config.workspace);
const value = {id, cwd:process.cwd(), nonce:config.nonce, pid:process.pid, started, finished:Date.now(), sum:Array.from({length:10000},(_,i)=>i+1).reduce((a,b)=>a+b,0)};
assert.equal(value.sum,50005000);
const file = path.join(out,'result' + id + '.json');
fs.writeFileSync(file,JSON.stringify(value));
assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),value);
console.log(JSON.stringify(value));
`;
for (const id of config.ids) {
  fs.mkdirSync(path.join(root, 'project-' + id));
  fs.writeFileSync(path.join(root, 'project-' + id, 'probe' + id + '.mjs'), probe);
}
// Checkpoint FIRST, then the blocking probe. The probe waits for the release barrier, and the engine
// retires a unit that has not recorded its first checkpoint within 300s - so asking for the probe
// first deadlocks the two: probes wait for the barrier, the barrier waits for eight probes, and the
// engine keeps retiring the units that never got to checkpoint (measured: 7 of 9 blocks unproductive).
// The segment count and the ； separators are part of the request-splitting contract - keep both.
const request = config.ids.map(id => `项目${id}：先按主持提供的命令逐项记录检查点，再反复执行 node ${root.replaceAll('\\', '/')}/project-${id}/probe${id}.mjs ${id} 直到它退出码 0 才继续（退出码 3 表示尚未放行 立即重跑 不要停止 不要判定失败），随后读回 ${root.replaceAll('\\', '/')}/project-${id}/result${id}.json 核验成功，禁止另开窗口禁止提交或写记忆`).join('；');
fs.writeFileSync(path.join(root, 'request.txt'), request, 'utf8');
console.log(JSON.stringify({ root, capacity, tasks: 9, nonce }));
function launch(script, args, label) {
  const entry = label === 'engine' ? (process.env.ORCH_LIVE_ENTRY||path.join(repo, 'cli.mjs')) : path.join(repo, 'scripts', script);
  const forwarded = label === 'engine' && !process.env.ORCH_LIVE_ENTRY ? ['--agent', agent, ...args] : args;
  const child = spawn(process.execPath, [entry, ...forwarded], { cwd: workspace, env, windowsHide: true });
  let output = '';
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', data => {
    const text = data.toString(); output += text;
    process.stdout.write('[' + label + '] ' + text);
  });
  const done = new Promise(resolve => {
    child.on('error', e => resolve({ code: -1, error: String(e) }));
    child.on('exit', code => resolve({ code }));
  });
  const run={child,done,output:()=>output,label,identity:null,identityState:null};
  run.identityPromise=captureProcessIdentity(child.pid,{snapshot:processSnapshot,isStopped:()=>child.exitCode!==null,timeoutMs:30000});
  run.identityPromise.then(result=>{run.identityState=result;if(result.state==='live')run.identity=result.identity;}).catch(error=>{run.identityState={state:'unknown',reason:String(error)};});
  children.push(run);
  return run;
}
engine = launch('orchestrate-sdk.mjs', ['--run-windows', request], 'engine');
const startupDeadline = Date.now() + 60000;
while (engine.child.exitCode === null && !/spawned visible/.test(engine.output()) && Date.now() < startupDeadline) await new Promise(r => setTimeout(r, 500));
poll = launch('poll-windows.mjs', ['--require-all-success', '--timeoutMs', String(liveDeadlineMs - 10000), '--intervalMs', '5000'], 'poll');
let engineEnded = false;
let engineDied = false;
engine.done.then(() => {
  engineDied = true;
  // The initiator engine dying is not necessarily the end of the run: the product's
  // run guardian resumes it with a successor generation that adopts every live window
  // (observed 2026-10-10: gen1 died ~27 min in, gen2 adopted all eight windows and
  // finalized). Keep the sampler (and its release-barrier duty) alive until a
  // successor finalizes; the loop stays bounded by the live deadline either way.
  // Only when the summary already exists is this a normal, completed exit.
  engineEnded = fs.existsSync(summaryFile);
});
const deadline = liveDeadlineAt;
// 每窗口的连续"无法核对"计数：注册表写入与进程快照存在已知竞态（含弹窗前 pending 占位、启动重试交接），
// 单点抖动不判失败；同一窗口连续 ≥3 个采样都无法核对才记 measurement error（保持 fail-closed）。
const unverifiedWindows = new Map();
while (!engineEnded && Date.now() < deadline) {
  try {
    // 单次 pwsh 调用失败是瞬态（高负载下实测 1/≈600）；重试一次再谈失败，持久失败仍然 fail-closed。
    const snapshot = await (async () => { let last; for (let attempt = 0; attempt < 2; attempt++) { try { return await exec(powershellExe(), ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n="Started";e={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 15000 }); } catch (e) { last = e; await new Promise(r => setTimeout(r, 1000)); } } throw last; })();
    const { stdout } = snapshot;
    const decoded = JSON.parse(stdout);
    const processes = Array.isArray(decoded) ? decoded : (decoded && typeof decoded === 'object' ? [decoded] : null);
    if (!processes) throw new Error('process snapshot was neither an object nor an array');
    const byPid = new Map(processes.map(p => [p.ProcessId, p]));
    const registry = path.join(workspace, 'temp', 'orchestrator', 'orchestrator-windows.json');
    const windows = fs.existsSync(registry) ? JSON.parse(fs.readFileSync(registry, 'utf8')) : [];
    const own = windows.filter(w => w.runId===runId);
    const live = [];
    for (const w of own) {
      const title = String(w.title || w.runId || 'window');
      // 弹窗前预算占位（pending=true, pid=0）：正常中间态，既不算活体也不是测量错误。
      if (w.pending === true) { unverifiedWindows.delete(title); continue; }
      const miss = reason => {
        const n = (unverifiedWindows.get(title) || 0) + 1;
        unverifiedWindows.set(title, n);
        if (n >= 3) noteSamplingError('window-identity', reason + ' for ' + title);
      };
      if (!w.identity) {
        miss('missing launcher identity');
        continue;
      }
      let pid = Number(w.pid);
      if (fs.existsSync(w.pidFile)) pid = Number(fs.readFileSync(w.pidFile, 'utf8').replace(/^\uFEFF/, '').trim());
      if (!Number.isInteger(pid) || pid < 1) {
        miss('invalid launcher pid');
        continue;
      }
      const launcher=byPid.get(pid);
      if (!launcher) continue;
      if (!sameProcess(w.identity,launcher)) {
        miss('launcher identity mismatch');
        continue;
      }
      unverifiedWindows.delete(title);
      const descendants = processes.filter(p => {
        let q = p; const visited = new Set();
        while (q && !visited.has(q.ProcessId)) {
          visited.add(q.ProcessId);
          if (q.ParentProcessId === pid) return true;
          q = byPid.get(q.ParentProcessId);
        }
        return false;
      });
      const agents = descendants.filter(p => agent==='pi'?(/^pi(?:\.exe)?$/i.test(p.Name)||(/^node(?:\.exe)?$/i.test(p.Name)&&/pi-coding-agent.*cli\.js/i.test(p.CommandLine||''))):agent==='hermes'?/^hermes(?:\.exe)?$/i.test(p.Name):agent==='opencode'?/^opencode(?:\.exe)?$/i.test(p.Name):agent==='kimi'?(/^kimi(?:\.exe)?$/i.test(p.Name)||(/^node(?:\.exe)?$/i.test(p.Name)&&/kimi/i.test(p.CommandLine||''))):agent==='claude'?/^claude(?:\.exe)?$/i.test(p.Name):/^codex(?:\.exe)?$/i.test(p.Name));
      if (agents.length) live.push({ title: w.title, launcherPid: pid, launcherParentPid: launcher.ParentProcessId, agentPids: agents.map(p => p.ProcessId) });
    }
    const ready = config.ids.filter(id => fs.existsSync(path.join(root, 'project-' + id, 'started.json')));
    const sample = { at: Date.now(), live, ready };
    samples.push(sample);
    try { fs.appendFileSync(path.join(root, 'samples.jsonl'), JSON.stringify(sample) + '\n'); } catch { /* best-effort post-mortem trail */ }
    if (live.length > peak) { peak = live.length; console.log('[measure] peak=' + peak + ' ready=' + ready.length); }
    if (live.length === capacity && config.ids.slice(0, capacity).every(id => ready.includes(id)) && !fs.existsSync(path.join(root, 'release'))) {
      fs.writeFileSync(path.join(root, 'release'), String(Date.now()));
      console.log('[measure] verified eight live '+agent+' descendants and eight running probes; barrier released');
    }
    if (live.length > capacity) throw new Error('Capacity exceeded');
  } catch (e) {
    noteSamplingError('sample', e);
    console.error('[measure] sampling incomplete: ' + String(e));
  }
  // Guardian-resumed generation: stop as soon as the successor finalizes the summary.
  if (engineDied && fs.existsSync(summaryFile)) { engineEnded = true; break; }
  await new Promise(r => setTimeout(r, 3000));
}
// 2026-10-16: past the live deadline the engine can stay blocked on windows that never
// self-exit (e.g. a hermes TUI parked on an unanswered prompt), so the finalize awaits
// would hang forever and no report would be written. Bound each child's exit wait; on
// timeout record a measurement failure and let the cleanup phase handle the leftovers.
const finalizeWait = (childDone, label) => Promise.race([
  childDone,
  new Promise(resolve => setTimeout(() => {
    noteSamplingError('finalize', label + ' did not exit after the live deadline; proceeding with cleanup');
    resolve(null);
  }, 120000)),
]);
const engineResult = await finalizeWait(engine.done, 'engine');
const pollResult = await finalizeWait(poll.done, 'poll');

const summaryRead=readJsonDiagnostic(summaryFile,{label:'summary.json'});
noteJsonDiagnostic(summaryRead);
const summary=summaryRead.ok&&summaryRead.value&&typeof summaryRead.value==='object'&&!Array.isArray(summaryRead.value)
  ? summaryRead.value : null;
if(summaryRead.ok&&summary===null)jsonDiagnostics.push('summary.json has invalid JSON shape');

const results = config.ids.map((id, i) => {
  const f = path.join(root, 'project-' + id, 'result' + id + '.json');
  const firstEnd = Number(summary?.results?.['B' + (i + 1)]?.attempts?.[0]?.endedAt);
  const withFirst = v => ({...v, firstFinished: Number.isFinite(firstEnd) ? firstEnd : undefined});
  if (!fs.existsSync(f)) return withFirst({id,missing:true});
  const parsed=readJsonDiagnostic(f,{label:'result '+id});
  if (!parsed.ok) { noteJsonDiagnostic(parsed); return withFirst({id,missing:true,jsonError:parsed.message}); }
  return withFirst(parsed.value&&typeof parsed.value==='object'&&!Array.isArray(parsed.value) ? parsed.value : {id,missing:true,jsonError:'result '+id+' has invalid JSON shape'});
});

const measurementFailures = [...samplingErrors.values()];
const samplingComplete = engineEnded;
const receiptsValid = results.every((r, i) => !r.missing && r.id === config.ids[i] && r.nonce === nonce && r.sum === 50005000 && r.cwd === workspace && r.finished > r.started);
const ordered = ninthOrderedAfterAFreedSlot(results, receiptsValid);
const windowLaunches = (engine.output().match(new RegExp('spawned visible '+agent+' TUI','g')) || []).length;
const uniqueLaunchers = new Set(samples.flatMap(s => s.live.map(w => w.launcherPid))).size;
const overlap = receiptsValid && Math.max(...results.slice(0, 8).map(r => r.started)) < Math.min(...results.slice(0, 8).map(r => r.finished));
const automaticClose = true; // OpenClaw 现为 print 类适配器（无 TUI 窗）；全部宿主按启动器契约自动关闭。
const coreHashAtEnd=coreHash();
const coreUnchanged=coreHashAtLaunch===coreHashAtEnd;
const verdict=codexFailureReasons({
  samplingComplete,measurementFailures,engineExit:engineResult.code,pollExit:pollResult.code,peak,capacity,tasks:config.ids.length,receiptsValid,
  ordered,overlap,windowLaunches,uniqueLaunchers,summaryResultCount:Object.keys(summary?.results||{}).length,
  summaryResultsVerified:Object.values(summary?.results||{}).every(r=>r.status==='verified'),automaticClose,coreUnchanged,jsonErrors:jsonDiagnostics,
});
const passed=verdict.passed;
const equivalentToCurrentCodexPlugin = passed && windowLaunches <= config.ids.length;
report = { automaticClose, samplingComplete, measurementFailures, jsonDiagnostics, failureReasons:verdict.failureReasons, coreHashAtLaunch, coreHashAtEnd, coreHashFiles:coreFiles, coreHashScheme:'sha256(sorted scripts/core *.mjs/*.ps1/*.txt entries as name:hash joined by LF)', coreUnchanged, coreVersion:summary?.version, passed, equivalentToCurrentCodexPlugin, runId, entry: process.env.ORCH_LIVE_ENTRY||path.join(repo, 'cli.mjs'), terminal: 'wt', workspace, root, nonce, capacity, tasks:config.ids.length, peak, windowLaunches, uniqueLaunchers, engineResult, pollResult, receiptsValid, ordered, overlap, results, summary, samples };
process.exitCode = passed ? 0 : 1;
} catch(error) {
  report={passed:false,runId,entry:process.env.ORCH_LIVE_ENTRY||path.join(repo,'cli.mjs'),terminal:'wt',workspace,root,nonce,capacity,peak,measurementFailures:[...samplingErrors.values()],jsonDiagnostics,error:String(error),failureReasons:['harness-error']};
  process.exitCode=1;
} finally {
  let cleanup={state:'not-run'};
  try {
    if(fs.existsSync(root))fs.writeFileSync(path.join(root,'release'),String(Date.now()));
    const registryFile=path.join(workspace,'temp','orchestrator','orchestrator-windows.json');
    const registry=readJsonDiagnostic(registryFile,{label:'orchestrator-windows.json'});
    const diagnostics=[];
    const windows=registry.kind==='missing'?[]:registry.ok&&Array.isArray(registry.value)?registry.value.filter(w=>w.runId===runId):[];
    if(!registry.ok&&registry.kind!=='missing')diagnostics.push(registry.message);
    const controllers=[];
    for(const run of children){
      const result=run.identity?{state:'live',identity:run.identity}:await Promise.race([run.identityPromise||Promise.resolve(null),new Promise(resolve=>setTimeout(()=>resolve(null),5000))]);
      if(result?.identity)controllers.push({label:run.label+' controller',identity:result.identity});
      else if(result?.state==='unknown'||!run.child?.exitCode)diagnostics.push(run.label+': process identity unavailable');
    }
    const before=collectOwnedProcessTargets({controllers,runId,windows},()=>processSnapshot());
    diagnostics.push(...before.diagnostics);
    const killed=[];
    // 窗口收尾（2026-10-11 用户口径）：窗口“完事就关”，正常/异常同一套——但走温柔关
    // （杀单元后代、等 launcher 自己 exit 0），绝不直接强杀 launcher 本体（那会留下 WT 的
    // “[已退出进程，代码为 1]”残壳）。控制器（引擎/采样）照旧强杀。
    const windowTargets=(before.targets||[]).filter(t=>/^window /.test(String(t.label||'')));
    const controllerTargets=(before.targets||[]).filter(t=>!/^window /.test(String(t.label||'')));
    for(const target of controllerTargets){killTree(target.pid);killed.push({label:target.label,pid:target.pid});}
    // 身份快照不带父子关系：温柔关前另取一次父子表，把每个窗口 launcher 的整棵子树展开。
    if(windowTargets.length){ const parentMap=parentProcessMap(); for(const t of windowTargets) t.descendants=pidsUnder(t.pid,parentMap); }
    const shutdown=await shutdownWindowTargets(windowTargets,{snapshot:()=>processSnapshot(),graceMs:30000,resolveHandle:t=>windowHandleFor(t.pid)});
    killed.push(...shutdown.killed);
    diagnostics.push(...shutdown.diagnostics);
    let after=before;
    const end=Date.now()+45000;
    while(killed.length&&Date.now()<end){
      await new Promise(resolve=>setTimeout(resolve,250));
      after=collectOwnedProcessTargets({controllers,runId,windows},()=>processSnapshot());
      diagnostics.push(...after.diagnostics);
      if(after.state==='clean'||after.state==='unknown'||after.state==='mismatch')break;
    }
    cleanup={state:diagnostics.length?'unknown':after.state,killed,windows:{graceful:shutdown.graceful,wmClosed:shutdown.wmClosed,forced:shutdown.forced},diagnostics:[...new Set(diagnostics)]};
  } catch(error) { cleanup={state:'unknown',error:String(error)}; }
 report=report||{passed:false,runId,entry:process.env.ORCH_LIVE_ENTRY||path.join(repo,'cli.mjs'),workspace,root,nonce,capacity};
 report.cleanup=cleanup;
 report=finalizeCodexReport(report,cleanup);
 try {
    if(fs.existsSync(root)){
      fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));
      fs.writeFileSync(path.join(root,'engine.log'),engine?.output()||'');
      fs.writeFileSync(path.join(root,'poll.log'),poll?.output()||'');
    }
  } catch(error) { report.reportWriteError=String(error); }
  console.log('[result] '+JSON.stringify({passed:report.passed,root,peak:report.peak??peak,receiptsValid:report.receiptsValid,ordered:report.ordered,overlap:report.overlap,cleanup}));
  if(report.passed!==true)process.exitCode=1;
}
