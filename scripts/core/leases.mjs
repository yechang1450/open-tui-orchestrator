import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {keysOverlap,powershellExe} from './contracts.mjs';

// 锚定 SystemRoot 的 powershell.exe：裸名会先按进程 cwd（任意工作区）解析，防二进制投毒。
const PS_EXE=powershellExe();

export function processSnapshot(timeoutMs=15000) {
  if(process.platform!=='win32')throw new Error('Visible TUI runtime currently requires Windows');
  const result=spawnSync(PS_EXE,['-NoProfile','-Command',
    '$ErrorActionPreference="Stop"; Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,@{n="Started";e={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress'],
    {encoding:'utf8',windowsHide:true,timeout:Math.max(1,Math.min(15000,Math.ceil(timeoutMs)))});
  if(result.status!==0)throw new Error('Cannot verify process identities');
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
  if(env.ORCH_COORDINATOR_DIR)return path.resolve(workspace,env.ORCH_COORDINATOR_DIR);
  const fallback=path.join(workspace,'temp','orchestrator','coordinator');
  if(process.platform!=='win32'||env.NODE_TEST_CONTEXT)return fallback;
  const quoted=fallback.replaceAll("'","''");
  const script=`$held=$false; $m=[Threading.Mutex]::new($false,'Local\\TuiOrchestrator.Coordinator'); try {try{$held=$m.WaitOne(15000)}catch [Threading.AbandonedMutexException]{$held=$true}; if(-not $held){throw 'Coordinator locator busy'}; $key='HKCU:\\Software\\TuiOrchestrator'; $p=(Get-ItemProperty -LiteralPath $key -Name CoordinatorRoot -ErrorAction SilentlyContinue).CoordinatorRoot; if(-not $p){$p='${quoted}'; New-Item -Path $key -Force|Out-Null; New-ItemProperty -LiteralPath $key -Name CoordinatorRoot -Value $p -PropertyType String -Force|Out-Null}; Write-Output $p}finally{if($held){$m.ReleaseMutex()};$m.Dispose()}`;
  const r=spawnSync(PS_EXE,['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000});
  if(r.status!==0||!r.stdout.trim())throw new Error('Unable to locate machine window coordinator');
  return path.resolve(r.stdout.trim());
}
export function atomicJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2));
  // Windows: renameSync 不覆盖已存在目标，且目标被杀软/索引器瞬时占用时报 EPERM/EACCES。
  // 单次 remove+rename 仍有窗口，这里做短暂退避重试；非暂时性错误立即上抛，临时文件不残留。
  const sleepSync=ms=>{try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}catch{}};
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
    const ticket=path.join(dir,'lock-'+crypto.randomUUID());
    const child=spawn(PS_EXE,['-NoProfile','-File',fileURLToPath(new URL('./lease-lock.ps1',import.meta.url)),'-Directory',dir,'-Ticket',ticket,'-Owner',String(owner.ProcessId),'-Started',owner.Started],{windowsHide:true,stdio:'ignore'});
    child.on('error',()=>{});child.unref();
    const deadline=Date.now()+30000;
    while(!fs.existsSync(ticket+'.ready')&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
    unlock=()=>fs.writeFileSync(ticket+'.release','release');
    if(!fs.existsSync(ticket+'.ready')){unlock();throw new Error('Coordinator mutex acquisition failed');}
  }
  try {processes=snapshot();let leases=[];try{leases=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    leases=leases.filter(l=>{
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
    leases.push({...rec,owner,capacity,reservedAt:Date.now()});return {ok:true};
  },snapshot);
}
export function bind(dir,id,launcher,snapshot){return transaction(dir,leases=>{const l=leases.find(l=>l.id===id);if(!l)throw new Error('Reservation expired');l.launcher=launcher;},snapshot);}
export function release(dir,id,snapshot){return transaction(dir,leases=>{const index=leases.findIndex(l=>l.id===id);if(index>=0)leases.splice(index,1);},snapshot);}

export function prepare(dir,id,pidFile){return transaction(dir,leases=>{const l=leases.find(l=>l.id===id);if(!l)throw new Error("Reservation expired");l.pidFile=pidFile;});}

export function claimRun(dir,key) {
  return transaction(dir,(_leases,owner,processes)=>{
    const file=path.join(dir,'run-owners.json');let owners={};
    try{owners=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    for(const [id,r] of Object.entries(owners))if(!sameProcess(r.owner,processes.get(r.owner.ProcessId)))delete owners[id];
    if(owners[key])throw new Error('Run already has a live controller');
    const claim={owner,token:crypto.randomUUID()};owners[key]=claim;atomicJson(file,owners);return claim;
  });
}
export function releaseRun(dir,key,claim) {
  return transaction(dir,()=>{
    const file=path.join(dir,'run-owners.json');const owners=JSON.parse(fs.readFileSync(file,'utf8'));
    if(owners[key]?.token===claim.token){delete owners[key];atomicJson(file,owners);}
  });
}
