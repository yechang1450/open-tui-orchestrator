import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('nine independent parent processes contend for eight shared slots without lost updates',async()=>{
 fs.mkdirSync(family,{recursive:true});const dir=fs.mkdtempSync(path.join(family,'cross-process-'));
 const module=new URL('../scripts/core/leases.mjs',import.meta.url).href;
 const worker=path.join(dir,'worker.mjs');
 fs.writeFileSync(worker,`import fs from 'node:fs';import path from 'node:path';import {reserve,release} from ${JSON.stringify(module)};
 const dir=process.argv[2],id=process.argv[3];
 try{const result=reserve(dir,{id,runId:id,keys:['test:'+id]},8);fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify(result));
 while(!fs.existsSync(path.join(dir,'release')))await new Promise(r=>setTimeout(r,50));
 if(result.ok)release(dir,id);
 }catch(e){fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({error:e.message}));process.exitCode=1;}`);
 const children=Array.from({length:9},(_,i)=>spawn(process.execPath,[worker,dir,'run'+i],{windowsHide:true,stdio:'ignore'}));
 const exits=children.map(c=>new Promise(resolve=>{c.once('exit',resolve);c.once('error',()=>resolve(-1));}));
 try{
  const deadline=Date.now()+60000;
  while(children.some((_,i)=>!fs.existsSync(path.join(dir,'run'+i+'.json')))&&Date.now()<deadline)await pause(100);
  const results=children.map((_,i)=>JSON.parse(fs.readFileSync(path.join(dir,'run'+i+'.json'),'utf8')));
  assert.equal(results.filter(r=>r.ok).length,8,JSON.stringify(results));
  assert.equal(results.filter(r=>r.reason==='capacity').length,1,JSON.stringify(results));
  const leases=JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8'));
  assert.equal(new Set(leases.map(l=>l.runId)).size,8);
 }finally{
  fs.writeFileSync(path.join(dir,'release'),'release');
  await Promise.all(exits);
  await pause(500);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

// Regression: a test run once pinned the machine-wide HKCU locator to a deleted
// mkdtemp fixture, hijacking the coordinator of every later real workspace run.
test('coordinatorDir never touches the machine-wide locator under the test runner',async()=>{
 const {coordinatorDir}=await import('../scripts/core/leases.mjs');
 const workspace=path.join(family,'locator-guard');
 const fallback=path.join(workspace,'temp','orchestrator','coordinator');
 assert.equal(coordinatorDir(workspace,{NODE_TEST_CONTEXT:process.env.NODE_TEST_CONTEXT||'child-v8'}),fallback);
 assert.equal(coordinatorDir(workspace,{NODE_TEST_CONTEXT:'child-v8',ORCH_COORDINATOR_DIR:'custom-coordinator'}),path.join(workspace,'custom-coordinator'));
});

// ---- 协调器互斥：旋钮 + 锁票回收（2026-09-14）----
// 满负载假失败的根因有二：PS 侧等待写死 20s、JS 侧即使子进程已死也要干等满 30s；另外被强杀的
// PS 跑不到自己的清理，锁票会在协调器目录无界堆积（实测 576 个）。以下判据都可红：
// 回到写死等待＝第一条超时；去掉重试＝第二条失败；去掉按龄回收＝第三条 stale 收不掉 / fresh 被误收。
const {randomUUID}=await import('node:crypto');
const {processSnapshot,transaction,sweepStaleMutexTickets,launcherIdentity,claimRun}=await import('../scripts/core/leases.mjs');
const {powershellExe}=await import('../scripts/core/contracts.mjs');
const leaseLock=fileURLToPath(new URL('../scripts/core/lease-lock.ps1',import.meta.url));
// 一次快照全文件共用：processSnapshot 是一次 PowerShell CIM 全表查询（满载下几秒），
// 每个用例各来一次会把套件整体负载推高、连累其它时序敏感文件（2026-09-14 实测）。
const OWNER_ONCE=processSnapshot().get(process.pid);

test('launcherIdentity returns null for an unpublished pid without doing a process snapshot',{skip:process.platform!=='win32'},()=>{
 const previous=process.env.ORCH_PS_TIMEOUT_MS;
 process.env.ORCH_PS_TIMEOUT_MS='1';
 try{
  const pidFile=path.join(family,'identity-invalid','window-B1.pid');
  assert.equal(launcherIdentity(0,pidFile),null);
 }finally{
  if(previous===undefined)delete process.env.ORCH_PS_TIMEOUT_MS;else process.env.ORCH_PS_TIMEOUT_MS=previous;
 }
});

async function holdCoordinatorMutex(dir){
 const owner=OWNER_ONCE;
 const ticket=path.join(dir,'lock-'+randomUUID());
 const child=spawn(powershellExe(),['-NoProfile','-File',leaseLock,'-Directory',dir,'-Ticket',ticket,'-Owner',String(owner.ProcessId),'-Started',owner.Started],{windowsHide:true,stdio:'ignore'});
 const exited=new Promise(r=>child.once('exit',r));
 const deadline=Date.now()+30000;
 while(!fs.existsSync(ticket+'.ready')&&Date.now()<deadline)await pause(50);
 if(!fs.existsSync(ticket+'.ready')){
  // 超时不是“调用方 finally 会清”——holder 在调用方 try 之外 spawn，这里必须自己收口：
  // kill 后等退出再抛，否则已持有的协调器互斥与锁票被后续用例继承、进程超出套件寿命。
  try{child.kill();}catch{/* already gone */}
  await exited;
  assert.fail('fixture failed to acquire the coordinator mutex');
 }
 return {
  release:()=>fs.writeFileSync(ticket+'.release','release'),
  // 放锁必须由**独立进程**在指定时刻做：transaction 的等待是同步阻塞的，本进程的 setTimeout
  // 在阻塞期间根本不会触发（这一坑测试自己踩过一次）。
  releaseLater:ms=>spawn(process.execPath,['-e',`setTimeout(()=>{try{require('fs').writeFileSync(${JSON.stringify(ticket+'.release')},'release')}catch{}},${ms})`],{windowsHide:true,stdio:'ignore'}).unref(),
  exited,
 };
}
const winOnly={skip:process.platform==='win32'?false:'coordinator mutex is Windows-only'};

test('a held coordinator mutex fails on the tuned wait instead of a hard-coded 20s',winOnly,async()=>{
 fs.mkdirSync(family,{recursive:true});const dir=fs.mkdtempSync(path.join(family,'mutex-knob-'));
 const holder=await holdCoordinatorMutex(dir);
 try{
  process.env.ORCH_MUTEX_WAIT_MS='1200';process.env.ORCH_MUTEX_RETRIES='0';
  const started=Date.now();
  let error=null;try{transaction(dir,()=>({ok:true}));}catch(e){error=e;}
  const elapsed=Date.now()-started;
  assert.ok(error,'a held mutex must fail the transaction');
  assert.match(error.message,/Coordinator mutex acquisition failed/);
  assert.match(error.message,/ORCH_MUTEX_WAIT_MS/);
  assert.ok(elapsed<15000,'must fail on the tuned wait, not a hard-coded 20s (took '+elapsed+'ms)');
 }finally{
  delete process.env.ORCH_MUTEX_WAIT_MS;delete process.env.ORCH_MUTEX_RETRIES;
  holder.release();await holder.exited;
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('mutex retries absorb transient contention instead of a false failure',winOnly,async()=>{
 fs.mkdirSync(family,{recursive:true});const dir=fs.mkdtempSync(path.join(family,'mutex-retry-'));
 const holder=await holdCoordinatorMutex(dir);
 try{
  process.env.ORCH_MUTEX_WAIT_MS='1200';process.env.ORCH_MUTEX_RETRIES='6';
  holder.releaseLater(3000);
  const result=transaction(dir,()=>({ok:true}));
  assert.deepEqual(result,{ok:true},'a transient hold must be waited out by retries');
 }finally{
  delete process.env.ORCH_MUTEX_WAIT_MS;delete process.env.ORCH_MUTEX_RETRIES;
  holder.release();await holder.exited;
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('stale mutex tickets are reclaimed by age while fresh ones survive',()=>{
 fs.mkdirSync(family,{recursive:true});const dir=fs.mkdtempSync(path.join(family,'mutex-tickets-'));
 try{
  const staleReady=path.join(dir,'lock-'+randomUUID()+'.ready');
  const staleRelease=path.join(dir,'lock-'+randomUUID()+'.release');
  const fresh=path.join(dir,'lock-'+randomUUID()+'.ready');
  const unrelated=path.join(dir,'leases.json');
  for(const f of [staleReady,staleRelease,fresh,unrelated])fs.writeFileSync(f,'x');
  const old=(Date.now()-20*60*1000)/1000;
  fs.utimesSync(staleReady,old,old);fs.utimesSync(staleRelease,old,old);
  assert.equal(sweepStaleMutexTickets(dir),2,'both aged tickets must be reclaimed');
  assert.ok(fs.existsSync(fresh),'a fresh ticket must survive the sweep');
  assert.ok(fs.existsSync(unrelated),'non-ticket files must never be touched');
  // 用显式前拨的时钟：Windows 文件时间戳粒度（ms/15ms 取整）会让"刚写入的票"偶发地比 Date.now() 晚，
  // 裸测 ttlMs:0 就成了毫秒级竞速（2026-09-17 实捉一次假红）。契约本身支持注入 now，就用它。
  assert.equal(sweepStaleMutexTickets(dir,{ttlMs:0,now:Date.now()+60000}),1,'an explicit ttl reclaims the fresh ticket too');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a completed transaction leaves no mutex ticket files behind',winOnly,async()=>{
  fs.mkdirSync(family,{recursive:true});const dir=fs.mkdtempSync(path.join(family,'mutex-hygiene-'));
  try{
   await transaction(dir,()=>({ok:true}));
   const deadline=Date.now()+5000;
   while(fs.readdirSync(dir).some(n=>/^lock-/.test(n))&&Date.now()<deadline)await pause(50);
   assert.deepEqual(fs.readdirSync(dir).filter(n=>/^lock-/.test(n)),[],'tickets must be reclaimed, not leaked');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

// 现象（2026-09-22）：PS 侧等超时后自己收场，JS 侧却看不到任何信号，只能干等满 waitMs+2500 才重试
// ——满载套件里几十处 "waited 60000ms x3" 假红、单条用例 189s，而真因（这一轮其实是 busy-timeout）
// 完全不可见。现在 PS 把结论写进状态票，JS 立刻失败并把它写进错误行；失败路径同样不留票。
test('a failed acquisition reports the PS-side reason and still reclaims its tickets',winOnly,async()=>{
  fs.mkdirSync(family,{recursive:true});const dir=fs.mkdtempSync(path.join(family,'mutex-reason-'));
  const holder=await holdCoordinatorMutex(dir);
  try{
   process.env.ORCH_MUTEX_WAIT_MS='1200';process.env.ORCH_MUTEX_RETRIES='0';
   let error=null;try{transaction(dir,()=>({ok:true}));}catch(e){error=e;}
   assert.ok(error,'a held mutex must fail the transaction');
   assert.match(error.message,/Coordinator mutex acquisition failed/);
   assert.match(error.message,/busy-timeout/,'the error must carry the PS-side verdict, not just the wait budget');
  }finally{
   delete process.env.ORCH_MUTEX_WAIT_MS;delete process.env.ORCH_MUTEX_RETRIES;
   holder.release();await holder.exited;
   const deadline=Date.now()+8000;
   while(fs.readdirSync(dir).some(n=>/^lock-/.test(n))&&Date.now()<deadline)await pause(50);
   assert.deepEqual(fs.readdirSync(dir).filter(n=>/^lock-/.test(n)),[],'a failed acquisition must still reclaim its tickets');
   fs.rmSync(dir,{recursive:true,force:true});
  }
});

// 入口即回收：解析协调器目录时顺带按龄回收，保证「空闲时也不会长期积压」——被强杀的 PS 跑不到
// 自己的清理，旧实现只能等下一次事务才收（红＝把 coordinatorDir 里的回收去掉）。
test('resolving the coordinator directory reclaims aged tickets',async()=>{
 const {coordinatorDir}=await import('../scripts/core/leases.mjs');
 fs.mkdirSync(family,{recursive:true});const workspace=fs.mkdtempSync(path.join(family,'coord-sweep-'));
 try{
  const coord=path.join(workspace,'temp','orchestrator','coordinator');
  fs.mkdirSync(coord,{recursive:true});
  const stale=path.join(coord,'lock-'+randomUUID()+'.ready');
  const fresh=path.join(coord,'lock-'+randomUUID()+'.ready');
  const leases=path.join(coord,'leases.json');
  for(const f of [stale,fresh,leases])fs.writeFileSync(f,'x');
  const old=(Date.now()-20*60*1000)/1000;
  fs.utimesSync(stale,old,old);
  assert.equal(coordinatorDir(workspace,{NODE_TEST_CONTEXT:'child-v8'}),coord);
  assert.ok(!fs.existsSync(stale),'aged tickets must be reclaimed when the coordinator directory is resolved');
  assert.ok(fs.existsSync(fresh),'a fresh ticket must survive entry housekeeping');
  assert.ok(fs.existsSync(leases),'leases.json must never be touched');
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});


test("claimRun preserves an owner that appears after the pre-lock snapshot", {skip: process.platform !== "win32", timeout: 120000}, async () => {
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, "snapshot-lock-barrier-"));
  const nodeExe = "C:/Program Files/nodejs/node.exe";
  const moduleUrl = new URL("../scripts/core/leases.mjs", import.meta.url).href;
  const aWorker = path.join(dir, "claim-a.mjs");
  const bWorker = path.join(dir, "claim-b.mjs");
  const aReady = path.join(dir, "a-ready");
  const bClaimed = path.join(dir, "b-claimed");
  const aClaimed = path.join(dir, "a-claimed");
  const bDone = path.join(dir, "b-done");
  const waitFor = async (file, ms = 30000) => {
    const end = Date.now() + ms;
    while (!fs.existsSync(file) && Date.now() < end) await pause(100);
    assert.ok(fs.existsSync(file), "timed out waiting for " + file);
  };
  fs.writeFileSync(aWorker, [
    "import fs from \"node:fs\";",
    "import {claimRun} from " + JSON.stringify(moduleUrl) + ";",
    "const [dir, ready, bClaimed, aClaimed] = process.argv.slice(2);",
    "const waitFor = file => { const cell = new Int32Array(new SharedArrayBuffer(4)); const end = Date.now() + 30000; while (!fs.existsSync(file) && Date.now() < end) Atomics.wait(cell, 0, 0, 50); if (!fs.existsSync(file)) throw new Error(\"timed out waiting for B claim\"); };",
    "const claim = claimRun(dir, \"controller-a\", {afterSnapshot: () => { fs.writeFileSync(ready, \"ready\"); waitFor(bClaimed); }});",
    "fs.writeFileSync(aClaimed, JSON.stringify(claim));",
  ].join(String.fromCharCode(10)), "utf8");
  fs.writeFileSync(bWorker, [
    "import fs from \"node:fs\";",
    "import {claimRun} from " + JSON.stringify(moduleUrl) + ";",
    "const pause = ms => new Promise(resolve => setTimeout(resolve, ms));",
    "const [dir, claimed, done] = process.argv.slice(2);",
    "const claim = claimRun(dir, \"controller-b\");",
    "fs.writeFileSync(claimed, JSON.stringify(claim));",
    "while (!fs.existsSync(done)) await pause(50);",
  ].join(String.fromCharCode(10)), "utf8");
  let a = null;
  let b = null;
  try {
    a = spawn(nodeExe, [aWorker, dir, aReady, bClaimed, aClaimed], {windowsHide: true, stdio: "ignore"});
    await waitFor(aReady);
    b = spawn(nodeExe, [bWorker, dir, bClaimed, bDone], {windowsHide: true, stdio: "ignore"});
    await waitFor(bClaimed);
    await waitFor(aClaimed);
    const owners = JSON.parse(fs.readFileSync(path.join(dir, "run-owners.json"), "utf8"));
    assert.ok(owners["controller-b"], "the owner claimed after the first snapshot must survive");
    assert.ok(owners["controller-a"], "the later controller claim must also be present");
    fs.writeFileSync(bDone, "done");
    if (a.exitCode === null) await new Promise(resolve => a.once("exit", resolve));
    if (b.exitCode === null) await new Promise(resolve => b.once("exit", resolve));
    assert.equal(a.exitCode, 0);
    assert.equal(b.exitCode, 0);
  } finally {
    fs.writeFileSync(bDone, "done");
    for (const child of [a, b]) {
      if (child && child.exitCode === null) {
        try { child.kill(); } catch {}
      }
    }
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
