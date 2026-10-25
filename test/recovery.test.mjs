import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';
import {powershellExe} from '../scripts/core/contracts.mjs';
import {CODEX_CLI_SKIP} from './helpers/external.mjs';
const runner=await import('../scripts/core/runner.mjs');
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
fs.mkdirSync(family,{recursive:true});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('a dependent starts after its own prerequisite, while unrelated work remains running',async()=>{
 assert.equal(typeof runner.scheduleReady,'function');
 const events=[],recs=[{key:'A',dependsOn:[]},{key:'B',dependsOn:[]},{key:'C',dependsOn:['A']}];
 const statuses={};let finishB;const bDone=new Promise(r=>finishB=r);
 const work=runner.scheduleReady(recs,async r=>{events.push('start-'+r.key);if(r.key==='B')await bDone;if(r.key==='A')await pause(10);statuses[r.key]='verified';events.push('end-'+r.key);},key=>statuses[key]);
 try{await pause(60);const endA=events.indexOf('end-A'),startC=events.indexOf('start-C');assert.ok(endA>=0,'A must finish before its dependent can start: '+events.join(','));assert.ok(startC>endA,'C must start after A finishes: '+events.join(','));assert.ok(!events.includes('end-B'));}finally{finishB();await work;}
});
test('recovery rechecks partial work and never repeats verified or uncertain side effects',()=>{
 assert.equal(typeof runner.recoveryTasks,'function');
 fs.mkdirSync(family,{recursive:true});const dir=fs.mkdtempSync(path.join(family,'resume-ledger-'));
 try{
  fs.writeFileSync(path.join(dir,'one.json'),JSON.stringify({count:1}));
  const tasks=['T1','T2','T3','T4'].map(id=>({id,prompt:id}));
  const checkpoints={T1:{state:'completed'},T2:{state:'started'},T4:{state:'started'}};
  const checks={T1:[{type:'json',path:'one.json',equals:{count:1}}],T2:[{type:'file',path:'missing'}],T4:{checks:[{type:'file',path:'missing'}],retrySafe:true}};
  const result=runner.recoveryTasks(tasks,checkpoints,checks,dir);
  assert.deepEqual(result.verified,['T1']);assert.deepEqual(result.pending,['T3','T4']);assert.deepEqual(result.uncertain,['T2']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('new launcher preserves a failed CLI exit and never blindly repeats the prompt',{skip:CODEX_CLI_SKIP},async()=>{
 process.env.ORCH_AGENT='codex';const sdk=await import('../scripts/orchestrate-sdk.mjs');
 const la=sdk.writeInteractiveLauncher('recovery-contract','read-only probe','test-'+process.pid);
 const dir=fs.mkdtempSync(path.join(family,'failed-cli-')),counter=path.join(dir,'count'),fake=path.join(dir,'fake.ps1');
 const lit=s=>"'"+s.replaceAll("'","''")+"'";
 try{
  fs.writeFileSync(fake,`Add-Content -LiteralPath ${lit(counter)} -Value called\nexit 23`);
  const psExe=powershellExe().replaceAll('\\','/');
  const text=fs.readFileSync(la.lp,'utf8').replace(/^    & '[^\r\n]+' @agentArgs$/m,`    & '${psExe}' -NoProfile -File ${lit(fake)}`);
  fs.writeFileSync(la.lp,text);
  const result=spawnSync(powershellExe(),['-NoProfile','-File',la.lp],{windowsHide:true,encoding:'utf8',timeout:30000,env:{...process.env,ORCH_SESSION_DIR:dir,ORCH_SDIR:dir}});
  assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(counter,'utf8').trim(),'called');
  assert.equal(JSON.parse(fs.readFileSync(la.rf,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/)[0]).__EXIT__,23);
 }finally{for(const p of [...Object.values(la),la.rf+'.self-closed',la.pidf+'.self-closed'])if(typeof p==='string'&&fs.existsSync(p))fs.rmSync(p,{force:true});fs.rmSync(dir,{recursive:true,force:true});}
});

test('failed prerequisites block only their own dependents',async()=>{
 const statuses={},executed=[],blocked=[];
 await runner.scheduleReady([{key:'A',dependsOn:[]},{key:'B',dependsOn:[]},{key:'C',dependsOn:['A']}],async r=>{executed.push(r.key);statuses[r.key]=r.key==='A'?'failed':'verified';},k=>statuses[k],r=>blocked.push(r.key));
 assert.deepEqual(executed.sort(),['A','B']);assert.deepEqual(blocked,['C']);
});

test('a saved verified checkpoint is rechecked if its separate file is missing',()=>{
 const dir=fs.mkdtempSync(path.join(family,'saved-checkpoint-'));
 try{
  fs.writeFileSync(path.join(dir,'result.json'),'{"count":1}');
  const sum={runId:'r',blocks:[{key:'B1',taskIds:['T1']}],results:{B1:{endedAt:1,attempts:[]}},taskResults:{T1:{status:'verified',checkpoint:{state:'completed'}}}};
  runner.collectVerification(sum,{T1:[{type:'json',path:'result.json',equals:{count:1}}]},dir);
  assert.equal(sum.taskResults.T1.status,'verified');
  fs.writeFileSync(path.join(dir,'result.json'),'{"count":2}');
  runner.collectVerification(sum,{T1:[{type:'json',path:'result.json',equals:{count:1}}]},dir);
  assert.equal(sum.taskResults.T1.status,'failed');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('failed rechecks preserve execution evidence so a later resume cannot repeat an uncertain task',()=>{
 const dir=fs.mkdtempSync(path.join(family,'checkpoint-evidence-'));
 try{
  const sum={runId:'r',blocks:[{key:'B1',taskIds:['T1']}],results:{B1:{endedAt:1,attempts:[]}},taskResults:{T1:{status:'verified',checkpoint:{state:'started'}}}};
  const checks={T1:[{type:'file',path:'missing'}]};
  runner.collectVerification(sum,checks,dir);
  assert.equal(sum.taskResults.T1.checkpoint?.state,'started');
  runner.collectVerification(sum,checks,dir);
  assert.equal(sum.taskResults.T1.status,'needs-reconciliation');
  const recovery=runner.recoveryTasks([{id:'T1'}],{T1:sum.taskResults.T1.checkpoint},checks,dir);
  assert.deepEqual(recovery.pending,[]);assert.deepEqual(recovery.uncertain,['T1']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

// 满载假阴性回归（2026-10-24 实测 runId 6f7b8f2e…）：launcher 未退时块被记为 failed 且不写 endedAt，
// 而 checkpoint 已是 completed、产物已落盘。旧口径按 `!endedAt` 整块跳过 ⇒ --verify-run 永远拿不到它。
test('a failed block without endedAt is verified from its attempt checkpoint and artifact',()=>{
 const dir=fs.mkdtempSync(path.join(family,'launcher-alive-'));
 try{
  const runId='run-launcher-alive',token='tok-B2-a1';
  const attempt={file:path.join(dir,'attempts','B2','1','attempt.json'),runId,token,number:1,taskIds:['T2'],createdAt:1};
  fs.mkdirSync(path.dirname(attempt.file),{recursive:true});
  fs.writeFileSync(attempt.file,JSON.stringify(attempt));
  const cpFile=path.join(path.dirname(attempt.file),'checkpoints','T2.json');
  fs.mkdirSync(path.dirname(cpFile),{recursive:true});
  fs.writeFileSync(cpFile,JSON.stringify({id:'T2',runId,token,state:'completed',startedAt:1,updatedAt:2}));
  fs.writeFileSync(path.join(dir,'c2.txt'),'artifact');
  const checks={T2:[{type:'file',path:'c2.txt'}]};
  const sum={runId,blocks:[{key:'B2',taskIds:['T2']}],results:{B2:{status:'failed',reason:'Launcher still alive; lease retained',attempts:[attempt]}},taskResults:{T2:{status:'pending'}}};
  runner.collectVerification(sum,checks,dir);
  assert.equal(sum.taskResults.T2.status,'verified');
  assert.equal(sum.results.B2.status,'verified');
  // 同样的账本、产物缺失 ⇒ 盘上证据不足，仍判 failed（不能让缺 endedAt 变成免检通道）。
  fs.rmSync(path.join(dir,'c2.txt'));
  runner.collectVerification(sum,checks,dir);
  assert.equal(sum.results.B2.status,'failed');
  assert.match(String(sum.taskResults.T2.reason),/Acceptance file missing/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a block that was never attempted is still skipped when endedAt is missing',()=>{
 const sum={runId:'r',blocks:[{key:'B1',taskIds:['T1']}],results:{B1:{status:'failed',attempts:[]}},taskResults:{T1:{status:'pending'}}};
 runner.collectVerification(sum,{T1:[{type:'file',path:'missing'}]},process.cwd());
 assert.equal(sum.results.B1.status,'failed');
 assert.equal(sum.taskResults.T1.status,'pending');
 assert.equal('endedAt' in sum.results.B1,false);
});

// F8（2026-10-25）：规划失败不得留下半成品 run 目录。
// 原顺序是 mkdir → 写 manifest → loadChecks → plan：plan 抛错就留下「有 manifest.json、
// 无 summary.json」的目录，同 runId 重跑报 `Run ID already exists`，而 --verify-run 报
// `Run not found` —— runId 被烧掉且盘上没有任何账本可查。
test('a planning failure leaves no partial run directory and the runId stays reusable (F8)',async()=>{
 fs.mkdirSync(family,{recursive:true});
 const workspace=fs.mkdtempSync(path.join(family,'no-partial-')),coordinator=path.join(workspace,'temp','coordinator');
 const acceptance=path.join(workspace,'acceptance.json');
 fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'file',path:'done.txt'}]}));
 const runDir=path.join(workspace,'temp','orchestrator','runs','never-created');
 const {hooks,children}=realUnitHooks({workspace,coordinator});
 let error;
 try{
  hooks.plan=async()=>{throw new Error('planner exploded');};
  try{await runner.runWindows('执行甲',hooks,{workspace,capacity:8,runId:'never-created',acceptanceFile:acceptance,auth:'test',coordinator,maxAttempts:1});}
  catch(e){error=e;}
  assert.match(String(error&&error.message),/planner exploded/,'the planning error must propagate');
  assert.equal(fs.existsSync(runDir),false,'a failed plan must not leave a half-built run directory');
  // runId 仍可用：换回正常 plan 再跑一次，应当建账成功（这正是原来被烧掉的能力）。
  hooks.plan=async()=>[{title:'solo',type:'parallel',tasks:[{prompt:'执行甲'}]}];
  const sum=await runner.runWindows('执行甲',hooks,{workspace,capacity:8,runId:'never-created',acceptanceFile:acceptance,auth:'test',coordinator,maxAttempts:1});
  assert.equal(sum.success,true,'the same runId must still be usable after a planning failure');
 }finally{
  for(const c of children)if(c.exitCode===null)try{c.kill();}catch{}
  try{fs.rmSync(workspace,{recursive:true,force:true});}catch{}
 }
});

// —— 状态收口回归（2026-10-24）：F1 收尾隔离 / F2 终态 endedAt / F3 收尾重算 / F4 verified 优先 ——
const psLit=s=>"'" + String(s).replaceAll("'","''") + "'";
// 真实路径的假单元：真 pwsh 起一个 worker（写 started/completed 检查点与产物，再停 2.5s 才退），
// 这样 identity / close / waitForProcessExit 都走生产分支；故障由 faults 注入。
function realUnitHooks({workspace,coordinator,faults={},waitResult}){
 const worker=path.join(workspace,'worker.mjs');
 const checkpointUrl=JSON.stringify(new URL('../scripts/core/checkpoint.mjs',import.meta.url).href);
 fs.writeFileSync(worker,`import fs from 'node:fs';import path from 'node:path';import {recordCheckpoint} from ${checkpointUrl};
const [attempt,rf,root]=process.argv.slice(2),a=JSON.parse(fs.readFileSync(attempt));
while(!fs.existsSync(rf+'.go'))await new Promise(r=>setTimeout(r,20));
for(const id of a.taskIds){recordCheckpoint(attempt,id,'started');fs.writeFileSync(path.join(root,'done.txt'),'artifact');recordCheckpoint(attempt,id,'completed');}
fs.writeFileSync(rf,JSON.stringify({exitCode:0}));
await new Promise(r=>setTimeout(r,2500));`);
 const children=[];
 const hooks={
  plan:async()=>[{title:'solo',type:'parallel',tasks:[{prompt:'执行甲'}]}],
  compact:p=>p,infer:()=>[],prompt:p=>p,
  launcher:(key,prompt,suffix)=>{
   const carrier=/开始前："([^" ]+checkpoint[.]cmd)"/.exec(prompt)[1];
   const attemptFile=path.join(path.dirname(carrier),'attempt.json');
   const pidf=path.join(workspace,'window-'+suffix+'.pid'),lp=path.join(workspace,'win-launch-'+suffix+'.ps1'),rf=path.join(workspace,suffix+'.result');
   fs.writeFileSync(lp,'\ufeff'+`$PID | Set-Content -LiteralPath ${psLit(pidf)} -Encoding UTF8\n& ${psLit(process.execPath)} ${psLit(worker)} ${psLit(attemptFile)} ${psLit(rf)} ${psLit(workspace)}\nexit 0`);
   return {pidf,lp,rf};
  },
  spawn:async lp=>{children.push(spawn(powershellExe(),['-NoProfile','-File',lp],{windowsHide:true,stdio:'ignore'}));return true;},
  readPid:p=>{try{return fs.existsSync(p)?Number(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'')):0;}catch{return 0;}},
  session:async()=>'controlled',
  wait:async(_session,_timeout,rf)=>{fs.writeFileSync(rf+'.go','go');const end=Date.now()+20000;while(!fs.existsSync(rf)&&Date.now()<end)await pause(50);return waitResult||{done:fs.existsSync(rf),exitCode:0};},
  exitCode:()=>0,
  register:()=>{},commit:()=>{},
  unregister:()=>{if(faults.unregister)throw new Error('unregister hook exploded');},
  cleanup:()=>{if(faults.cleanup)throw new Error('cleanup hook exploded');},
  close:async pid=>{
   // 先等真实 launcher 退出（worker 自己会退），再按注入的故障决定 disposition。
   const end=Date.now()+15000;while(Date.now()<end){try{process.kill(pid,0);}catch{break;}await pause(50);}
   if(faults.leases){fs.mkdirSync(coordinator,{recursive:true});fs.writeFileSync(path.join(coordinator,'leases.json'),'{not json');}
   if(faults.close)throw new Error('close hook exploded');
  },
 };
 return {hooks,children};
}
async function runRealUnit({prefix,runId,faults,waitResult}){
 fs.mkdirSync(family,{recursive:true});
 const workspace=fs.mkdtempSync(path.join(family,prefix)),coordinator=path.join(workspace,'temp','coordinator');
 const acceptance=path.join(workspace,'acceptance.json');
 fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'file',path:'done.txt'}]}));
 const {hooks,children}=realUnitHooks({workspace,coordinator,faults,waitResult});
 let sum,error;
 try{sum=await runner.runWindows('执行甲',hooks,{workspace,capacity:8,runId,acceptanceFile:acceptance,auth:'test',coordinator,maxAttempts:1});}
 catch(e){error=e;}
 return {workspace,coordinator,sum,error,dispose(){for(const c of children)if(c.exitCode===null)try{c.kill();}catch{};try{fs.rmSync(workspace,{recursive:true,force:true});}catch{}}};
}

