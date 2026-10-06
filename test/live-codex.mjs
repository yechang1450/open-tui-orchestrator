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
import { readJsonDiagnostic, captureProcessIdentity, inspectProcess, collectOwnedProcessTargets, codexFailureReasons, finalizeCodexReport } from './live-safety.mjs';

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
try {
if (process.platform !== 'win32') throw new Error('This acceptance scenario requires Windows');
fs.mkdirSync(root, { recursive: true });
// Deadline is tunable (2026-10-06): the fixed 970s window misreported agent speed as failure --
// hermes units need ~11-13 min each, so correct output landed only seconds after the hardcoded
// deadline and was reported unproven. The engine's own ORCH_MAX_POLL_MS scales with the same knob:
// raising only the harness window left the engine cutting units off at its own fixed 15 min.
// Same class as the other budget fixes: only the budget is configurable, the verdict stays fail-closed.
const liveDeadlineMs = Math.max(300000, Number(process.env.ORCH_LIVE_DEADLINE_MS) || 970000);
// The harness verifies that the engine holds EXACTLY `capacity` windows in parallel and queues the
// rest, so the cap has to be handed to the engine: without ORCH_MAX_WINDOWS the engine picks its own
// capacity from memory-fit (measured: 9 against a hardcoded 8), and then `live.length === capacity`
// can never hold while `live.length > capacity` throws 'Capacity exceeded' - the release barrier is
// never written and every probe dies on its own timeout.
const env = { ...process.env, ORCH_AGENT: agent, ORCH_SPAWN_MODE: 'window', ORCH_MAX_POLL_MS: String(Math.max(60000, liveDeadlineMs - 70000)), ORCH_MAX_WINDOWS: String(capacity), ORCH_WINDOW_CONFIRM_MS: String(Math.max(60000, Number(process.env.ORCH_WINDOW_CONFIRM_MS) || 90000)), // First-checkpoint budget: the engine retires a unit that has not recorded its first checkpoint in
// time, and a hermes TUI can take minutes to boot and answer. Measured: 15 'unproductive: no task
// checkpoint within 300s' events in one run, each one a retry - and the retries are what break the
// launch count, the ordering and the overlap checks all at once.
ORCH_UNIT_FIRST_CHECKPOINT_MS: String(Math.max(300000, Number(process.env.ORCH_UNIT_FIRST_CHECKPOINT_MS) || 900000)), ORCH_RUN_ID:runId, ORCH_ACCEPTANCE_FILE:acceptanceFile };
for (const key of ['WORKSPACE_DIR', 'ORCH_STATE_DIR', 'ORCH_TUI', 'ORCH_SANDBOX', 'ORCH_APPROVAL']) delete env[key];
const config = { nonce, workspace, ids: Array.from({ length: 9 }, (_, i) => String(91 + i)), capacity };
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
const started = Date.now();
fs.writeFileSync(path.join(out, 'started.json'), JSON.stringify({id, nonce:config.nonce, pid:process.pid, started}));
while (!fs.existsSync(path.join(root, 'release')) && id !== config.ids.at(-1)) {
  if (Date.now() - started > 600000) throw new Error('parent did not observe eight overlapping windows');
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
const request = config.ids.map(id => `项目${id}：先按主持提供的命令逐项记录检查点，再执行 node ${root.replaceAll('\\', '/')}/project-${id}/probe${id}.mjs ${id} 创建 ${root.replaceAll('\\', '/')}/project-${id}/result${id}.json 并等待命令完成后读回该结果文件核验成功，禁止另开窗口禁止提交或写记忆`).join('；');
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
engine.done.then(() => {
  engineEnded = true;
  if (!fs.existsSync(summaryFile)) void terminateVerified(poll);
});
const deadline = Date.now() + liveDeadlineMs;
while (!engineEnded && Date.now() < deadline) {
  try {
    const { stdout } = await exec(powershellExe(), ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n="Started";e={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 15000 });
    const decoded = JSON.parse(stdout);
    const processes = Array.isArray(decoded) ? decoded : (decoded && typeof decoded === 'object' ? [decoded] : null);
    if (!processes) throw new Error('process snapshot was neither an object nor an array');
    const byPid = new Map(processes.map(p => [p.ProcessId, p]));
    const registry = path.join(workspace, 'temp', 'orchestrator', 'orchestrator-windows.json');
    const windows = fs.existsSync(registry) ? JSON.parse(fs.readFileSync(registry, 'utf8')) : [];
    const own = windows.filter(w => w.runId===runId);
    const live = [];
    for (const w of own) {
      if (!w.identity) {
        noteSamplingError('window-identity', 'missing launcher identity for ' + String(w.title || w.runId || 'window'));
        continue;
      }
      let pid = Number(w.pid);
      if (fs.existsSync(w.pidFile)) pid = Number(fs.readFileSync(w.pidFile, 'utf8').replace(/^\uFEFF/, '').trim());
      if (!Number.isInteger(pid) || pid < 1) {
        noteSamplingError('pid-file', 'invalid launcher pid for ' + String(w.title || w.runId || 'window'));
        continue;
      }
      const launcher=byPid.get(pid);
      if (!launcher) continue;
      if (!sameProcess(w.identity,launcher)) {
        noteSamplingError('window-identity', 'launcher identity mismatch for ' + String(w.title || w.runId || 'window'));
        continue;
      }
      const descendants = processes.filter(p => {
        let q = p; const visited = new Set();
        while (q && !visited.has(q.ProcessId)) {
          visited.add(q.ProcessId);
          if (q.ParentProcessId === pid) return true;
          q = byPid.get(q.ParentProcessId);
        }
        return false;
      });
      const agents = descendants.filter(p => agent==='openclaw'?(/^node(?:\.exe)?$/i.test(p.Name)&&/openclaw\.mjs.*tui/i.test(p.CommandLine||'')):agent==='pi'?(/^pi(?:\.exe)?$/i.test(p.Name)||(/^node(?:\.exe)?$/i.test(p.Name)&&/pi-coding-agent.*cli\.js/i.test(p.CommandLine||''))):agent==='hermes'?/^hermes(?:\.exe)?$/i.test(p.Name):agent==='opencode'?/^opencode(?:\.exe)?$/i.test(p.Name):agent==='kimi'?/^kimi(?:\.exe)?$/i.test(p.Name):/^codex(?:\.exe)?$/i.test(p.Name));
      if (agents.length) live.push({ title: w.title, launcherPid: pid, launcherParentPid: launcher.ParentProcessId, agentPids: agents.map(p => p.ProcessId) });
    }
    const ready = config.ids.filter(id => fs.existsSync(path.join(root, 'project-' + id, 'started.json')));
    const sample = { at: Date.now(), live, ready };
    samples.push(sample);
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
  await new Promise(r => setTimeout(r, 3000));
}
const engineResult = await engine.done;
const pollResult = await poll.done;
const results = config.ids.map(id => {
  const f = path.join(root, 'project-' + id, 'result' + id + '.json');
  if (!fs.existsSync(f)) return {id,missing:true};
  const parsed=readJsonDiagnostic(f,{label:'result '+id});
  if (!parsed.ok) { noteJsonDiagnostic(parsed); return {id,missing:true,jsonError:parsed.message}; }
  return parsed.value&&typeof parsed.value==='object'&&!Array.isArray(parsed.value) ? parsed.value : {id,missing:true,jsonError:'result '+id+' has invalid JSON shape'};
});

const summaryRead=readJsonDiagnostic(summaryFile,{label:'summary.json'});
noteJsonDiagnostic(summaryRead);
const summary=summaryRead.ok&&summaryRead.value&&typeof summaryRead.value==='object'&&!Array.isArray(summaryRead.value)
  ? summaryRead.value : null;
if(summaryRead.ok&&summary===null)jsonDiagnostics.push('summary.json has invalid JSON shape');
const measurementFailures = [...samplingErrors.values()];
const samplingComplete = engineEnded;
const receiptsValid = results.every((r, i) => !r.missing && r.id === config.ids[i] && r.nonce === nonce && r.sum === 50005000 && r.cwd === workspace && r.finished > r.started);
const ordered = receiptsValid && results[8].started >= results[7].finished;
const windowLaunches = (engine.output().match(new RegExp('spawned visible '+agent+' TUI','g')) || []).length;
const uniqueLaunchers = new Set(samples.flatMap(s => s.live.map(w => w.launcherPid))).size;
const overlap = receiptsValid && Math.max(...results.slice(0, 8).map(r => r.started)) < Math.min(...results.slice(0, 8).map(r => r.finished));
const automaticClose = agent !== 'openclaw' || Object.values(summary?.results||{}).every(r=>{
  try{const proof=JSON.parse(fs.readFileSync(path.join(r.launcherFiles.openclawState,'completion.json'),'utf8'));return proof.automaticClose&&proof.nativeExitCode===0&&proof.__EXIT__===0&&proof.token===r.attempts.at(-1).token;}catch{return false;}
});
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
    for(const target of before.targets||[]){killTree(target.pid);killed.push({label:target.label,pid:target.pid});}
    let after=before;
    const end=Date.now()+10000;
    while(killed.length&&Date.now()<end){
      await new Promise(resolve=>setTimeout(resolve,250));
      after=collectOwnedProcessTargets({controllers,runId,windows},()=>processSnapshot());
      diagnostics.push(...after.diagnostics);
      if(after.state==='clean'||after.state==='unknown'||after.state==='mismatch')break;
    }
    cleanup={state:diagnostics.length?'unknown':after.state,killed,diagnostics:[...new Set(diagnostics)]};
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
