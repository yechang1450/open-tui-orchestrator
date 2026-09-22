import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {keysOverlap,powershellExe,bootId} from './contracts.mjs';

// 锚定 SystemRoot 的 powershell.exe：裸名会先按进程 cwd（任意工作区）解析，防二进制投毒。
const PS_EXE=powershellExe();

export function processSnapshotTimeoutMs(override) {
  // 身份枚举的预算（2026-09-15）：慢机上 PowerShell/WMI 可能几十秒不返回。默认 15000 ms，
  // 可用 ORCH_PS_TIMEOUT_MS 调（上限 120000 ms）。失败话术必须带耗时与原因——裸话术
  // 「Cannot verify process identities」既不说耗时也不说原因，慢机上无法排障。
  const raw=Number.isFinite(override)?override:Number(process.env.ORCH_PS_TIMEOUT_MS);
  const value=Number.isFinite(raw)&&raw>0?raw:15000;
  return Math.max(1,Math.min(120000,Math.ceil(value)));
}
export function processSnapshot(timeoutMs) {
  if(process.platform!=='win32')throw new Error('Visible TUI runtime currently requires Windows');
  const budget=processSnapshotTimeoutMs(timeoutMs);
  const started=Date.now();
  const result=spawnSync(PS_EXE,['-NoProfile','-Command',
    '$ErrorActionPreference="Stop"; Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,@{n="Started";e={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress'],
    {encoding:'utf8',windowsHide:true,timeout:budget});
  const elapsed=Date.now()-started;
  if(result.status!==0){
    const timedOut=(result.error&&result.error.code==='ETIMEDOUT')||(result.status===null);
    const stderr=String(result.stderr||'').trim().split('\n').filter(Boolean).slice(-1)[0]||'';
    const detail=timedOut
      ?`the process snapshot did not return within ${budget} ms (elapsed ${elapsed} ms; the machine may be under heavy load)`
      :`powershell exited with status ${result.status} after ${elapsed} ms`;
    throw new Error(`Cannot verify process identities: ${detail}${stderr?'; '+stderr.slice(0,200):''}; retry, or raise ORCH_PS_TIMEOUT_MS (budget ${budget} ms, cap 120000)`);
  }
  return new Map(JSON.parse(result.stdout).map(p=>[p.ProcessId,p]));
}
export function sameProcess(expected,actual) {
  return !!expected&&!!actual&&expected.ProcessId===actual.ProcessId&&expected.Started===actual.Started&&expected.Name===actual.Name&&expected.CommandLine===actual.CommandLine;
}
export function launcherIdentity(pid,pidFile,snapshot=processSnapshot()) {
  const actual=snapshot.get(Number(pid));
  const script=path.join(path.dirname(pidFile),path.basename(pidFile).replace(/^window-/,'win-launch-').replace(/\.pid$/,'.ps1'));
  const args=String(actual?.CommandLine||'').toLowerCase().replaceAll('/','\\');
  if(!/^(powershell|pwsh)\.exe$/i.test(actual?.Name||'')||!args.includes(script.toLowerCase().replaceAll('/','\\')))return null;
  return actual;
}