test('a throwing close/unregister/cleanup still writes endedAt, rechecks evidence, and releases the lease',async()=>{
 const run=await runRealUnit({prefix:'finalize-f1-',runId:'f1',faults:{close:true,unregister:true,cleanup:true}});
 try{
  assert.equal(run.error,undefined,String(run.error&&run.error.stack));
  const sum=run.sum,e=sum.results.B1;
  assert.equal(sum.success,true,JSON.stringify(sum.results));
  assert.equal(e.status,'verified');
  assert.ok(Number.isFinite(e.endedAt),'endedAt must be written even when close throws');
  assert.match(String(e.closeError),/close hook exploded/);
  assert.match(String(e.unregisterError),/unregister hook exploded/);
  assert.match(String(e.cleanupError),/cleanup hook exploded/);
  const onDisk=JSON.parse(fs.readFileSync(path.join(runner.runDirectory(run.workspace,'f1'),'summary.json'),'utf8'));
  assert.equal(onDisk.results.B1.status,'verified');
  assert.ok(Number.isFinite(onDisk.results.B1.endedAt),'the ledger on disk must carry endedAt');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run.coordinator,'leases.json'),'utf8')),[],'the unit lease must be released despite close throwing');
 }finally{run.dispose();}
});

test('a failing unit lease release is recorded on the block and the ledger is still finalized',async()=>{
 const run=await runRealUnit({prefix:'finalize-f1b-',runId:'f1b',faults:{close:true,leases:true}});
 try{
  // run 级 releaseRun 与单元级 release 共用同一份 coordinator 状态，所以注入损坏后两者都会失败。
  // 2026-10-25（F9）：run 级 releaseRun 失败现在只 warn、不向上抛 —— 断言 run.error 为 undefined，
  // 并继续核对账本（这正是 F9 要保住的东西）。原写法把 RegExp 当 assert.ok 的 message 传，
  // 会先抛 ERR_INVALID_ARG_TYPE（测试自身的 bug）。
  assert.equal(run.error,undefined,'a run-claim release failure must not reject the run');
  const onDisk=JSON.parse(fs.readFileSync(path.join(runner.runDirectory(run.workspace,'f1b'),'summary.json'),'utf8'));
  assert.equal(onDisk.success,true);
  assert.equal(onDisk.results.B1.status,'verified');
  assert.ok(Number.isFinite(onDisk.results.B1.endedAt),'endedAt must survive a failing release');
  assert.match(String(onDisk.results.B1.leaseReleaseError),/Invalid orchestration state/);
 }finally{run.dispose();}
});

