import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {main,ensureRunGuardian,parseGuardianOptions,guardianFile,readGuardianState} from '../scripts/core/run-guardian.mjs';
import {runWindows,runDirectory} from '../scripts/core/runner.mjs';
import {atomicJson} from '../scripts/core/leases.mjs';

const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
const ENGINE={ProcessId:111,Name:'node.exe',CommandLine:'node orchestrate-sdk.mjs --run-windows req',Started:'2026-09-09T00:00:00.000Z'};

function mkRun(state,summary) {
  fs.mkdirSync(family,{recursive:true});
  const workspace=fs.mkdtempSync(path.join(family,'guardian-'));
  const runId='guard-'+Math.random().toString(36).slice(2,10);
  const file=guardianFile(workspace,runId);
  if(state)atomicJson(file,{runId,guardianPid:0,restarts:0,maxRestarts:3,intervalMs:2000,timeoutMs:60000,createdAt:1_000_000,engines:[{owner:ENGINE,startedAt:1_000_000,by:'initiator'}],status:'watching',updatedAt:1_000_000,...state});
  return {workspace,runId,file,summary};
}

function mkHooks(ws,runId,opts={}) {
  const live=new Map((opts.alive??[ENGINE]).map(e=>[e.ProcessId,e]));
  const spawns=[],logs=[];
  let time=opts.startTime??1_000_000,loadCalls=0;
  const summary=opts.summary===undefined?{runId,startedAt:1_000_000,agent:'kimi'}:opts.summary;
  const hooks={
    env:{WORKSPACE_DIR:ws},
    now:()=>time,
    sleep:async ms=>{time+=ms;},
    snapshot:()=>{if(opts.failSnapshot)throw new Error('cim unavailable');return new Map(live);},
    load:()=>{if(++loadCalls>2000)throw new Error('guardian loop did not terminate');return typeof summary==='function'?summary({spawns}):summary;},
    spawn:(cmd,args,o)=>{spawns.push({cmd,args,opts:o});const pid=1000+spawns.length;const id={ProcessId:pid,Name:'node.exe',CommandLine:'node orchestrate-sdk.mjs --resume-run '+runId,Started:'s'+pid};if(opts.autoAdopt!==false)live.set(pid,id);return{pid,on(){},unref(){}};},
    log:m=>logs.push(m),
  };
  return {hooks,spawns,logs,live,now:()=>time};
}

async function runMain(ws,runId,hooks) {
  const prev=process.exitCode;
  try{await main(['--run-id',runId],hooks);return process.exitCode??0;}
  finally{process.exitCode=prev;}
}

