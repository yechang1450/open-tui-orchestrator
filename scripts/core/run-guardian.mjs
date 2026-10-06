import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {atomicJson,processSnapshot,sameProcess} from './leases.mjs';
import {runDirectory,resolveRuntimeContext,resolveStateDirectory} from './runtime-context.mjs';

// Run guardian: a tiny detached process that outlives the engine. It watches the
// engine process plus summary.json; when the engine dies abnormally (process gone
// but the run never finalized) it relaunches `--resume-run <runId>` so surviving
// windows are adopted and remaining tasks continue — no user re-invocation needed.
// Fail-closed: a bounded restart budget, a run deadline, and snapshot failures all
// stop respawning instead of risking a duplicate or endless controller loop.

const ENTRY=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','orchestrate-sdk.mjs');

export function guardianFile(workspace,runId,stateDir) { return path.join(runDirectory(workspace,runId,stateDir),'guardian.json'); }

export function readGuardianState(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}

function validState(state,runId){
  return !!state&&state.runId===runId&&Number.isSafeInteger(state.restarts)&&state.restarts>=0
    &&Number.isSafeInteger(state.maxRestarts)&&Number.isSafeInteger(state.timeoutMs)&&state.timeoutMs>=60000
    &&Number.isSafeInteger(state.createdAt)&&Array.isArray(state.engines)&&state.engines.length
    &&state.engines.every(e=>e?.owner&&Number.isSafeInteger(Number(e.owner.ProcessId)));
}

// Spawn (or adopt) the guardian for a fresh run. Called by the engine once the
// run ledger exists; guardian failure must never break the run itself.
export function ensureRunGuardian({runId,workspace,stateDir:providedStateDir,timeoutMs,owner,agent,env=process.env,spawnImpl=spawn,snapshotImpl=processSnapshot,log=console.log}={}) {
  if(env.ORCH_GUARDIAN==='0'||env.NODE_TEST_CONTEXT)return {disabled:true};
  const stateDir=providedStateDir||resolveStateDirectory(workspace,env),dir=runDirectory(workspace,runId,stateDir),file=guardianFile(workspace,runId,stateDir);
  const prev=readGuardianState(file);
  if(prev&&Number.isSafeInteger(Number(prev.guardianPid))&&Number(prev.guardianPid)>0) {
    try {
      const p=snapshotImpl().get(Number(prev.guardianPid));
      if(p&&/run-guardian\.mjs/i.test(String(p.CommandLine||''))&&String(p.CommandLine).includes(runId))return {already:true,pid:Number(prev.guardianPid)};
    }catch{ /* snapshot unavailable: fall through and replace the suspect guardian */ }
  }
  const state={
    runId,guardianPid:0,restarts:prev?.restarts||0,
    maxRestarts:Math.max(0,Math.min(10,Number(env.ORCH_GUARDIAN_MAX_RESTARTS)||3)),
    intervalMs:Math.max(500,Math.min(10000,Number(env.ORCH_GUARDIAN_INTERVAL_MS)||2000)),
    timeoutMs:Math.max(60000,Number(timeoutMs)||21600000),
    createdAt:prev?.createdAt||Date.now(),
    engines:[...(Array.isArray(prev?.engines)?prev.engines:[]),{owner,startedAt:Date.now(),by:'initiator'}],
    status:'watching',updatedAt:Date.now(),
  };
  atomicJson(file,state);
  const out=fs.openSync(path.join(dir,'guardian.log'),'a');
  const child=spawnImpl(process.execPath,[path.join(path.dirname(fileURLToPath(import.meta.url)),'run-guardian.mjs'),'--run-id',runId],
    {cwd:workspace,env:{...env,ORCH_AGENT:agent,ORCH_RUN_ID:runId,WORKSPACE_DIR:workspace,ORCH_STATE_DIR:stateDir},detached:true,windowsHide:true,stdio:['ignore',out,out]});
  fs.closeSync(out);
  child.on?.('error',()=>{});child.unref?.();
  state.guardianPid=Number(child?.pid)||0;state.updatedAt=Date.now();atomicJson(file,state);
  log('[guardian] watching runId='+runId+' pid='+state.guardianPid);
  return {spawned:true,pid:state.guardianPid};
}

export function parseGuardianOptions(argv) {
  const result={};
  for(let i=0;i<argv.length;i++) {
    if(argv[i]==='--run-id') {
      const value=argv[++i];
      if(!value||value.startsWith('--'))throw new Error('GUARDIAN_ARGUMENT_INVALID: --run-id is required');
      result.runId=value;
    } else throw new Error('GUARDIAN_ARGUMENT_INVALID: '+argv[i]);
  }
  if(!result.runId)throw new Error('GUARDIAN_ARGUMENT_INVALID: --run-id is required');
  return result;
}