test('terminal marks write endedAt and never downgrade a never-attempted block',async()=>{
 fs.mkdirSync(family,{recursive:true});
 const workspace=fs.mkdtempSync(path.join(family,'finalize-f2-')),coordinator=path.join(workspace,'temp','coordinator');
 const hooks={plan:async()=>[{title:'A',type:'parallel',tasks:[{prompt:'执行甲'}]},{title:'B',dependsOn:['A'],type:'parallel',tasks:[{prompt:'执行乙'}]}],
  compact:p=>p,infer:()=>[],prompt:p=>p,launcher:()=>{throw new Error('launcher boom');},spawn:async()=>false,readPid:()=>0,
  register:()=>{},unregister:()=>{},cleanup:()=>{}};
 try{
  const sum=await runner.runWindows('执行甲；执行乙',hooks,{workspace,capacity:8,runId:'f2',auth:'test',coordinator,maxAttempts:1});
  assert.equal(sum.results.B1.status,'failed');
  assert.ok(Number.isFinite(sum.results.B1.endedAt),'a failed mark must carry endedAt');
  assert.equal(sum.results.B2.status,'blocked','a never-attempted block keeps its controller status');
  assert.ok(Number.isFinite(sum.results.B2.endedAt),'a blocked mark must carry endedAt');
  assert.match(String(sum.taskResults.T001.reason),/launcher boom/,'the controller reason must survive the evidence recheck');
  assert.equal(sum.success,false);
  const onDisk=JSON.parse(fs.readFileSync(path.join(runner.runDirectory(workspace,'f2'),'summary.json'),'utf8'));
  assert.ok(Number.isFinite(onDisk.results.B2.endedAt));
  assert.equal(onDisk.results.B2.status,'blocked');
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('finalization recomputes from disk so an in-memory failed block can end verified',()=>{
 const dir=fs.mkdtempSync(path.join(family,'finalize-f3-'));
 try{
  const runId='f3',token='tok';
  const attempt={file:path.join(dir,'attempts','B1','1','attempt.json'),runId,token,number:1,taskIds:['T001'],createdAt:1};
  fs.mkdirSync(path.dirname(attempt.file),{recursive:true});
  fs.writeFileSync(attempt.file,JSON.stringify(attempt));
  const cpFile=path.join(path.dirname(attempt.file),'checkpoints','T001.json');
  fs.mkdirSync(path.dirname(cpFile),{recursive:true});
  fs.writeFileSync(cpFile,JSON.stringify({id:'T001',runId,token,state:'completed',startedAt:1,updatedAt:2}));
  fs.writeFileSync(path.join(dir,'done.txt'),'artifact');
  const sum={runId,tasks:[{id:'T001'}],blocks:[{key:'B1',taskIds:['T001']}],
   results:{B1:{status:'failed',reason:'Launcher still alive; lease retained',endedAt:1,attempts:[attempt]}},
   taskResults:{T001:{status:'failed',reason:'Acceptance file missing'}}};
  runner.finalizeRunLedger(sum,{T001:[{type:'file',path:'done.txt'}]},dir);
  assert.equal(sum.results.B1.status,'verified','finalization must adopt the on-disk evidence');
  assert.equal(sum.taskResults.T001.status,'verified');
  assert.equal(sum.success,true);
  assert.ok(Number.isFinite(sum.finishedAt));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('an adapter terminal failure never overwrites a block already re-verified from disk',async()=>{
 const run=await runRealUnit({prefix:'finalize-f4-',runId:'f4',waitResult:{done:true,exitCode:0,terminal:true,text:'Adapter preflight failed'}});
 try{
  assert.equal(run.error,undefined,String(run.error&&run.error.stack));
  assert.equal(run.sum.results.B1.status,'verified','verified evidence must win over terminalFailure');
  assert.equal(run.sum.success,true,JSON.stringify(run.sum.results));
 }finally{run.dispose();}
});


// 2026-10-25（审查 B 第 3 条，产品语义定版）：checkpoint 停在 started 时，「验收通过」不能直接采信 ——
// 很可能是上一次尝试留下的旧产物。要求 file 类产物的 mtime 晚于本次 checkpoint.startedAt，
// 否则降级为 needs-reconciliation（交给人看），而不是假 verified。
test('stale evidence predating the attempt is not accepted as this attempt\'s result',()=>{
 const ws=fs.mkdtempSync(path.join(family,'stale-'));
 try{
  assert.equal(typeof runner.staleEvidence,'function','staleEvidence must be exported for direct regression');
  const fresh=path.join(ws,'fresh.txt'),old=path.join(ws,'old.txt');
  fs.writeFileSync(fresh,'new');fs.writeFileSync(old,'old');
  const t0=Date.now();
  fs.utimesSync(old,new Date(t0-60000),new Date(t0-60000));
  const checks=[{type:'file',path:'fresh.txt'},{type:'file',path:'old.txt'},{type:'json',path:'fresh.txt',equals:{}}];
  assert.deepEqual(runner.staleEvidence(checks,ws,t0-1000),['old.txt'],'only the pre-existing file counts as stale');
  assert.deepEqual(runner.staleEvidence(checks,ws,0),[],'without a start time nothing is downgraded (never over-reject)');
  assert.deepEqual(runner.staleEvidence([{type:'file',path:'missing.txt'}],ws,t0),[],'a missing file is not "stale" (verifyChecks already fails it)');
 }finally{fs.rmSync(ws,{recursive:true,force:true});}
});


// 2026-10-25（F5 翻案）：launcher 构造失败必须计入 attempt 预算，而不是把整块直接 throw 掉。
// 第一次抛「disk full」，第二次用真实 launcher —— 期望重试成功、两条 attempt 都在账本上、第一条带 error。
test('a launcher failure is charged to the attempt budget instead of throwing the run away (F5)',async()=>{
 fs.mkdirSync(family,{recursive:true});
 const workspace=fs.mkdtempSync(path.join(family,'launcher-fail-')),coordinator=path.join(workspace,'temp','coordinator');
 const acceptance=path.join(workspace,'acceptance.json');
 fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'file',path:'done.txt'}]}));
 const {hooks,children}=realUnitHooks({workspace,coordinator});
 const realLauncher=hooks.launcher;let calls=0;
 hooks.launcher=(...args)=>{if(++calls===1)throw new Error('disk full');return realLauncher(...args);};
 try{
  const sum=await runner.runWindows('执行甲',hooks,{workspace,capacity:8,runId:'launcher-fail',acceptanceFile:acceptance,auth:'test',coordinator,maxAttempts:2});
  assert.equal(calls,2,'the launcher must be retried once within the attempt budget');
  assert.equal(sum.success,true,'the retried attempt must succeed');
  assert.equal(sum.results.B1.attempts.length,2,'both attempts stay on the ledger');
  assert.match(String(sum.results.B1.attempts[0].error),/disk full/,'the failed attempt names its cause');
  assert.ok(Number.isFinite(sum.results.B1.endedAt),'the block still gets endedAt');
 }finally{
  for(const c of children)if(c.exitCode===null)try{c.kill();}catch{}
  try{fs.rmSync(workspace,{recursive:true,force:true});}catch{}
 }
});
