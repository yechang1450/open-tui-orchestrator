// Opt-in real TUI test: kill the Node controller mid-run, then MANUALLY relaunch
// --resume-run (the guardian is disabled via ORCH_GUARDIAN=0, so the manual
// resume is the only recovery path — live-guardian.mjs covers the automatic
// variant). The surviving window must be adopted, not duplicated; the run must
// finalize. Two independent single-task projects keep the window policy
// satisfied (a single-block plan is deliberately executed inline and would
// test nothing).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {processSnapshot,sameProcess} from '../scripts/core/leases.mjs';
import {loadDecomposeCache,captureProcessIdentity,inspectProcess,collectOwnedProcessTargets,readJsonDiagnostic,controllerRecords} from './live-safety.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),workspace=process.cwd();
// Default agent is kimi: codex windows (gpt-6-astra/ultra) were observed to
// stall after printing their TODO list or to run the checkpoint command via
// PowerShell despite the cmd /c hard rule — model-side flakes that would make
// this engine test nondeterministic. Override with ORCH_LIVE_AGENT=codex.
const agent=process.env.ORCH_LIVE_AGENT||'kimi';
const entry=process.env.ORCH_LIVE_ENTRY||path.join(repo,'scripts','orchestrate-sdk.mjs');
const runId='recovery-'+crypto.randomUUID(),root=path.join(workspace,'temp',runId);
const stateDir=path.join(root,'state');
const runDir=path.join(stateDir,'runs',runId);
const summaryFile=path.join(runDir,'summary.json');
const guardianFile=path.join(runDir,'guardian.json');
const coreHash=()=>crypto.createHash('sha256').update(fs.readdirSync(path.join(repo,'scripts','core')).filter(n=>/\.(mjs|ps1|txt)$/.test(n)).sort().map(n=>n+':'+crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,'scripts','core',n))).digest('hex')).join('\n')).digest('hex');
const hashBefore=coreHash();fs.mkdirSync(root,{recursive:true});
const dirA=path.join(root,'project-a'),dirB=path.join(root,'project-b');
fs.mkdirSync(dirA,{recursive:true});fs.mkdirSync(dirB,{recursive:true});
const probeA=path.join(dirA,'probeA.mjs'),probeB=path.join(dirB,'probeB.mjs'),acceptance=path.join(root,'acceptance.json');
fs.writeFileSync(probeA,`import fs from 'node:fs';import path from 'node:path';
const f=path.join(${JSON.stringify(dirA)},'resultA.json');const count=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)).count:0;
fs.writeFileSync(f,JSON.stringify({count:count+1,cwd:process.cwd()}));console.log('verified A');`);
fs.writeFileSync(probeB,`import fs from 'node:fs';import path from 'node:path';
const root=${JSON.stringify(root)};fs.writeFileSync(path.join(root,'waiting'),'waiting');
const until=Date.now()+300000;while(!fs.existsSync(path.join(root,'release'))){if(Date.now()>until)throw new Error('Recovery barrier timeout');await new Promise(r=>setTimeout(r,200));}
fs.writeFileSync(path.join(${JSON.stringify(dirB)},'resultB.json'),JSON.stringify({done:true,cwd:process.cwd()}));console.log('verified B');`);
fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'json',path:path.join(dirA,'resultA.json'),equals:{count:1,cwd:workspace}}],T002:[{type:'json',path:path.join(dirB,'resultB.json'),equals:{done:true,cwd:workspace}}]}));
const slash=s=>s.replaceAll('\\','/');
const taskA=`项目A：执行 node ${slash(probeA)} 并等待命令结束，在发起目录 ${slash(workspace)} 执行，按主持提供的命令逐项记录检查点，禁止另开窗口禁止提交或写记忆`;
const taskB=`项目B：执行 node ${slash(probeB)} 并等待命令结束，在发起目录 ${slash(workspace)} 执行，按主持提供的命令逐项记录检查点，禁止另开窗口禁止提交或写记忆`;
const request=taskA+'；'+taskB;
// Pre-seed the decompose cache: the kimi planner needs ~5 minutes cold, which is
// planner latency, not what this test measures. The cached plan makes the engine
// deterministic (cache HIT -> window policy -> two blocks, no LLM round trip).
const {CORE_VERSION}=await import('../scripts/core/contracts.mjs');
const planBlocks=[
 {title:'project-a',type:'parallel',dependsOn:[],conflictKeys:[slash(dirA)],tasks:[{prompt:taskA}]},
 {title:'project-b',type:'parallel',dependsOn:[],conflictKeys:[slash(dirB)],tasks:[{prompt:taskB}]},
];
const hintsKey=JSON.stringify({moduleToProj:{},foldRules:{},tailKeywords:['清爽','清理','保持干净','收尾','整理']});
const decomposeHash=crypto.createHash('sha1').update(CORE_VERSION+'|'+request+'|'+hintsKey).digest('hex');
const cacheFile=path.join(stateDir,'orchestrator-decompose-cache.json');
let cache=loadDecomposeCache(cacheFile,CORE_VERSION);
cache.entries[decomposeHash]={createdAt:Date.now(),blocks:planBlocks};
fs.mkdirSync(path.dirname(cacheFile),{recursive:true});
fs.writeFileSync(cacheFile,JSON.stringify(cache),'utf8');
// ORCH_GUARDIAN=0: no detached guardian may race the manual --resume-run below.
const env={...process.env,ORCH_AGENT:agent,ORCH_SPAWN_MODE:'window',ORCH_RUN_ID:runId,ORCH_ACCEPTANCE_FILE:acceptance,ORCH_MAX_POLL_MS:'600000',ORCH_GUARDIAN:'0',ORCH_STATE_DIR:stateDir,ORCH_COORDINATOR_DIR:path.join(root,'coordinator')};
for(const key of ['WORKSPACE_DIR','ORCH_TUI','ORCH_APPROVAL','ORCH_SANDBOX','NODE_TEST_CONTEXT'])delete env[key];
const children=[];
function launch(args,label){
 const child=spawn(process.execPath,[entry,...args],{cwd:workspace,env,windowsHide:true});let output='';
 for(const pipe of [child.stdout,child.stderr])pipe.on('data',b=>{output+=b.toString();process.stdout.write('['+label+'] '+b);});
 const done=new Promise(resolve=>{child.on('exit',code=>resolve(code));child.on('error',e=>resolve(String(e)));});
 const run={child,done,output:()=>output,identity:null,identityState:null,label};
 children.push(run);
 return run;
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const capture=async(run,label,timeoutMs=30000)=>{
 const result=await captureProcessIdentity(run.child.pid,{snapshot:processSnapshot,sleep:pause,timeoutMs,isStopped:()=>run.child.exitCode!==null});
 run.identityState=result;
 if(result.state==='live')run.identity=result.identity;
 else run.identity=null;
 if(result.state!=='live')console.error('[identity] '+label+': '+(result.reason||result.state));
 return result;
};
async function until(fn,label,ms=240000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await pause(500);}throw new Error('Timed out: '+label);}
const read=()=>{try{return JSON.parse(fs.readFileSync(summaryFile,'utf8'));}catch{return null;}};
// The barrier task is T002 (project B): its block's launcher must stay alive
// across the controller kill. (Project A's launcher can legally be in its
// self-close grace already, so never capture "any live block" — it races.)
const barrierLauncher=sum=>{
 const block=(sum?.blocks||[]).find(b=>b.taskIds.includes('T002'));
 const e=block&&sum.results[block.key];
 return e?.launcher&&sameProcess(e.launcher,processSnapshot().get(e.launcher.ProcessId))?e.launcher:null;
};
let first,second,originalLauncher,report;
console.log(JSON.stringify({root,runId,entry,agent}));
try {
 first=launch(['--run-windows',request],'first');
 await until(()=>fs.existsSync(summaryFile)||first.child.exitCode!==null,'run ledger created (or engine exited early)',180000);
 const firstIdentity=await capture(first,'first controller');
 if(firstIdentity.state!=='live')throw new Error('first controller identity unavailable: '+(firstIdentity.reason||firstIdentity.state));
 if(!fs.existsSync(summaryFile))throw new Error('Engine exited before creating the run (planning/policy): '+first.output().slice(-600));
 // Wait until T001 is checkpoint-completed (so the resume verifies it without
 // re-execution) and T002 sits on the barrier inside a live, adoptable window.
 await until(()=>{
  const s=read(),b=s?.results?.B1,a=b?.attempts?.[0];
  if(!a||!fs.existsSync(path.join(dirA,'resultA.json'))||!fs.existsSync(path.join(root,'waiting')))return false;
  const cp=path.join(path.dirname(a.file),'checkpoints','T001.json');
  if(!fs.existsSync(cp)||JSON.parse(fs.readFileSync(cp,'utf8')).state!=='completed')return false;
  return !!barrierLauncher(s);
 },'project A checkpointed and project B waiting with a live window');
 const before=read();assert.equal(before.blocks.length,2);
 originalLauncher=barrierLauncher(before);
 assert.ok(originalLauncher,'a live block window exists');
 const firstController=inspectProcess(first.identity,()=>processSnapshot());
 if(firstController.state!=='live')throw new Error('first controller identity changed before crash injection: '+(firstController.reason||firstController.state));
 killTree(firstController.pid);await first.done;
 // Manual recovery: this test relaunches --resume-run itself. With the guardian
 // disabled, nothing else can claim the run first.
 second=launch(['--resume-run',runId],'resume');
 const secondIdentity=await capture(second,'manual resume controller');
 if(secondIdentity.state!=='live')throw new Error('manual resume controller identity unavailable: '+(secondIdentity.reason||secondIdentity.state));
 await until(()=>/adopting live B2/.test(second.output()),'adoption without relaunch',120000);
 assert.ok(sameProcess(originalLauncher,processSnapshot().get(originalLauncher.ProcessId)));
 assert.ok(!fs.existsSync(guardianFile),'guardian stayed disabled; recovery is manual-only');
 fs.writeFileSync(path.join(root,'release'),'continue');
 await until(()=>second.child.exitCode!==null,'resumed completion');
 const exitCode=await second.done,after=read();
 assert.equal(exitCode,0,second.output());assert.equal(after.success,true);
 assert.equal(after.generation,2);
 const attempts=Object.values(after.results).map(e=>e.attempts.length);
 assert.deepEqual(attempts.sort(),[1,1]);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dirA,'resultA.json'),'utf8')).count,1);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dirB,'resultB.json'),'utf8')).done,true);
 assert.ok(!sameProcess(originalLauncher,processSnapshot().get(originalLauncher.ProcessId)));
 assert.equal((first.output()+second.output()).match(new RegExp('spawned visible '+agent+' TUI','g'))?.length,2);
 assert.equal(coreHash(),hashBefore);
 report={passed:true,runId,entry,workspace,root,agent,coreVersion:after.version,coreHash:hashBefore,coreUnchanged:true,generation:after.generation,windowLaunches:2,attempts,firstTaskExecutions:1,controllerCrashInjected:true,guardianAutoResume:false,manualResume:true,adoptedSameLauncher:true,closed:true,summary:after};
}catch(error){report={passed:false,runId,entry,workspace,root,agent,error:String(error),summary:read()};process.exitCode=1;}
finally {
 let salvage={started:false},cleanup={state:'not-run'};
 try {
  fs.writeFileSync(path.join(root,'release'),'continue');
  fs.writeFileSync(path.join(root,'first.log'),first?.output()||'');
  fs.writeFileSync(path.join(root,'resume.log'),second?.output()||'');
  const readWindowRecords=()=>{
   const file=path.join(stateDir,'orchestrator-windows.json');
   const parsed=readJsonDiagnostic(file,{label:'orchestrator-windows.json'});
   const diagnostics=[];
   let records=[];
   if(parsed.kind==='missing')records=[];
   else if(!parsed.ok||!Array.isArray(parsed.value))diagnostics.push(parsed.message||'orchestrator-windows.json is invalid');
   else records=parsed.value;
   const sum=read();
   for(const [index,value] of Object.values(sum?.results||{}).entries())if(value?.launcher&&Number(value.launcher.ProcessId)>0)
    if(!records.some(r=>sameProcess(r?.identity,value.launcher)))records.push({runId,title:'summary-launcher-'+index,identity:value.launcher});
   return {records,diagnostics};
  };
  const owned=controllers=>{
   const registry=readWindowRecords();
   const found=collectOwnedProcessTargets({controllers,runId,windows:registry.records},()=>processSnapshot());
   return {...found,diagnostics:[...registry.diagnostics,...found.diagnostics],state:registry.diagnostics.length?'unknown':found.state};
  };
  const stateOf=run=>!run?{state:'clean'}:run.identity
   ?inspectProcess(run.identity,()=>processSnapshot())
   :{state:'unknown',reason:run.label+' identity was not captured'};
  const firstState=stateOf(first),secondState=stateOf(second);
  if(!report?.passed&&fs.existsSync(summaryFile)&&!read()?.finishedAt) {
   if(firstState.state==='live')salvage={started:false,skipped:'first-controller-active'};
   else if(firstState.state==='unknown'||firstState.state==='mismatch')salvage={started:false,skipped:'first-controller-identity-'+firstState.state,diagnostic:firstState.reason};
   else if(secondState.state==='live')salvage={started:false,skipped:'manual-resume-active'};
   else if(secondState.state==='unknown'||secondState.state==='mismatch')salvage={started:false,skipped:'manual-resume-identity-'+secondState.state,diagnostic:secondState.reason};
   else {
    const child=launch(['--resume-run',runId],'salvage');
    const identity=await capture(child,'salvage controller',10000);
    const outcome=await Promise.race([child.done.then(code=>({finished:true,code})),pause(180000).then(()=>({finished:false,code:null}))]);
    let forced=false,cleanupState=identity.state;
    if(!outcome.finished){
     if(identity.state==='live'){
      const current=inspectProcess(identity.identity,()=>processSnapshot());
      if(current.state==='live'){killTree(current.pid);forced=true;cleanupState='killed-after-identity-check';}
      else cleanupState='identity-'+current.state;
     } else cleanupState='identity-'+identity.state;
     await Promise.race([child.done,pause(5000)]);
    }
    salvage={started:true,finished:outcome.finished,exitCode:outcome.code,childPid:child.child.pid,forced,cleanupState};
   }
  } else if(!report?.passed)salvage={started:false,skipped:'summary-finished-or-missing'};
  const controllers=controllerRecords(children);
  const before=owned(controllers),killed=[];
  for(const target of before.targets||[]){killTree(target.pid);killed.push({label:target.label,pid:target.pid});}
  let after=before;
  const end=Date.now()+10000;
  while(killed.length&&Date.now()<end){
   await pause(250);after=owned(controllers);
   if(after.state==='clean'||after.state==='unknown'||after.state==='mismatch')break;
  }
  cleanup={state:after.state,killed,diagnostics:after.diagnostics};
  report.salvage=salvage;report.cleanup=cleanup;
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));
 } catch(error) {
  report=report||{passed:false,runId,entry,workspace,root,agent};
  report.salvage=salvage;report.cleanup={state:'unknown',error:String(error)};
  try{fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));}catch{}
 }
 console.log('[result] '+JSON.stringify({passed:report?.passed,root,error:report?.error,salvage,cleanup}));
 // Never kill a shared terminal host. Failed tests leave identifiable evidence for the parent to reconcile.
}