test('guardian exits done without respawn when the run is already finalized',async()=>{
 const {workspace,runId,file}=mkRun({},null);
 try {
  const {hooks,spawns}=mkHooks(workspace,runId,{summary:{runId,finishedAt:1_000_500}});
  const code=await runMain(workspace,runId,hooks);
  assert.equal(code,0);assert.equal(spawns.length,0);
  assert.equal(readGuardianState(file).status,'done');
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('guardian waits while the engine lives and exits on finalization',async()=>{
 const {workspace,runId,file}=mkRun({},null);
 try {
  let ticks=0;const summary=()=>(++ticks>2?{runId,finishedAt:1_001_000}:{runId,startedAt:1_000_000});
  const {hooks,spawns}=mkHooks(workspace,runId,{summary});
  const code=await runMain(workspace,runId,hooks);
  assert.equal(code,0);assert.equal(spawns.length,0);
  assert.equal(readGuardianState(file).status,'done');
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('dead engine before finalization triggers exactly one guarded resume with run identity',async()=>{
 const {workspace,runId,file}=mkRun({},null);
 try {
  const summary=({spawns})=>spawns.length?{runId,finishedAt:1_020_000}:{runId,startedAt:1_000_000,agent:'kimi'};
  const {hooks,spawns}=mkHooks(workspace,runId,{summary,alive:[]});
  const code=await runMain(workspace,runId,hooks);
  assert.equal(code,0);assert.equal(spawns.length,1);
  const call=spawns[0];
  assert.equal(call.args[1],'--resume-run');assert.equal(call.args[2],runId);
  assert.equal(call.opts.cwd,workspace);assert.equal(call.opts.detached,true);assert.equal(call.opts.windowsHide,true);
  assert.equal(call.opts.env.ORCH_AGENT,'kimi');assert.equal(call.opts.env.ORCH_RUN_ID,runId);assert.equal(call.opts.env.WORKSPACE_DIR,workspace);
  assert.equal(call.opts.env.ORCH_STATE_DIR,path.join(workspace,'temp','orchestrator'));
  const state=readGuardianState(file);
  assert.equal(state.status,'done');assert.equal(state.restarts,1);
  assert.equal(state.engines.length,2);assert.equal(state.engines[1].by,'guardian');assert.equal(state.engines[1].owner.ProcessId,1001);
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('guardian resume preserves an explicitly isolated state directory',async()=>{
 const {workspace,runId}=mkRun({},null);
 const stateDir=path.join(workspace,'temp','isolated-state');
 const file=guardianFile(workspace,runId,stateDir);
 fs.rmSync(path.join(workspace,'temp'),{recursive:true,force:true});
 atomicJson(file,{runId,guardianPid:0,restarts:0,maxRestarts:1,intervalMs:2000,timeoutMs:60000,createdAt:1_000_000,engines:[{owner:ENGINE,startedAt:1_000_000,by:'initiator'}],status:'watching',updatedAt:1_000_000});
 try {
  const summary=({spawns})=>spawns.length?{runId,finishedAt:1_020_000}:{runId,startedAt:1_000_000,agent:'kimi'};
  const {hooks,spawns}=mkHooks(workspace,runId,{summary,alive:[]});
  hooks.env.ORCH_STATE_DIR=stateDir;
  const code=await runMain(workspace,runId,hooks);
  assert.equal(code,0);assert.equal(spawns.length,1);
  assert.equal(spawns[0].opts.env.ORCH_STATE_DIR,stateDir);
  assert.equal(readGuardianState(file).status,'done');
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('restart budget is fail-closed: exhausted guardian stops respawning',async()=>{
 const {workspace,runId,file}=mkRun({maxRestarts:1},null);
 try {
  const summary=()=>({runId,startedAt:1_000_000,agent:'kimi'}); // never finalizes
  const {hooks,spawns,live}=mkHooks(workspace,runId,{summary,alive:[]});
  const origSpawn=hooks.spawn;
  hooks.spawn=(...a)=>{const c=origSpawn(...a);live.delete(c.pid);return c;}; // each resumed engine dies too
  const code=await runMain(workspace,runId,hooks);
  assert.equal(code,1);assert.equal(spawns.length,1);
  assert.equal(readGuardianState(file).status,'exhausted');
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('run deadline passed: guardian does not resume a run that could only time out',async()=>{
 const {workspace,runId,file}=mkRun({},null);
 try {
  const {hooks,spawns}=mkHooks(workspace,runId,{alive:[],startTime:1_070_000}); // past createdAt+timeoutMs
  const code=await runMain(workspace,runId,hooks);
  assert.equal(code,1);assert.equal(spawns.length,0);
  assert.equal(readGuardianState(file).status,'deadline');
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('snapshot failure never respawns blind',async()=>{
 const {workspace,runId}=mkRun({},null);
 try {
  let ticks=0;const summary=()=>(++ticks>3?{runId,finishedAt:1_002_000}:{runId,startedAt:1_000_000});
  const {hooks,spawns}=mkHooks(workspace,runId,{summary,alive:[],failSnapshot:true});
  const code=await runMain(workspace,runId,hooks);
  assert.equal(code,0);assert.equal(spawns.length,0);
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('pid reuse by an unrelated process is not the engine (identity must match)',async()=>{
 const {workspace,runId,file}=mkRun({},null);
 try {
  const impostor={ProcessId:111,Name:'node.exe',CommandLine:'node other.js',Started:'else'};
  const summary=({spawns})=>spawns.length?{runId,finishedAt:1_020_000}:{runId,startedAt:1_000_000,agent:'kimi'};
  const {hooks,spawns}=mkHooks(workspace,runId,{summary,alive:[impostor]});
  const code=await runMain(workspace,runId,hooks);
  assert.equal(code,0);assert.equal(spawns.length,1);
  assert.equal(readGuardianState(file).restarts,1);
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('a lagging snapshot does not orphan the resumed engine identity (bounded grace retry)',async()=>{
 const {workspace,runId,file}=mkRun({},null);
 try{
  const summary=({spawns})=>spawns.length?{runId,finishedAt:1_020_000}:{runId,startedAt:1_000_000,agent:'kimi'};
  const {hooks,spawns,live}=mkHooks(workspace,runId,{summary,alive:[]});
  // WMI 滞后：spawn 后的前几次 snapshot 看不到新进程（旧代码单次读失手 → identity=null）。
  let misses=0;
  hooks.snapshot=()=>{const m=new Map(live);for(const pid of [...m.keys()])if(pid>=1000){if(misses++<3)m.delete(pid);}return m;};
  const code=await runMain(workspace,runId,hooks);
  assert.equal(code,0);assert.equal(spawns.length,1);
  const state=readGuardianState(file);
  assert.equal(state.engines.length,2,'the resumed engine identity must be adopted despite a lagging snapshot');
  assert.equal(state.engines[1].owner.ProcessId,1001);
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('missing state file fails closed without respawn',async()=>{
 const noState=mkRun(null,null);
 try{
  const a=mkHooks(noState.workspace,noState.runId,{});
  assert.equal(await runMain(noState.workspace,noState.runId,a.hooks),2);assert.equal(a.spawns.length,0);
 }finally{fs.rmSync(noState.workspace,{recursive:true,force:true});}
});

// summary.json 尚未落盘（引擎还在跑）不是错误：必须继续等，绝不据此 error 退出。
// 红例＝旧的二态读法（missing 与 broken 都被吞成 null ⇒ 立刻 crash-exit，留孤儿引擎）。
test('summary not yet written is waited on, not treated as an error',async()=>{
 const {workspace,runId,file}=mkRun({},null);
 try {
  let ticks=0;const summary=()=>(++ticks>3?{runId,finishedAt:1_002_000}:{kind:'missing'});
  const {hooks,spawns}=mkHooks(workspace,runId,{summary});
  const code=await runMain(workspace,runId,hooks);
  assert.equal(code,0);assert.equal(spawns.length,0);
  assert.equal(readGuardianState(file).status,'done');
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

// summary.json 存在但读不动/解析不了＝真错误：必须带原因 fail-closed。
test('a broken summary fails closed and names the reason',async()=>{
 const {workspace,runId,file}=mkRun({},null);
 try {
  const {hooks,spawns,logs}=mkHooks(workspace,runId,{summary:{kind:'broken',why:'summary.json unparsable: Unexpected token'}});
  const code=await runMain(workspace,runId,hooks);
  assert.equal(code,2);assert.equal(spawns.length,0);
  assert.equal(readGuardianState(file).status,'error');
  const line=logs.find(l=>l.includes('error'));
  assert.ok(line,'the error line must be logged');
  assert.match(line,/reason=summary\.json unparsable/);
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('parseGuardianOptions validates arguments',()=>{
 assert.deepEqual(parseGuardianOptions(['--run-id','abc']),{runId:'abc'});
 assert.throws(()=>parseGuardianOptions([]),/--run-id is required/);
 assert.throws(()=>parseGuardianOptions(['--bogus']),/GUARDIAN_ARGUMENT_INVALID/);
 assert.throws(()=>parseGuardianOptions(['--run-id','--x']),/--run-id is required/);
});

test('ensureRunGuardian is disabled by env and adopts a live guardian',()=>{
 fs.mkdirSync(family,{recursive:true});
 const workspace=fs.mkdtempSync(path.join(family,'guardian-ensure-'));
 const runId='guard-ensure';
 try {
  assert.deepEqual(ensureRunGuardian({runId,workspace,timeoutMs:60000,owner:ENGINE,agent:'kimi',env:{ORCH_GUARDIAN:'0'}}),{disabled:true});
  assert.deepEqual(ensureRunGuardian({runId,workspace,timeoutMs:60000,owner:ENGINE,agent:'kimi',env:{NODE_TEST_CONTEXT:'child-v8'}}),{disabled:true});
  const spawns=[];
  const spawnImpl=(...a)=>{spawns.push(a);return{pid:4321,on(){},unref(){}};};
  const r=ensureRunGuardian({runId,workspace,timeoutMs:120000,owner:ENGINE,agent:'kimi',env:{},spawnImpl,log:()=>{}});
  assert.equal(r.spawned,true);assert.equal(r.pid,4321);assert.equal(spawns.length,1);
  assert.equal(spawns[0][1].includes('--run-id'),true);assert.equal(spawns[0][2].detached,true);assert.equal(spawns[0][2].env.ORCH_AGENT,'kimi');
  const state=readGuardianState(guardianFile(workspace,runId));
  assert.equal(state.guardianPid,4321);assert.equal(state.maxRestarts,3);assert.equal(state.timeoutMs,120000);
  assert.equal(state.engines.length,1);assert.equal(state.engines[0].owner.ProcessId,111);
  const alive=new Map([[4321,{ProcessId:4321,Name:'node.exe',CommandLine:'node run-guardian.mjs --run-id '+runId,Started:'g'}]]);
  const again=ensureRunGuardian({runId,workspace,timeoutMs:120000,owner:ENGINE,agent:'kimi',env:{},spawnImpl,snapshotImpl:()=>alive,log:()=>{}});
  assert.deepEqual(again,{already:true,pid:4321});assert.equal(spawns.length,1);
  const dead=ensureRunGuardian({runId,workspace,timeoutMs:120000,owner:ENGINE,agent:'kimi',env:{},spawnImpl,snapshotImpl:()=>new Map(),log:()=>{}});
  assert.equal(dead.spawned,true);assert.equal(spawns.length,2); // dead guardian replaced, restart budget kept
  assert.equal(readGuardianState(guardianFile(workspace,runId)).restarts,0);
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('runWindows arms the guardian on fresh runs and again on resume, and guardian failure never fails the run',async()=>{
 fs.mkdirSync(family,{recursive:true});
 const workspace=fs.mkdtempSync(path.join(family,'guardian-runner-'));
 const calls=[];let spawnCalls=0;
 const hooks={
  plan:async()=>[{title:'A',tasks:[{prompt:'执行甲'}]}],
  compact:p=>p,infer:()=>[],prompt:p=>p,
  launcher:key=>({pidf:path.join(workspace,'window-'+key+'.pid')}),
  register:()=>{},unregister:()=>{},cleanup:()=>{},spawn:async()=>{spawnCalls++;return false;},readPid:()=>0,
  guardian:g=>{calls.push(g);throw new Error('guardian spawn exploded');},
 };
 try {
  const previousUnproductive=process.env.ORCH_UNPRODUCTIVE_RETRIES;
  process.env.ORCH_UNPRODUCTIVE_RETRIES='0';
  const sum=await runWindows('执行甲',hooks,{workspace,capacity:8,runId:'guarded',auth:'test',coordinator:path.join(workspace,'temp','coordinator'),timeoutMs:90000,maxAttempts:2});
  assert.equal(sum.success,false);assert.equal(sum.taskResults.T001.status,'failed');assert.equal(spawnCalls,2);
  assert.equal(calls.length,1);
  assert.equal(calls[0].runId,'guarded');assert.equal(calls[0].workspace,path.resolve(workspace));
  assert.equal(calls[0].timeoutMs,90000);assert.ok(calls[0].owner?.ProcessId>0);
  const resumed=await runWindows('',hooks,{workspace,capacity:8,runId:'guarded',auth:'test',coordinator:path.join(workspace,'temp','coordinator'),resume:true,agent:'codex',maxAttempts:2});
  assert.equal(resumed.generation,2);
  // 2026-10-25（F7）：resume 也调 guardian —— 原写法假设「原 guardian 还在看」，但它可能已 exhausted
  // 或被杀，那样账本会永停在「无 finishedAt」，--verify-run 永远报 Run is not finalized（run
  // ea010891 就是这么卡住的）。ensureRunGuardian 自带 already 幂等短路，原 guardian 在时是 no-op。
  assert.equal(calls.length,2,'resume must re-arm the guardian (idempotent inside ensureRunGuardian)');
  assert.equal(calls[1].runId,'guarded');
  assert.equal(calls[1].workspace,path.resolve(workspace));
  if(previousUnproductive===undefined)delete process.env.ORCH_UNPRODUCTIVE_RETRIES;else process.env.ORCH_UNPRODUCTIVE_RETRIES=previousUnproductive;
 }finally{await new Promise(r=>setTimeout(r,500));fs.rmSync(workspace,{recursive:true,force:true});}
});