// Only a locator is kept in HKCU; all runtime files remain beneath the first
// initiating workspace's temp. A named mutex makes first discovery atomic.
// Under `node --test` (NODE_TEST_CONTEXT is set) the machine-wide locator is
// never touched: test workspaces keep their coordinator in their own temp.
export function coordinatorDir(workspace,env=process.env) {
  const resolved=(()=>{
  if(env.ORCH_COORDINATOR_DIR)return path.resolve(workspace,env.ORCH_COORDINATOR_DIR);
  const fallback=path.join(workspace,'temp','orchestrator','coordinator');
  if(process.platform!=='win32'||env.NODE_TEST_CONTEXT)return fallback;
  const quoted=fallback.replaceAll("'","''");
  const script=`$held=$false; $m=[Threading.Mutex]::new($false,'Local\\TuiOrchestrator.Coordinator'); try {try{$held=$m.WaitOne(15000)}catch [Threading.AbandonedMutexException]{$held=$true}; if(-not $held){throw 'Coordinator locator busy'}; $key='HKCU:\\Software\\TuiOrchestrator'; $p=(Get-ItemProperty -LiteralPath $key -Name CoordinatorRoot -ErrorAction SilentlyContinue).CoordinatorRoot; if(-not $p){$p='${quoted}'; New-Item -Path $key -Force|Out-Null; New-ItemProperty -LiteralPath $key -Name CoordinatorRoot -Value $p -PropertyType String -Force|Out-Null}; Write-Output $p}finally{if($held){$m.ReleaseMutex()};$m.Dispose()}`;
  const r=spawnSync(PS_EXE,['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000});
  if(r.status!==0||!r.stdout.trim())throw new Error('Unable to locate machine window coordinator');
  return path.resolve(r.stdout.trim());
  })();
  // 入口即回收：被强杀的 PS 不会执行自己的清理，过期锁票会一直躺在协调器目录里（本轮清理时实测
  // 576 个）。这里每次解析协调器目录时顺手按龄回收一次（只删老旧票，绝不碰在票）——保证空闲时
  // 也不会长期积压，而不是等到下一次事务才清。
  if(fs.existsSync(resolved))sweepStaleMutexTickets(resolved);
  return resolved;
}
// 协调器内核互斥的口径（全部可调；2026-09-14 修：旧值把等待写死 20s，满载多竞争者会假失败）：
// - ORCH_MUTEX_WAIT_MS     PS 侧 WaitOne 时长，默认 60000ms；
// - ORCH_MUTEX_RETRIES     获取失败后的重试次数，默认 2（退避复用 waitBackoffMs）；
// - ORCH_MUTEX_TICKET_TTL_MS  锁票老化回收阈值，默认 600000ms。
// 被强杀/超时的 PS 进程跑不到自己的清理（finally 只在本进程里），锁票会在协调器目录无界堆积
// （2026-09-14 实测 576 个）——所以每次事务前按龄回收一次：只收老旧票，绝不碰在票。
const sleepFor=ms=>{try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}catch{}};
function mutexWaitMs(){const v=Number(process.env.ORCH_MUTEX_WAIT_MS);return Number.isFinite(v)&&v>=1000?Math.floor(v):60000;}
function mutexRetries(){const v=Number(process.env.ORCH_MUTEX_RETRIES);return Number.isFinite(v)&&v>=0?Math.min(10,Math.floor(v)):2;}
function mutexTicketTtlMs(){const v=Number(process.env.ORCH_MUTEX_TICKET_TTL_MS);return Number.isFinite(v)&&v>=0?Math.floor(v):600000;}
export function sweepStaleMutexTickets(dir,{ttlMs=mutexTicketTtlMs(),now=Date.now()}={}){
  let removed=0;
  try{
    for(const name of fs.readdirSync(dir)){
      if(!/^lock-[0-9a-f-]+\.(ready|release|status)$/.test(name))continue;
      const full=path.join(dir,name);
      try{if(now-fs.statSync(full).mtimeMs>=ttlMs){fs.rmSync(full,{force:true});removed++;}}catch{}
    }
  }catch{}
  return removed;
}
// 取一次内核互斥：PS 侧等 waitMs，JS 侧按 waitMs + 启动/退出余量设界。失败时按 waitMs 有界返回，
// 由调用方决定重试。
// 等待是同步阻塞的（Atomics.wait），事件回调在阻塞期间不会运行，所以这里**不能**靠 'exit' 事件判早退；
// 但"PS 已经收场"这件事必须能立刻看见（2026-09-22：满载套件里 PS 提前收场而 JS 干等满 60s×3，几十处
// 假红、单条用例 189s），因此用两条同步通道：
//   ① 状态票：PS 异常收场时写 <ticket>.status（busy-timeout / owner-gone / hold-ceiling / error:…）；
//   ② 便宜的活性探针：process.kill(pid,0) 判子进程是否还在（ESRCH = 没了），把"没起来/被杀了"也识别出来。
function acquireCoordinatorMutex(dir,owner,waitMs,script){
  const ticket=path.join(dir,'lock-'+crypto.randomUUID());
  const statusFile=ticket+'.status';
  let spawnError=null;
  const child=spawn(PS_EXE,['-NoProfile','-File',script,'-Directory',dir,'-Ticket',ticket,'-Owner',String(owner.ProcessId),'-Started',owner.Started],{windowsHide:true,stdio:'ignore'});
  child.on('error',error=>{spawnError=error;});child.unref();
  const deadline=Date.now()+waitMs+2500;
  const readStatus=()=>{try{return String(fs.readFileSync(statusFile,'utf8')).trim();}catch{return '';}};
  const childAlive=()=>{try{process.kill(child.pid,0);return true;}catch(error){return !error||error.code!=='ESRCH';}};
  let reason='';
  while(!fs.existsSync(ticket+'.ready')){
    reason=readStatus();
    if(reason)break;
    if(!childAlive()){reason=spawnError?'holder failed to start: '+spawnError.message:'holder exited before ready';break;}
    if(Date.now()>=deadline){reason='no ready within '+(waitMs+2500)+'ms';break;}
    sleepFor(25);
  }
  const ready=fs.existsSync(ticket+'.ready');
  const release=()=>{try{fs.writeFileSync(ticket+'.release','release');}catch{}};
  const discard=()=>{for(const suffix of ['.ready','.release','.status'])try{fs.rmSync(ticket+suffix,{force:true});}catch{}};
  return {ready,release,discard,reason:ready?'':reason};
}
export function atomicJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.'+process.pid+'.tmp';
  // 断电 P0（2026-09-18）：显式 fsync 再 rename —— 只落页缓存的话，真断电会留下 0 字节/半截 JSON，
  // 恢复侧就会把合法账本读成损坏。目录项 fsync 在 Windows 上不支持，这里有意跳过（rename 是原子替换）。
  const fd=fs.openSync(tmp,'w');
  try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  // Windows: renameSync 不覆盖已存在目标，且目标被杀软/索引器瞬时占用时报 EPERM/EACCES。
  // 单次 remove+rename 仍有窗口，这里做短暂退避重试；非暂时性错误立即上抛，临时文件不残留。
  const sleepSync=sleepFor;
  let lastError=null;
  for(let attempt=0;attempt<6;attempt++){
    try{fs.renameSync(tmp,file);return;}
    catch(error){
      lastError=error;
      if(!error||!['EEXIST','EPERM','EACCES'].includes(error.code))break;
      try{fs.rmSync(file,{force:true});}catch{}
      sleepSync(60+attempt*80);
    }
  }
  try{fs.rmSync(tmp,{force:true});}catch{}
  throw lastError;
}
export function transaction(dir,fn,snapshot=processSnapshot) {
  fs.mkdirSync(dir,{recursive:true});const lock=path.join(dir,'mutex.json'),file=path.join(dir,'leases.json');
  let processes=snapshot();const owner=processes.get(process.pid);
  if(!owner)throw new Error('Coordinator owner identity unavailable');
  // A kernel mutex is released by Windows on a crash. Unlike a stale lockfile,
  // it cannot be reclaimed by two contenders or strand an empty lock forever.
  let unlock=()=>{};
  if(snapshot===processSnapshot) {
    sweepStaleMutexTickets(dir);
    const waitMs=mutexWaitMs(),tries=mutexRetries();
    const script=fileURLToPath(new URL('./lease-lock.ps1',import.meta.url));
    let held=null;
    for(let attempt=0;;attempt++) {
      const candidate=acquireCoordinatorMutex(dir,owner,waitMs,script);
      if(candidate.ready){held=candidate;break;}
      candidate.release();
      // 失败路径的锁票清理延后到事件循环恢复之后（阻塞等待期间 setTimeout 也不会跑）；
      // 真正兜底的是 sweepStaleMutexTickets 的按龄回收。
      setTimeout(candidate.discard,3000).unref?.();
      if(attempt>=tries)throw new Error('Coordinator mutex acquisition failed (waited '+waitMs+'ms x'+(attempt+1)+(candidate.reason?'; '+candidate.reason:'')+'; tune ORCH_MUTEX_WAIT_MS / ORCH_MUTEX_RETRIES / ORCH_MUTEX_HOLD_MAX_MS)');
      sleepFor(waitBackoffMs(attempt,{base:250,max:2000}));
    }
    unlock=()=>held.release();
  }
  try {
    // 关键（2026-09-22）：持锁期间**不再**做全表快照。processSnapshot 是一次 machine-wide CIM 查询
    // （满载机器上几秒~十几秒），锁内执行会把每个排队者的等待预算吃光——3 并发套件里几十处
    // "waited 60000ms x3" 假红的真根因。锁前那份快照本来就够用：下面的筛选只回答"属主还在不在"，
    // 几百毫秒的偏差最多让一条刚死的租约多留一轮，代价远小于在锁里做全表查询。
    let leases=[];try{leases=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    leases=leases.filter(l=>{
      // 断电 P0（2026-09-18）：带开机标识且与本次开机不符 ⇒ 确定来自上一次开机，直接回收。
      // PID 跨重启会重用（可能撞上任意活进程），所以“重启后还活着”这类误判必须由 bootId 拦掉。
      if(l.bootId!==undefined&&l.bootId!==bootId())return false;
      if(l.launcher)return sameProcess(l.launcher,processes.get(l.launcher.ProcessId));
      if(l.pidFile){let pid=0;try{pid=Number(fs.readFileSync(l.pidFile,'utf8').replace(/^\uFEFF/,''));}catch{};const found=launcherIdentity(pid,l.pidFile,processes);if(found){l.launcher=found;return true;}}
      return sameProcess(l.owner,processes.get(l.owner.ProcessId))||Date.now()-(l.reservedAt||0)<90000;
    });
    const result=fn(leases,owner,processes);atomicJson(file,leases);return result;
  }finally{unlock();}
}
// 排队退避（P1）：容量/冲突等待按指数退避 + 抖动——多等待者错峰，避免每秒各打一发协调器事务的惊群。
// attempt 从 0 起；base=首等毫秒、max=封顶（抖动上界 max×1.2）；random 可注入以保证测试确定性。
export function waitBackoffMs(attempt, {base = 600, max = 5000, random = Math.random} = {}) {
  const grow = Math.max(0, Math.floor(Number(attempt) || 0));
  const cap = Math.max(1, Number(max) || 1);
  const start = Math.min(Math.max(1, Number(base) || 1), cap);
  const target = Math.min(cap, start * Math.pow(1.7, grow));
  const jitter = 0.8 + (typeof random === 'function' ? Number(random()) : Math.random()) * 0.4;
  return Math.max(1, Math.round(target * jitter));
}
export function reserve(dir,rec,capacity,snapshot) {
  return transaction(dir,(leases,owner)=>{
    if(leases.some(l=>l.id===rec.id))return {ok:false,reason:'existing reservation'};
    const limit=Math.min(capacity,...leases.map(l=>l.capacity||capacity));
    if(leases.length>=limit)return {ok:false,reason:'capacity'};
    if(leases.some(l=>keysOverlap(l.keys,rec.keys)))return {ok:false,reason:'conflict'};
    leases.push({...rec,owner,capacity,reservedAt:Date.now(),bootId:bootId()});return {ok:true};
  },snapshot);
}
export function bind(dir,id,launcher,snapshot){return transaction(dir,leases=>{const l=leases.find(l=>l.id===id);if(!l)throw new Error('Reservation expired');l.launcher=launcher;},snapshot);}
export function release(dir,id,snapshot){return transaction(dir,leases=>{const index=leases.findIndex(l=>l.id===id);if(index>=0)leases.splice(index,1);},snapshot);}

export function prepare(dir,id,pidFile){return transaction(dir,leases=>{const l=leases.find(l=>l.id===id);if(!l)throw new Error("Reservation expired");l.pidFile=pidFile;});}

export function claimRun(dir,key) {
  return transaction(dir,(_leases,owner,processes)=>{
    const file=path.join(dir,'run-owners.json');let owners={};
    try{owners=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    // 断电 P0：上一次开机留下的 run 属主一律回收（PID 跨重启会重用，不能用来判“还活着”）。
    for(const [id,r] of Object.entries(owners))if((r.bootId!==undefined&&r.bootId!==bootId())||!sameProcess(r.owner,processes.get(r.owner.ProcessId)))delete owners[id];
    if(owners[key])throw new Error('Run already has a live controller');
    const claim={owner,token:crypto.randomUUID(),bootId:bootId()};owners[key]=claim;atomicJson(file,owners);return claim;
  });
}
export function releaseRun(dir,key,claim) {
  return transaction(dir,()=>{
    const file=path.join(dir,'run-owners.json');const owners=JSON.parse(fs.readFileSync(file,'utf8'));
    if(owners[key]?.token===claim.token){delete owners[key];atomicJson(file,owners);}
  });
}
