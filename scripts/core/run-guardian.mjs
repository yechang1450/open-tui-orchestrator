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
    // 2026-10-26（P6）：上一轮 resume 的引擎没在 5s 宽限里进快照时，state.engines 里没有它，
    // engine 仍停在旧死 pid 上 —— 下一轮必然再判 'engine gone' → 再 spawn 一个，两个引擎
    // 同操作一个 run（账本互覆、同一批任务重复放行），而 maxRestarts 只限次数、不限同时存活数。
    // 这里按 pid 追它：宽限期内不重复 spawn，确认不到 60s 后才放弃。
    if(state.pendingEnginePid){
      const pid=Number(state.pendingEnginePid);
      let found=null;
      try{found=snapshot().get(pid)||null;}catch{found=null;}
      if(found){
        engine=found;state.engines.push({owner:found,startedAt:Date.now(),by:'guardian'});
        delete state.pendingEnginePid;delete state.pendingSince;writeState(state);
        log('[guardian] tracked the previously unconfirmed engine pid='+pid);
      } else if(now()-Number(state.pendingSince||0)>60000){
        delete state.pendingEnginePid;delete state.pendingSince;writeState(state);
        log('[guardian] unconfirmed engine pid='+pid+' never appeared within 60s; dropping it');
      } else {
        // 2026-10-26（P6 修正）：宽限期内按 pid 追它，但**预算不能因此延后**。restart 预算已经用完时
        // 没有任何东西可等 —— 直接按 fail-closed 收口。这一步必须先于 deadline 判：主循环里
        // deadline 在前是因为「时间到了就该停」，而这里是「我们已经超预算了，pending 只是空转」，
        // 原样空转 60s 会把本应 exhausted 的用例拖成 deadline（run-guardian.test 的 fail-closed 用例
        // timeoutMs=60000 正是这个形态）。
        if(state.restarts>=state.maxRestarts){finish('exhausted',1);return;}
        if(now()>state.createdAt+state.timeoutMs){finish('deadline',1);return;}
        await sleep(state.intervalMs);continue;
      }
    }
    const sum=load();
    // 三态读法：missing＝引擎还在跑、summary 尚未落盘（正常等待，不是错误）；
    //          broken＝文件在但读不动/解析不了（真错误，必须带原因 fail-closed）。
    if(sum.kind==='broken'){finish('error',2,sum.why);return;}
    if(sum.kind==='ok'&&sum.value&&sum.value.finishedAt){finish('done',0);return;}
    let snap=null;
    // 2026-10-26（P5）：快照失败原先只 catch{} 后 continue —— 满载时 WMI/CIM 持续超时会让守护
    // 静默空转，而 guardian.json 仍是 watching，用户和 --status 都以为有人看着，直到
    // createdAt+timeout+10min（默认 6h10m）才 finish('deadline')。连续 N 次取不到身份要 fail-loud：
    // 落日志 + 状态标 degraded，让 --status 一眼看出「这个守护现在靠不住」。
    try{snap=snapshot();state.snapshotFails=0;if(state.degraded&&state.degraded.startsWith('identity'))delete state.degraded;}
    catch(error){
      state.snapshotFails=(state.snapshotFails||0)+1;
      if(state.snapshotFails>=3&&!state.degraded){
        state.degraded='identity unverifiable: '+state.snapshotFails+' consecutive process-snapshot failures ('+String(error&&error.message||error).slice(0,120)+') — the guardian cannot confirm the engine is alive and will never respawn it blind';
        log('[guardian] DEGRADED: '+state.degraded);
        writeState(state);
      }
      snap=null; /* identity unverifiable: never respawn blind */
    }
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
    else if(child&&child.pid){
      // 2026-10-26（P6）：没确认到身份就必须把它登记为 pending —— 否则 engine 停在旧死 pid 上，
      // 下一轮又 spawn 一个，两个引擎同操作一个 run。
      state.pendingEnginePid=child.pid;state.pendingSince=Date.now();
    }
    writeState(state);
    if(!identity){log('[guardian] resumed engine pid='+((child&&child.pid)||'?')+' not visible in the snapshot yet; tracking it instead of spawning another');await sleep(state.intervalMs);}
  }
  finish('deadline',1);
}

if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase())main().catch(e=>{console.error('[guardian] FATAL: '+e.message);process.exitCode=2;});
