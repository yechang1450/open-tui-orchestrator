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
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {processSnapshot,sameProcess} from '../scripts/core/leases.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),workspace=process.cwd();
// Default agent is kimi: codex windows (gpt-6-astra/ultra) were observed to
// stall after printing their TODO list or to run the checkpoint command via
// PowerShell despite the cmd /c hard rule — model-side flakes that would make
// this engine test nondeterministic. Override with ORCH_LIVE_AGENT=codex.
const agent=process.env.ORCH_LIVE_AGENT||'kimi';
const entry=process.env.ORCH_LIVE_ENTRY||path.join(repo,'scripts','orchestrate-sdk.mjs');
const runId='recovery-'+crypto.randomUUID(),root=path.join(workspace,'temp',runId);
const runDir=path.join(workspace,'temp','orchestrator','runs',runId);
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
const cacheFile=path.join(workspace,'temp','orchestrator','orchestrator-decompose-cache.json');
let cache={version:CORE_VERSION,entries:{}};
try{const j=JSON.parse(fs.readFileSync(cacheFile,'utf8').replace(/^\uFEFF/,''));if(j&&j.version===CORE_VERSION&&j.entries)cache=j;}catch{}
cache.entries[decomposeHash]={createdAt:Date.now(),blocks:planBlocks};
fs.mkdirSync(path.dirname(cacheFile),{recursive:true});
fs.writeFileSync(cacheFile,JSON.stringify(cache),'utf8');
// ORCH_GUARDIAN=0: no detached guardian may race the manual --resume-run below.
const env={...process.env,ORCH_AGENT:agent,ORCH_RUN_ID:runId,ORCH_ACCEPTANCE_FILE:acceptance,ORCH_MAX_POLL_MS:'600000',ORCH_GUARDIAN:'0'};
for(const key of ['WORKSPACE_DIR','ORCH_STATE_DIR','ORCH_TUI','ORCH_APPROVAL','ORCH_SANDBOX','NODE_TEST_CONTEXT'])delete env[key];
const children=[];
function launch(args,label){
 const child=spawn(process.execPath,[entry,...args],{cwd:workspace,env,windowsHide:true});let output='';children.push(child);
 for(const pipe of [child.stdout,child.stderr])pipe.on('data',b=>{output+=b.toString();process.stdout.write('['+label+'] '+b);});
 const done=new Promise(resolve=>{child.on('exit',code=>resolve(code));child.on('error',e=>resolve(String(e)));});
 return {child,done,output:()=>output};
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
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
 first.child.kill();await first.done;
 // Manual recovery: this test relaunches --resume-run itself. With the guardian
 // disabled, nothing else can claim the run first.
 second=launch(['--resume-run',runId],'resume');
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
 fs.writeFileSync(path.join(root,'release'),'continue');
 fs.writeFileSync(path.join(root,'first.log'),first?.output()||'');
 fs.writeFileSync(path.join(root,'resume.log'),second?.output()||'');
 fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));
 console.log('[result] '+JSON.stringify({passed:report.passed,root,error:report.error}));
 // If the manual resume never landed the run, salvage it so no orphan window remains.
 if(!report.passed&&fs.existsSync(summaryFile)&&!read()?.finishedAt){
  const salvage=launch(['--resume-run',runId],'salvage');
  await Promise.race([salvage.done,pause(180000)]);
 }
 // Never kill a shared terminal host. Failed tests leave identifiable evidence for the parent to reconcile.
}