export async function main(argv=process.argv.slice(2),hooks={}) {
  const {runId}=parseGuardianOptions(argv);
  const env=hooks.env||process.env;
  const {workspace,state:stateRoot}=resolveRuntimeContext(env);
  const dir=runDirectory(workspace,runId,stateRoot),stateFile=guardianFile(workspace,runId,stateRoot);
  const now=hooks.now||(()=>Date.now()),sleep=hooks.sleep||(ms=>new Promise(r=>setTimeout(r,ms)));
  const snapshot=hooks.snapshot||processSnapshot,spawnImpl=hooks.spawn||spawn;
  const log=hooks.log||(m=>{console.log(m);try{fs.appendFileSync(path.join(dir,'guardian.log'),m+'\n');}catch{}});
  const readSummary=()=>{
    const file=path.join(dir,'summary.json');
    let raw;
    try{raw=fs.readFileSync(file,'utf8');}
    catch(e){return e.code==='ENOENT'?{kind:'missing'}:{kind:'broken',why:'summary.json unreadable: '+e.code};}
    try{return {kind:'ok',value:JSON.parse(raw)};}
    catch(e){return {kind:'broken',why:'summary.json unparsable: '+e.message};}
  };
  // 兼容两种桩形态：三态包装（新）与裸 summary 对象/null（旧）。旧桩 null 视作 missing——
  // 它不是错误，只是"还没有落盘"；真损坏必须由三态形态显式声明（kind:'broken'）。
  const load=()=>{
    const r=hooks.load?hooks.load():readSummary();
    if(r&&typeof r==='object'&&typeof r.kind==='string')return r;
    if(r===null||r===undefined)return {kind:'missing'};
    return {kind:'ok',value:r};
  };
  const readState=hooks.readState||(()=>readGuardianState(stateFile));
  const writeState=hooks.writeState||(s=>{s.updatedAt=Date.now();atomicJson(stateFile,s);});
  // The engine writes the state file just before spawning us; tolerate a race.
  let state=null;
  for(let i=0;i<20&&!state;i++){state=readState();if(!state)await sleep(500);}
  if(!validState(state,runId)){log('[guardian] missing or invalid state; exit');process.exitCode=2;return;}
  const finish=(status,code,why)=>{state.status=status;writeState(state);log('[guardian] '+status+' runId='+runId+' restarts='+state.restarts+(why?' reason='+why:''));process.exitCode=code;};
  let engine=state.engines.at(-1).owner;
  const guardianDeadline=state.createdAt+state.timeoutMs+600000;
  while(now()<guardianDeadline) {
    const sum=load();
    // 三态读法：missing＝引擎还在跑、summary 尚未落盘（正常等待，不是错误）；
    //          broken＝文件在但读不动/解析不了（真错误，必须带原因 fail-closed）。
    if(sum.kind==='broken'){finish('error',2,sum.why);return;}
    if(sum.kind==='ok'&&sum.value&&sum.value.finishedAt){finish('done',0);return;}
    let snap=null;
    try{snap=snapshot();}catch{/* identity unverifiable: never respawn blind */}
    if(snap===null){await sleep(state.intervalMs);continue;}
    if(sameProcess(engine,snap.get(Number(engine.ProcessId)))){await sleep(state.intervalMs);continue;}
    // Engine is gone but the run is not finalized: abnormal interruption.
    if(now()>state.createdAt+state.timeoutMs){finish('deadline',1);return;}
    if(state.restarts>=state.maxRestarts){finish('exhausted',1);return;}
    await sleep(Math.min(5000*2**state.restarts,30000));
    const again=load();
    if(again.kind==='broken'){finish('error',2,again.why);return;}
    if(again.kind==='ok'&&again.value&&again.value.finishedAt){finish('done',0);return;}
    try{snap=snapshot();}catch{snap=null;}
    if(snap&&sameProcess(engine,snap.get(Number(engine.ProcessId))))continue;
    const number=state.restarts+1;
    log('[guardian] engine lost (pid='+engine.ProcessId+'); resuming run '+runId+' (restart '+number+'/'+state.maxRestarts+')');
    let outFd;
    try{outFd=fs.openSync(path.join(dir,'resumed-engine-'+number+'.log'),'a');}catch{outFd='ignore';}
    const child=spawnImpl(process.execPath,[ENTRY,'--resume-run',runId],{
      cwd:workspace,
      env:{...env,ORCH_AGENT:String((again.value&&again.value.agent)||'codex'),ORCH_RUN_ID:runId,WORKSPACE_DIR:workspace,ORCH_STATE_DIR:stateRoot},
      detached:true,windowsHide:true,stdio:['ignore',outFd,outFd],
    });
    if(outFd!=='ignore')try{fs.closeSync(outFd);}catch{}
    child?.on?.('error',()=>{});child?.unref?.();
    let identity=null;
    if(child&&child.pid){
      // 有界宽限轮询：WMI 对刚创建的进程常滞后（同仓 identityWithGrace 同理）；单次读失手会让
      // engine 停在旧死 pid 上，下个 interval 再判 'engine gone' → 重复 spawn、双倍消耗 restart 预算。
      for(let tries=0;tries<25;tries++){
        try{identity=snapshot().get(Number(child.pid))||null;}catch{identity=null;}
        if(identity)break;
        if(tries<24)await sleep(200);
      }
    }
    state.restarts++;
    if(identity){state.engines.push({owner:identity,startedAt:Date.now(),by:'guardian'});engine=identity;}
    writeState(state);
    if(!identity){log('[guardian] resumed engine vanished immediately; will re-evaluate');await sleep(state.intervalMs);}
  }
  finish('deadline',1);
}

if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase())main().catch(e=>{console.error('[guardian] FATAL: '+e.message);process.exitCode=2;});
