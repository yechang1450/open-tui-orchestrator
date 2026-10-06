import fs from 'node:fs';
import path from 'node:path';
import {sameProcess} from '../scripts/core/leases.mjs';

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
