import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sameProcess} from '../scripts/core/leases.mjs';
import {powershellExe} from '../scripts/core/contracts.mjs';

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hasIdentity=value=>isObject(value)
  &&Number.isInteger(Number(value.ProcessId))&&Number(value.ProcessId)>0
  &&typeof value.Started==='string'&&value.Started.length>0
  &&typeof value.Name==='string'&&value.Name.length>0
  &&typeof value.CommandLine==='string';

export function loadDecomposeCache(file,version,fsImpl=fs) {
  if(!fsImpl.existsSync(file))return {version,entries:{}};
  let raw;
  try { raw=fsImpl.readFileSync(file,'utf8'); }
  catch(error) {
    throw new Error('decompose cache is unreadable; refusing to overwrite it: '+String(error?.message||error));
  }
  let value;
  try { value=JSON.parse(String(raw).replace(/^\uFEFF/,'')); }
  catch(error) {
    throw new Error('decompose cache is unreadable; refusing to overwrite it: '+String(error?.message||error));
  }
  if(!isObject(value)||value.version!==version||!isObject(value.entries))
    throw new Error('decompose cache version/schema mismatch; refusing to overwrite it');
  return value;
}

export function readJsonDiagnostic(file,{label=path.basename(file),fsImpl=fs}={}) {
  let raw;
  try { raw=fsImpl.readFileSync(file,'utf8'); }
  catch(error) {
    const kind=error?.code==='ENOENT'?'missing':'unreadable';
    return {ok:false,kind,file,label,message:`${label} ${kind}: ${String(error?.message||error)}`};
  }
  try { return {ok:true,kind:'ok',file,label,value:JSON.parse(String(raw).replace(/^\uFEFF/,''))}; }
  catch(error) {
    return {ok:false,kind:'invalid-json',file,label,message:`${label} invalid JSON: ${String(error?.message||error)}`};
  }
}

function resolveSnapshot(source) {
  if(source instanceof Map)return {snapshot:source,error:null};
  try {
    const snapshot=source();
    return snapshot instanceof Map ? {snapshot,error:null} : {snapshot:null,error:new Error('process snapshot was not a Map')};
  } catch(error) { return {snapshot:null,error}; }
}

export function inspectProcess(expected,source) {
  if(!hasIdentity(expected))return {state:'unknown',reason:'process identity is incomplete'};
  const {snapshot,error}=resolveSnapshot(source);
  if(error)return {state:'unknown',reason:'process snapshot unavailable: '+String(error?.message||error),error};
  const pid=Number(expected.ProcessId),observed=snapshot.get(pid);
  if(!observed)return {state:'gone',pid};
  if(!sameProcess(expected,observed))return {state:'mismatch',pid,observed,reason:'process identity mismatch'};
  return {state:'live',pid,observed};
}

export async function captureProcessIdentity(pid,{snapshot=()=>new Map(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeoutMs=30000,isStopped=()=>false}={}) {
  const end=Date.now()+timeoutMs;
  let lastError=null;
  while(Date.now()<end) {
    if(isStopped())return {state:'gone',reason:'process exited before identity was observed'};
    try {
      const current=snapshot();
      if(current instanceof Map) {
        const identity=current.get(Number(pid));
        if(identity)return {state:'live',identity};
      } else lastError=new Error('process snapshot was not a Map');
    } catch(error) { lastError=error; }
    await sleep(200);
  }
  if(lastError)return {state:'unknown',reason:'process snapshot unavailable: '+String(lastError?.message||lastError),error:lastError};
  return {state:'gone',reason:'process identity was not observed'};
}

function descendantPids(rootPid,snapshot) {
  const root=Number(rootPid),byPid=new Map();
  for(const [key,value] of snapshot.entries()) {
    const pid=Number(value?.ProcessId??key);
    if(Number.isInteger(pid)&&pid>0)byPid.set(pid,value);
  }
  const descendants=[];
  for(const [pid,value] of byPid) {
    if(pid===root)continue;
    let parent=Number(value?.ParentProcessId),seen=new Set();
    while(Number.isInteger(parent)&&parent>0&&!seen.has(parent)) {
      if(parent===root){descendants.push(pid);break;}
      seen.add(parent);
      parent=Number(byPid.get(parent)?.ParentProcessId);
    }
  }
  return [...new Set(descendants)];
}

export function collectOwnedProcessTargets({controllers=[],runId,windows=[]}={},source) {
  const resolved=resolveSnapshot(source);
  if(resolved.error)return {state:'unknown',targets:[],diagnostics:['process snapshot unavailable: '+String(resolved.error?.message||resolved.error)]};
  const snapshot=resolved.snapshot,targets=[],diagnostics=[];
  const candidates=[];
  for(const item of Array.isArray(controllers)?controllers:[]) {
    candidates.push({label:item?.label||'controller',identity:item?.identity});
  }
  for(const item of Array.isArray(windows)?windows:[]) {
    if(runId!==undefined&&item?.runId!==runId)continue;
    candidates.push({label:'window '+String(item?.title||item?.id||item?.pid||'?'),identity:item?.identity});
  }
  for(const candidate of candidates) {
    if(!hasIdentity(candidate.identity)) {
      diagnostics.push(candidate.label+': process identity is incomplete');
      continue;
    }
    const status=inspectProcess(candidate.identity,snapshot);
    if(status.state==='live')targets.push({label:candidate.label,pid:status.pid,identity:candidate.identity,descendants:descendantPids(status.pid,snapshot)});
    else if(status.state==='unknown'||status.state==='mismatch')diagnostics.push(candidate.label+': '+status.reason);
  }
  const state=diagnostics.some(d=>/unavailable|incomplete/.test(d))?'unknown':diagnostics.length?'mismatch':targets.length?'live':'clean';
  return {state,targets,diagnostics,snapshot};
}

export function codexFailureReasons({
  samplingComplete,measurementFailures=[],engineExit,pollExit,peak,capacity,tasks,receiptsValid,
  ordered,overlap,windowLaunches,uniqueLaunchers,summaryResultCount,summaryResultsVerified,
  automaticClose,coreUnchanged,jsonErrors=[],cleanupState,cleanupDiagnostics=[],
}={}) {
  const failureReasons=[];
  if(!samplingComplete)failureReasons.push('sampling-incomplete');
  if(measurementFailures.length)failureReasons.push('measurement-errors');
  if(engineExit!==0)failureReasons.push('engine-exit-'+String(engineExit));
  if(pollExit!==0)failureReasons.push('poll-exit-'+String(pollExit));
  if(peak!==capacity)failureReasons.push(`peak-${peak}-of-${capacity}`);
  if(!receiptsValid)failureReasons.push('receipts-invalid');
  if(!ordered)failureReasons.push('ordering-invalid');
  if(!overlap)failureReasons.push('overlap-invalid');
  // These three count things that happen once per TASK, not once per window slot: the harness runs
  // `tasks` (9) blocks through a window cap of `capacity` (8), so comparing them to capacity made
  // `passed` unreachable by construction (9 results can never equal 8). peak stays on capacity -
  // that one really is about how many windows were live at once.
  const perTask=Number.isFinite(Number(tasks))?Number(tasks):capacity;
  if(windowLaunches!==perTask)failureReasons.push(`window-launches-${windowLaunches}-of-${perTask}`);
  if(uniqueLaunchers!==perTask)failureReasons.push(`unique-launchers-${uniqueLaunchers}-of-${perTask}`);
  if(summaryResultCount!==perTask)failureReasons.push(`summary-result-count-${summaryResultCount}-of-${perTask}`);
  if(!summaryResultsVerified)failureReasons.push('summary-results-not-all-verified');
  if(jsonErrors.length)failureReasons.push('json-errors');
  if(!automaticClose)failureReasons.push('automatic-close-invalid');
  if(!coreUnchanged)failureReasons.push('core-changed-during-live-run');
  if(cleanupState!==undefined&&cleanupState!=='clean')failureReasons.push('cleanup-'+String(cleanupState));
  if(cleanupState==='clean'&&cleanupDiagnostics.length)failureReasons.push('cleanup-diagnostics');
  return {passed:failureReasons.length===0,failureReasons};
}

export function finalizeCodexReport(report,cleanup={state:"not-run",diagnostics:[]}) {
  if(!report||typeof report!=="object")return report;
  const finalCleanup=cleanup&&typeof cleanup==="object"
    ?cleanup
    :{state:"unknown",diagnostics:["cleanup result is invalid"]};
  report.cleanup=finalCleanup;
  if(report.receiptsValid===undefined){
    report.passed=false;
    return report;
  }
  const summaryResults=Object.values(report.summary?.results||{});
  const cleanupState=finalCleanup.state??finalCleanup.status??"not-run";
  const verdict=codexFailureReasons({
    samplingComplete:report.samplingComplete,
    measurementFailures:report.measurementFailures||[],
    engineExit:report.engineResult?.code,
    pollExit:report.pollResult?.code,
    peak:report.peak,
    capacity:report.capacity,
    // The final verdict is recomputed here, so this call needs the task count too - without it the
    // report silently falls back to capacity and re-fails the per-task counts (measured: a run whose
    // live verdict was correct still reported window-launches-12-of-8).
    tasks:report.tasks,
    receiptsValid:report.receiptsValid,
    ordered:report.ordered,
    overlap:report.overlap,
    windowLaunches:report.windowLaunches,
    uniqueLaunchers:report.uniqueLaunchers,
    summaryResultCount:summaryResults.length,
    summaryResultsVerified:summaryResults.every(r=>r.status==="verified"),
    automaticClose:report.automaticClose,
    coreUnchanged:report.coreUnchanged,
    jsonErrors:report.jsonDiagnostics||[],
    cleanupState,
    cleanupDiagnostics:finalCleanup.diagnostics||[],
  });
  report.failureReasons=verdict.failureReasons;
  report.passed=verdict.passed;
  report.equivalentToCurrentCodexPlugin=report.passed&&report.windowLaunches<=report.capacity;
  return report;
}

export function controllerRecords(children=[]) {
  return (Array.isArray(children)?children:[]).map(run => ({
    label:String(run?.label||"controller")+" controller",
    identity:run?.identity,
  }));
}

// ── 窗口收尾纪律（2026-10-11 用户口径）────────────────────────────────────────────
// 窗口“完事就关”（正常/异常同一套流程）。绝不强杀 launcher 本体：给单元后代发 /F 之后，
// launcher 的 `& agent` 返回，自己写结果并以 exit 0 收尾，Windows Terminal 随即干净关窗
// （强杀 launcher 会让 WT 以 rc=1 退出、在桌面上留下 “[已退出进程，代码为 1]” 残壳）。
// 三层兜底：①杀后代等自然退出 → ②仍活则向其窗口发 WM_CLOSE → ③仍活才强杀并记账
// （残壳交产品下次启动的 sweep 收口）。
function killPid(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return;
  if (process.platform === 'win32') spawnSync(process.env.ComSpec || 'cmd.exe', ['/d','/s','/c','taskkill /PID '+String(pid)+' /T /F'], {windowsHide:true,stdio:'ignore'});
  else { try { process.kill(Number(pid),'SIGKILL'); } catch {} }
}
// 身份快照（leases.processSnapshot）只带 ProcessId/Name/CommandLine/Started，没有父子关系；
// 温柔关要找“单元后代”就必须另取一次父子表（test 侧独立查询，不动产品快照契约）。
export function parentProcessMap(timeoutMs) {
  try {
    const r=spawnSync(powershellExe(),['-NoProfile','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],{encoding:'utf8',windowsHide:true,timeout:timeoutMs||20000});
    if(r.status!==0)return new Map();
    const list=JSON.parse(String(r.stdout||'[]'));
    return new Map((Array.isArray(list)?list:[list]).filter(p=>p&&p.ProcessId!==undefined).map(p=>[Number(p.ProcessId),Number(p.ParentProcessId)]));
  } catch { return new Map(); }
}
export function pidsUnder(rootPid,parentMap) {
  const root=Number(rootPid);
  if(!root||!parentMap||!parentMap.size)return [];
  const children=new Map();
  for(const [pid,parent] of parentMap){ if(!children.has(parent))children.set(parent,[]); children.get(parent).push(pid); }
  const out=[],stack=[root];
  while(stack.length){ const cur=stack.pop(); for(const c of children.get(cur)||[]){ if(!out.includes(c)){out.push(c);stack.push(c);} } }
  return out;
}
export function wmCloseWindow(hwnd) {
  const handle=String(hwnd||'').trim();
  if (!handle) return false;
  const script="Add-Type -MemberDefinition '[DllImport(\"user32.dll\")]public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);' -Name W -Namespace Otui; [Otui.W]::SendMessage([IntPtr]"+handle+",0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null";
  try { return spawnSync(powershellExe(), ['-NoProfile','-NonInteractive','-Command',script], {windowsHide:true,timeout:15000}).status===0; }
  catch { return false; }
}
export async function shutdownWindowTargets(targets,{snapshot,sleep=ms=>new Promise(r=>setTimeout(r,ms)),graceMs=30000,resolveHandle=()=>null}={}) {
  const killed=[],diagnostics=[];
  const list=Array.isArray(targets)?targets:[];
  const aliveNow=items=>items.filter(t=>inspectProcess(t.identity,snapshot).state!=='gone');
  const waitGone=async(items,budget)=>{const end=Date.now()+budget;let left=aliveNow(items);while(left.length&&Date.now()<end){await sleep(500);left=aliveNow(items);}return left;};
  // ① 温柔关：只杀单元后代（深树枚举已在 collectOwnedProcessTargets 时完成），launcher 自己收尾。
  for(const t of list) for(const pid of t.descendants||[]) killPid(pid);
  let leftover=await waitGone(list,graceMs);
  for(const t of list) if(!leftover.includes(t)) killed.push({label:t.label,pid:t.pid,how:'graceful'});
  // ② 仍活的窗口：向其窗口句柄发 WM_CLOSE（句柄由调用方从本 run 的窗口记录解析），再给一小段退出时间。
  if(leftover.length) {
    const pending=[];
    for(const t of leftover) {
      let hwnd=null; try { hwnd=resolveHandle(t); } catch {}
      if(hwnd&&wmCloseWindow(hwnd)) pending.push(t);
      else diagnostics.push(t.label+': no window handle available for WM_CLOSE');
    }
    if(pending.length) {
      const stillAlive=await waitGone(pending,10000);
      for(const t of pending) if(!stillAlive.includes(t)) killed.push({label:t.label,pid:t.pid,how:'wm-close'});
      leftover=[...stillAlive,...leftover.filter(t=>!pending.includes(t))];
    }
  }
  // ③ 强杀兜底（记账；残壳由产品下次启动 sweep 收口）。
  for(const t of leftover) {
    killPid(t.pid); killed.push({label:t.label,pid:t.pid,how:'forced'});
    diagnostics.push(t.label+': launcher force-killed after graceful withdrawal and WM_CLOSE failed; a window shell may remain until the next run sweep');
  }
  if(leftover.length) await sleep(300);
  return {killed,diagnostics,graceful:killed.filter(k=>k.how==='graceful').length,wmClosed:killed.filter(k=>k.how==='wm-close').length,forced:killed.filter(k=>k.how==='forced').length};
}
