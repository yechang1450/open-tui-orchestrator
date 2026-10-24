import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CORE_VERSION,ledgerPlan,levelWaves,verifyChecks,summaryComplete,TERMINAL,canonicalKey,requestTasks,acceptanceKeyDiff,bootId,powershellExe} from './contracts.mjs';
import {coordinatorDir,reserve,bind,release,prepare,atomicJson,launcherIdentity,processSnapshot,sameProcess,claimRun,releaseRun,waitBackoffMs} from './leases.mjs';
import {scheduleReady,recoveryTasks,taskPolicy,validateRecoverySummary} from './recovery.mjs';
import {readCheckpoints} from './checkpoint.mjs';
import {boardSignature,boardJson,boardSummaryLine} from './run-board.mjs';
import {runDirectory} from './runtime-context.mjs';
import {memConfig, loadUnitMemory, saveUnitMemory, recordUnitPeak, unitMemoryStorePath, unitEstimateMb, estimateBlockMemoryMb} from './unit-memory.mjs';
import {spawn} from 'node:child_process';
// 队列退避参数（env 可调，测试提速用）：首等 base、指数 ×1.7、封顶 max（抖动上界 ×1.2）。
const WAIT_BACKOFF={base:Math.max(50,Number(process.env.ORCH_WAIT_BACKOFF_MS||600)||600),max:0};
WAIT_BACKOFF.max=Math.max(WAIT_BACKOFF.base,Number(process.env.ORCH_WAIT_BACKOFF_MAX_MS||5000)||5000);
export {scheduleReady,recoveryTasks,runDirectory};
export function escapeCmdBatchPath(value) { return String(value).replaceAll('%', '%%'); }
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// 单元停滞看门狗（2026-09-17 用户令：不要让调用方手动 Ctrl-D 退出僵死窗）：
// agent 进程活着但不再产出（典型：账号额度耗尽后 TUI 停在错误横幅、或界面卡在等输入）时，
// 旧行为是一直等到运行上限（默认 6h）——外部只能人工打断。现在：进度停超过 ORCH_UNIT_STALL_MS
// 就判停滞 → 关窗/强制收口单元树 → 计入 attempts 预算自动重跑；预算耗尽则诚实以 stalled 收口。
const UNIT_STALL_MS=Math.max(1000,Number(process.env.ORCH_UNIT_STALL_MS||600000)||600000);
const UNIT_TIMEOUT_MS=Math.max(5000,Number(process.env.ORCH_UNIT_TIMEOUT_MS||2700000)||2700000);
// 起窗节奏（2026-10-17）：默认 5000ms 逐窗错峰。九块同时冷启动会撞 TUI 首启竞争与宿主账号
// 每分钟限流（两轮实测全红：hermes 八单元全卡欢迎页、codex 三块 Reservation expired）；错峰后
// 同一预算下峰值 8、9/9 verified。`0` = 关闭（显式同起）。库语义：本函数是**用户入口**
// （orchestrate-sdk）的默认值解析；runWindows 的 options.spawnStaggerMs 仍保持「显式传才生效」，
// 直接调 runWindows 的测试不会被默认值拖慢。
export const DEFAULT_SPAWN_STAGGER_MS = 5000;
export function resolveSpawnStaggerMs(env = process.env) {
  const v = Number(env.ORCH_WINDOW_STAGGER_MS);
  return Number.isFinite(v) && v >= 0 ? Math.min(60000, Math.floor(v)) : DEFAULT_SPAWN_STAGGER_MS;
}

// —— 0.9.17 通用内存采样接线（宿主无关）：只拿单元根 pid；采样/回写任何失败都不影响编排（fail-open）。
function unitPeakFile(la, key, token) {
  return la ? path.join(path.dirname(String(la.pidf)), 'unit-peak-' + key + '-' + String(token || 'x').slice(-8) + '.json') : '';
}
// 采样器是**账外**产物（内存画像，fail-open），绝不能让它的寿命绑住引擎进程：
// 2026-09-22 实测，Node 的 `child.unref()` 只解绑子进程句柄、**不解绑管道**，所以
// `stdio:['ignore','ignore','pipe']` 会让父进程一直活到采样器退出（实测：子进程活 20s，
// 父进程陪满 20.17s）。于是「引擎跑完 → 采样器还在忙」会被上层（如测试的 spawnSync、
// 机器的调用方）读成「整条命令没结束」，重载下把一次全绿套件拖成假红。
// 修法：采样器 stderr 直接落文件（无管道，与守护进程同一套写法），并把根进程的**启动时刻**
// 一并交给它——裸 pid 不是身份，Windows 复用 pid 会让采样器对着陌生人轮询满 -MaxMs。
export function startUnitSampler(la, key, token, rootPid, rootStarted) {
  try {
    if (!la || !Number.isInteger(rootPid) || rootPid <= 0) {
      console.error('[mem] sampler skipped (rootPid=' + String(rootPid) + ', la=' + (la ? 'yes' : 'no') + ')');
      return false;
    }
    const sampler = path.join(path.dirname(fileURLToPath(import.meta.url)), 'unit-memory-sampler.ps1');
    const errLog = unitPeakFile(la, key, token) + '.stderr.txt';
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sampler, '-RootPid', String(rootPid), '-OutFile', unitPeakFile(la, key, token), '-IntervalMs', '6000'];
    if (rootStarted) args.push('-RootStarted', String(rootStarted));
    // 2026-09-18 实测定论：detached:true 会让 PS 子进程在 Windows 上静默死掉（一行不执行、不报错、不退出）
    // —— 去 detached，做普通子进程（引擎寿命 ≥ 单元寿命，采样器随单元结束自然收尾）。
    let errFd = 'ignore';
    try {
      errFd = fs.openSync(errLog, 'a');
    } catch {}
    const child = spawn(powershellExe(), args, {windowsHide: true, stdio: ['ignore', 'ignore', errFd]});
    if (typeof errFd === 'number') { try { fs.closeSync(errFd); } catch {} }
    child.unref();
    console.log('[mem] sampler started pid=' + String(child.pid) + ' root=' + rootPid + ' out=' + unitPeakFile(la, key, token));
    // 返回采样器 pid（真值）：调用方拿它做「已经在采样」的标记，测试拿它收尾，不留孤儿进程。
    return Number(child.pid) || true;
  } catch (error) {
    console.error('[mem] sampler failed to start: ' + String(error && error.message));
    return false;
  }
}
async function recordUnitPeakIfReady(la, key, token, agent, waitForSample) {
  try {
    if (!la) return;
    const file = unitPeakFile(la, key, token);
    for (let i = 0; waitForSample && i < 10 && !fs.existsSync(file); i += 1) await pause(1000);
    if (!fs.existsSync(file)) { if (waitForSample) console.error('[mem] no peak sample for ' + key + ' (sampler did not finish; markers: ' + file + '.start / .error)'); return; }
    const peak = Number(JSON.parse(fs.readFileSync(file, 'utf8'))?.peakMB);
    fs.rmSync(file, {force: true});                        // 读过即销：天然去重，旧样本不会重复入账
    if (!Number.isFinite(peak) || peak <= 0) return;
    const storeFile = unitMemoryStorePath(process.env);
    const store = loadUnitMemory(storeFile);
    recordUnitPeak(store, agent, peak);
    saveUnitMemory(storeFile, store);
    console.log('[mem] unit ' + key + ' peak=' + peak + 'MB (agent=' + String(agent || 'unknown') + ')');
  } catch {}
}
// 偶发瞬时故障（2026-09-18 用户令）：单元“启动即死、无终态检查点”这类瞬时故障必须自动检测 + 自动
// 重跑，绝不把瞬时故障当结论甩给调用方。判据 = ①该块待定任务的检查点全部停在 started（无终态）
// ②最近一次尝试的存活时长 ≤ 窗口（真跑过很久的失败不算瞬时）③验收未被 retrySafe:false 明确否决。
// retrySafe:true 仍是“总是可重跑”的强声明；未声明 = 仅瞬时特征自动重跑（默认 1 次，可 env 调）。
const TRANSIENT_RETRIES=(()=>{const v=Number(process.env.ORCH_TRANSIENT_RETRIES);return Number.isFinite(v)&&v>=0?Math.floor(v):1;})();
const TRANSIENT_WINDOW_MS=Math.max(1000,Number(process.env.ORCH_TRANSIENT_WINDOW_MS||180000)||180000);
const TRANSIENT_BACKOFF_MS=Math.max(0,Number(process.env.ORCH_TRANSIENT_BACKOFF_MS||2500)||2500);
// 进度戳：任一证据文件（检查点/结果/启动器 out·pty 日志/宿主会话）mtime 前进即视为有进展。
// 只读 mtime，不解析宿主格式——对全部宿主一视同仁，也不依赖模型侧配合。
function progressStamp(paths){let t=0;for(const p of paths){try{t=Math.max(t,fs.statSync(p).mtimeMs);}catch{}}return t;}
export function firstCheckpointTimedOut({firstCheckpointMs,now,baseline,checkpointMtime}){
  const limit=Math.max(0,Number(firstCheckpointMs)||0);
  return !!limit&&Number(now)-Number(baseline)>limit&&Number(checkpointMtime||0)<=Number(baseline);
}
export async function waitWithStallWatchdog(hooks,la,session,active,timeoutMs){
  const stallMs=Math.max(1000,Number(process.env.ORCH_UNIT_STALL_MS||UNIT_STALL_MS)||UNIT_STALL_MS);
  // 首检查点期限（2026-09-18 用户令“执行遇到问题甚至中断要能自愈”）：契约要求每项任务“开始前”先写
  // started 检查点；若整个单元从启动起 N 秒内一次检查点都没写过（该尝试的 checkpoints/ 目录从未
  // 越过启动时刻；检查点写在 <attempt dir>/checkpoints/<id>.json，attempt.json 本身不会变），
  // 说明这轮 agent 只顾分析/空转而没有动手——提前收口重跑，不再等满 stall 期限。0 = 关闭。
  // 默认 20 分钟（2026-10-09，原 300s）：慢启动宿主的仪式期本身就要 4-18 分钟（实测 codex），
  // 300s 默认把"慢但正常"误判成"空转"（同一契约实跑：3 次无产出重试 ⇒ 改 1200s 后 0 次）；
  // 真正僵死的单元仍由同函数里的 stall 通道（任一证据文件 mtime 不前进）兜底。
  const rawFirst=process.env.ORCH_UNIT_FIRST_CHECKPOINT_MS;
  const firstCheckpointMs=rawFirst===undefined?1200000:Math.max(0,Number(rawFirst)||0);
  const base=path.dirname(String(la.rf||la.pidf||'.'));
  const stem=path.basename(String(la.lp||'')).replace(/\.ps1$/,'');
  const paths=[active.file,la.rf,la.pidf,path.join(base,stem+'.out.log'),path.join(base,stem+'.pty.log')];
  if(typeof session==='string')paths.push(session);else if(session&&typeof session==='object'&&session.file)paths.push(session.file);
  const started=Date.now(),baseline=Number(active?.createdAt)||started;let last=progressStamp(paths)||baseline;let iv=null;
  const watchdog=new Promise(resolve=>{iv=setInterval(()=>{const now=Date.now(),s=progressStamp(paths);
    if(s>last)last=s;
    const cpDir=path.join(path.dirname(active.file),'checkpoints');
    const cpMs=firstCheckpointMs?(()=>{try{return fs.statSync(cpDir).mtimeMs;}catch{return 0;}})():0;
    if(firstCheckpointTimedOut({firstCheckpointMs,now,baseline,checkpointMtime:cpMs})){clearInterval(iv);resolve({stall:'unproductive: no task checkpoint within '+Math.round(firstCheckpointMs/1000)+'s (the unit never started its first task); retrying within the attempt budget'});}
    else if(now-last>stallMs){clearInterval(iv);resolve({stall:'stalled: no unit progress for '+Math.round((now-last)/1000)+'s; retrying within the attempt budget'});}
    else if(now-started>timeoutMs){clearInterval(iv);resolve({stall:'stalled: unit timeout after '+Math.round((now-started)/1000)+'s with no result'});}
  },Math.min(5000,Math.max(250,Math.floor(stallMs/4))));});
  try{
    return await Promise.race([hooks.wait(session,timeoutMs,la.rf,'【本块唯一标识】'+active.token,la.pidf).then(result=>({result})),watchdog]);
  } finally { if(iv)clearInterval(iv); }
}
// Identity acquisition under load: a full-process snapshot can be slow or miss a
// just-spawned launcher, and one unlucky read used to burn the whole attempt
// budget as popup-failed ('Launcher process identity mismatch'). Retry within a
// short grace window before giving up; transient snapshot failures are retried,
// a persistent one still fails fast.
export async function identityWithGrace(hooks,la,{graceMs=10000,intervalMs=800}={}) {
  const end=Date.now()+graceMs;let identity=null,lastError=null;
  while(true){
    try{identity=launcherIdentity(hooks.readPid(la.pidf),la.pidf);}catch(error){lastError=error;}
    if(identity)return identity;
    if(Date.now()>=end)break;
    await pause(intervalMs);
  }
  if(lastError)throw lastError;
  return null;
}
// 退出判定的口径（2026-09-22 修）：**读不到**不等于**还在**。
// 旧实现里一次快照失败（满载下 CIM 查询超过每次 3s 的预算、"Cannot verify process identities"）
// 直接 `return false`，调用方把它当成"launcher 还活着"⇒ 整块假失败
//（实测 reason="Launcher still alive; lease retained"，而那个 powershell 其实早就 exit 0 了）。
// 现在：拿不到快照就是"不知道"，继续轮询到期限；只有**拿到快照且它说进程不在/换了身份**才算退出。
// 同时把默认期限从 5s 提到 15s（上限），单次查询预算 8s——满负载下 PS 收尾本来就可能要几秒。
export async function waitForProcessExit(expected,{timeoutMs=15000,intervalMs=250,snapshot=processSnapshot}={}) {
  if(!expected||!Number.isFinite(Number(expected.ProcessId)))return true;
  const timeout=Math.max(0,Math.min(15000,Number(timeoutMs)||0)),interval=Math.max(10,Math.min(1000,Number(intervalMs)||100));
  const deadline=Date.now()+timeout;
  while(true){
    let current;
    try{current=snapshot(Math.min(8000,Math.max(1,deadline-Date.now())));}catch{current=null;}
    if(current&&!sameProcess(expected,current.get(Number(expected.ProcessId))))return true;
    if(Date.now()>=deadline)return false;
    await pause(Math.min(interval,Math.max(1,deadline-Date.now())));
  }
}
async function coordinate(fn,deadline) {
  while(Date.now()<deadline){try{return fn();}catch(e){if(!/busy|initializing|abandoned/.test(e.message))throw e;await pause(200);}}
  throw new Error('Coordinator transaction timeout');
}
// 调用方给的验收契约与运行自带的账本一样是**输入文件**：畸形必须点名文件，不能甩裸 JSON 偏移
// （实测旧行为：'Expected \',\' or \'}\' after property value in JSON at position 23'——不知道是哪个文件坏了）。
// 运行目录里那份 acceptance.json 缺失仍按「没有父级验收」处理（既有语义：任务停在 awaiting-verification）。
function loadChecks(file){
  if(!file)return {};
  let raw;
  try{raw=fs.readFileSync(file,'utf8');}
  catch(error){
    if(error&&error.code==='ENOENT')return {};
    throw new Error('ACCEPTANCE_UNREADABLE: '+file+' ('+((error&&error.message)||String(error))+')');
  }
  try{return JSON.parse(String(raw).replace(/^\uFEFF/,''));}
  catch(error){throw new Error('ACCEPTANCE_INVALID: '+file+' ('+((error&&error.message)||String(error))+')');}
}
// 运行账本（summary.json）的读取口径：缺失 = 找不到这个 run（既有话术），**损坏 = 点名文件的账本错误**。
function readRunLedger(file,runId){
  let raw;
  try{raw=fs.readFileSync(file,'utf8');}
  catch(error){
    if(error&&error.code==='ENOENT')throw new Error('Run not found: '+runId+' (no summary.json in '+path.dirname(file)+')');
    throw new Error('Invalid run ledger: '+file+' ('+((error&&error.message)||String(error))+')');
  }
  try{return JSON.parse(String(raw).replace(/^\uFEFF/,''));}
  catch(error){throw new Error('Invalid run ledger: '+file+' ('+((error&&error.message)||String(error))+')');}
}
// 验收契约（含 command 类检查，会以控制器权限执行）在创建时锚定哈希：run 目录可被窗内 agent 写入，
// resume/verify 回读前比对，篡改即拒绝——不让被改写的 acceptance.json 借恢复流程获得执行权。
function checksHash(checks){return crypto.createHash('sha256').update(JSON.stringify(checks||{})).digest('hex');}
function blockCheckpoints(entry,block,sum) {
  const out={};
  for(const a of entry?.attempts||[]) {
    try{Object.assign(out,readCheckpoints(a.file,{...a,runId:sum.runId}));}catch{for(const id of a.taskIds)out[id]={state:'invalid'};}
  }
  // Preserve read-only verification of historical protocol-1 runs.
  if(!entry?.attempts&&entry?.receiptFile) {
    try{for(const r of JSON.parse(fs.readFileSync(entry.receiptFile,'utf8')).tasks||[]){if(block.taskIds.includes(r.id))out[r.id]=r.runId===sum.runId&&r.token===entry.token&&r.status==='completed'?{state:'completed'}:{state:'invalid'};}}catch{}
  }
  for(const id of block.taskIds) {
    if(!out[id]&&sum.taskResults[id]?.checkpoint)out[id]=sum.taskResults[id].checkpoint;
    if(!out[id]&&sum.taskResults[id]?.status==='verified')out[id]={state:'invalid'};
  }
  return out;
}
function blockStatus(ids,results) {
  const statuses=ids.map(id=>results[id]?.status);
  if(statuses.every(s=>s==='verified'))return 'verified';
  if(statuses.includes('needs-reconciliation'))return 'needs-reconciliation';
  if(statuses.includes('awaiting-verification'))return 'awaiting-verification';
  return 'failed';
}
export function collectVerification(sum,checks,workspace) {
  for(const b of sum.blocks) {
    const e=sum.results[b.key];if(!e)continue;
    // 缺 endedAt 只排除「从未尝试过」的块：有过 attempt 的块仍要按盘上证据重算。
    // 旧写法 `if(!e?.endedAt)continue` 会把「launcher 未退」分支留下的无 endedAt 块永久跳过
    //（2026-10-24 实测 runId 6f7b8f2e…：B2 status=failed、endedAt 缺失，而 checkpoint 已 completed、
    // 产物已落盘），于是 --verify-run 拿不到这块 ⇒ 整 run 假失败。
    if(!e.endedAt&&!e.attempts?.length)continue;
    // 从未尝试过的块（零 attempt）没有盘上证据可算：控制面给的终态必须原样保留。timeout 自 2026-10-24
    // 起也会带 endedAt（账本可读），若不在这里挡住，就会被 blockStatus 降级成 failed —— 那等于把
    // 「等窗口/等机器超时」和「跑了但失败」混成同一个真相。
    if(['blocked','popup-failed','preflight-failed','cancelled','timeout'].includes(e.status)&&!e.attempts?.length)continue;
    const cps=blockCheckpoints(e,b,sum);
    for(const id of b.taskIds) {
      const cp=cps[id];if(!cp){sum.taskResults[id]={status:'failed',reason:'No durable task checkpoint'};continue;}
      if(cp.state==='invalid'){sum.taskResults[id]={status:'needs-reconciliation',reason:'Invalid checkpoint',checkpoint:cp};continue;}
      const check=verifyChecks(taskPolicy(checks[id]).checks,workspace);
      sum.taskResults[id]=check.status==='verified'?{...check,checkpoint:cp}:
        cp.state==='started'?{status:'needs-reconciliation',reason:'Task started but result is unproven',verification:check,checkpoint:cp}:{...check,checkpoint:cp};
    }
    e.status=blockStatus(b.taskIds,sum.taskResults);
  }
  return sum;
}
// 按盘上证据重算，但保留「结论没变」的任务原有 reason：证据决定 status；控制面当时给出的更具体判词
// （"Safe recovery attempt budget exhausted" 等）不该被泛化原因（"No durable task checkpoint"）冲掉——
// 后者会让账本丢掉「这块为什么停在这里」的唯一线索。status 变了则一律以盘上为准（含 evidence 给出的新 cause）。
function reconcileWithEvidence(sum,checks,workspace){
  const before=new Map();
  for(const b of sum.blocks)for(const id of b.taskIds){
    const r=sum.taskResults[id];
    if(r&&r.status!=='verified'&&r.reason)before.set(id,{status:r.status,reason:r.reason});
  }
  collectVerification(sum,checks,workspace);
  for(const [id,prev] of before){
    const now=sum.taskResults[id];
    if(now&&now.status===prev.status&&prev.status!=='verified')now.reason=prev.reason;
  }
}
// 收尾定终态的统一入口（2026-10-24）：先按盘上证据重算，再定 finishedAt/success。
// 自评与 --verify-run 必须同源——同一份 summary.json 不允许有两个真相（run 说 failed、verify 说
// verified 的事故就是这条不变量被漏掉的后果）。抽成导出的纯函数，让这条不变量有直接回归测试。
export function finalizeRunLedger(sum,checks,workspace){
  try{reconcileWithEvidence(sum,checks,workspace);}catch{}
  sum.finishedAt=Date.now();sum.success=summaryComplete(sum,true);return sum;
}
export function verifyRun(workspace,runId,acceptanceFile,stateDir) {
  const dir=runDirectory(workspace,runId,stateDir),file=path.join(dir,'summary.json');
  // 机器可调用契约：未知 run 必须 fail-closed 且只回一行可读诊断（不许裸栈帧/ENOENT 甩路径）。
  if(!fs.existsSync(file))throw new Error('Run not found: '+runId+' (no summary.json in '+dir+')');
  const sum=readRunLedger(file,runId);
  if(sum.runId!==runId||!sum.finishedAt)throw new Error('Run is not finalized');
  if(sum.protocol===2)validateRecoverySummary(sum);
  const checks=loadChecks(acceptanceFile||path.join(dir,'acceptance.json'));
  if(sum.acceptanceSha256&&checksHash(checks)!==sum.acceptanceSha256)throw new Error('Acceptance contract changed since run creation; refusing to verify');
  const claim=claimRun(sum.coordinator||coordinatorDir(workspace),'run:'+path.resolve(dir).toLowerCase());
  try{
    if(sum.tasks?.length){
      const keyDiff=acceptanceKeyDiff(checks,sum.tasks);
      if(keyDiff?.unknown.length)throw new Error('Acceptance keys do not match any task id: '+keyDiff.unknown.join(', ')+'（task ids: '+sum.tasks.map(t=>t.id).join(', ')+'）');
      if(keyDiff?.missing.length)console.warn('[orchestrator] acceptance has no checks for task(s): '+keyDiff.missing.join(', ')+'；这些任务将停在 awaiting-verification');
    }
    collectVerification(sum,checks,workspace);sum.success=summaryComplete(sum,true);atomicJson(file,sum);return sum.success;
  }  finally{releaseRun(sum.coordinator||coordinatorDir(workspace),'run:'+path.resolve(dir).toLowerCase(),claim);}
}

export async function runWindows(request,hooks,options={}) {
  const workspace=path.resolve(options.workspace),capacity=options.capacity;
  // options.windowCap (ORCH_MAX_WINDOWS) throttles live-window admission only;
  // planning keeps the full memory-derived capacity so block shape is unchanged.
  // let（非 const）：resume 时若当前可用内存低于建账块数，只收紧准入，不失败。
  let windowCap=Math.max(1,Math.min(capacity,Number(options.windowCap)||capacity));
  const runId=options.runId||crypto.randomUUID(),dir=runDirectory(workspace,runId,options.stateDir),summaryFile=path.join(dir,'summary.json');
  const deadline=Date.now()+(options.timeoutMs||21600000),coordinator=options.coordinator||coordinatorDir(workspace);
  const runKey='run:'+dir.toLowerCase(),claim=await coordinate(()=>claimRun(coordinator,runKey),deadline);
  let sum;
  try {
    let checks;
    if(options.resume) {
      if(!fs.existsSync(summaryFile))throw new Error('Run not found: '+runId+' (no summary.json in '+dir+')');
      sum=readRunLedger(summaryFile,runId);
      if(sum.protocol!==2||!Array.isArray(sum.plan))throw new Error('This run has no recoverable task checkpoints');
      if((sum.agent||'codex')!==(options.agent||'codex'))throw new Error('Resume agent must match the saved run');
      if(path.resolve(sum.workspace)!==workspace||sum.runId!==runId)throw new Error('Run workspace/identity mismatch');
      validateRecoverySummary(sum);
      // 调用方自助通道：保存的运行用了调用方单元命令时，resume 必须重供同一条命令（防换命令重放副作用）。
      {const savedUnit=sum.unitProfile||null,givenUnit=options.unitProfile||null;
       if(savedUnit&&!givenUnit)throw new Error('This run used a caller-supplied unit command; re-supply the identical --unit-cmd/--unit-cmd-file to resume');
       if(savedUnit&&givenUnit&&JSON.stringify(savedUnit)!==JSON.stringify(givenUnit))throw new Error('Resume unit command differs from the saved run; refusing to resume');}
      // 容量按“剩余可用内存”浮动 ⇒ 恢复时机器更忙是常态（2026-09-18 实测：建账容量 4、恢复时
      // 可用内存掉到 <4，旧行为直接 FATAL，把合法账本拒之门外）。计划与块数不动（篡改上界已由
      // validateRecoverySummary 用总内存把住），只把“同时在飞的窗”收紧到当前容量，其余块照常排队
      // 等（reserve/backoff 的波次机制本就是这个用途）。绝不因“忙”把错误甩给调用方。
      if(sum.blocks.length>capacity){windowCap=Math.max(1,capacity);console.log(`[orchestrator] resume admission clamped to ${windowCap} (free-memory capacity ${capacity}, saved blocks ${sum.blocks.length}); remaining blocks queue in waves`);}
      checks=loadChecks(options.acceptanceFile||path.join(dir,'acceptance.json'));
      if(sum.acceptanceSha256&&checksHash(checks)!==sum.acceptanceSha256)throw new Error('Acceptance contract changed since run creation; refusing to resume');
      sum.history.push({generation:sum.generation,finishedAt:sum.finishedAt,success:sum.success});
      sum.generation++;delete sum.finishedAt;sum.success=false;
    }else {
      if(fs.existsSync(dir))throw new Error('Run ID already exists; use --resume-run or --verify-run');
      fs.mkdirSync(dir,{recursive:true});checks=loadChecks(options.acceptanceFile);
      atomicJson(path.join(dir,'manifest.json'),{runId,workspace,request,tasks:requestTasks(request),startedAt:Date.now()});
      // The CLI may have already performed the deterministic preflight needed to
      // decide whether a visible window is warranted. Reuse that exact plan so
      // the policy decision and the launched plan cannot diverge after a second
      // model classification or cache lookup.
      const candidate=options.plan||await hooks.plan(request,capacity);
      const {plan,tasks}=ledgerPlan(request,candidate,capacity,hooks.compact);
      const recs=plan.map((b,i)=>({key:`B${i+1}`,title:b.title,b,dependsOn:b.dependsOn||[],keys:[...new Set([...(b.conflictKeys||[]),...b.tasks.flatMap(t=>hooks.infer(t.prompt||''))].map(k=>canonicalKey(k,workspace)))]}));
      levelWaves(recs);
      sum={protocol:2,version:CORE_VERSION,agent:options.agent||'codex',runId,workspace,request,capacity,coordinator,generation:1,history:[],startedAt:Date.now(),bootId:bootId(),tasks,plan:recs,spawnMode:options.spawnMode||'window',
        model:options.modelPlan?.model??null,effort:options.modelPlan?.effort??null,modelSource:options.modelPlan?.modelSource??null,effortSource:options.modelPlan?.effortSource??null,
        blocks:recs.map(r=>({key:r.key,title:r.title,taskIds:r.b.tasks.flatMap(t=>t.sourceIds)})),results:{},taskResults:{}};
      for(const r of recs){sum.results[r.key]={status:'pending',attempts:[]};for(const id of sum.blocks.find(b=>b.key===r.key).taskIds)sum.taskResults[id]={status:'pending'};}
      sum.acceptanceSha256=checksHash(checks);
      if(options.unitProfile)sum.unitProfile=options.unitProfile;
    }
    sum.owner=claim.owner;sum.coordinator=coordinator;
    {
      const keyDiff=acceptanceKeyDiff(checks,sum.tasks);
      if(keyDiff?.unknown.length)throw new Error('Acceptance keys do not match any task id: '+keyDiff.unknown.join(', ')+'（task ids: '+sum.tasks.map(t=>t.id).join(', ')+'）');
      if(keyDiff?.missing.length)console.warn('[orchestrator] acceptance has no checks for task(s): '+keyDiff.missing.join(', ')+'；这些任务将停在 awaiting-verification');
    }
    atomicJson(path.join(dir,'acceptance.json'),checks);
    const eventsFile=path.join(dir,'events.jsonl');
    let lastBoardSig='';
    const emitBoard=()=>{try{const sig=boardSignature(sum);if(sig===lastBoardSig)return;lastBoardSig=sig;fs.appendFileSync(eventsFile,JSON.stringify(boardJson(sum))+'\n');console.log(boardSummaryLine(sum));}catch{/* board is best-effort; never fail the run */}};
    const persist=()=>{atomicJson(summaryFile,sum);emitBoard();};
    // 终态收口（2026-10-24）：414（预算耗尽）/429（窗口等待超时）/550（run deadline）三个出口原来只写
    // status，不写 endedAt ⇒ 账本分不清「没跑」与「跑了没收尾」，且 --verify-run 会把它当成另一份真相。
    // 现在：终态补 endedAt，并（仅当该块真有 attempt 时）按盘上证据重算一次 status——零 attempt 的块
    // 没有证据可算，硬算只会把 timeout/blocked 的真实原因降级成 failed。
    const mark=(r,status,reason)=>{
      const prior=sum.results[r.key]||{},taskIds=sum.blocks.find(b=>b.key===r.key).taskIds;
      sum.results[r.key]={...prior,status,reason};
      for(const id of taskIds)if(sum.taskResults[id]?.status!=='verified')sum.taskResults[id]={...sum.taskResults[id],status,reason};
      if(TERMINAL.has(status)){
        if(sum.results[r.key].attempts?.length)try{reconcileWithEvidence(sum,checks,workspace);}catch{}
        if(!sum.results[r.key].endedAt)sum.results[r.key].endedAt=Date.now();
      }
      persist();
    };
    persist();console.log(`[run] runId=${runId} blocks=${sum.blocks.length} capacity=${capacity} generation=${sum.generation} summary=${summaryFile}`);
    // 环境监测行（2026-09-18）：run 起点与终点各打一行，测试/用户都能直接看到平台、Node、可用内存与准入容量。
    console.log(`[env] phase=start platform=${process.platform} node=${process.version} free=${Math.round(os.freemem()/1024**2)}MB total=${Math.round(os.totalmem()/1024**2)}MB capacity=${capacity}`);
    // Auto-recovery: a detached guardian watches this controller and relaunches
    // --resume-run if it dies before finalizing. 2026-10-25（F7）：resume 也要装——原注释
    // 「resumed run 已被原 guardian 看着」不总成立：guardian 可能已 exhausted
    // （run-guardian.mjs 的 finish('exhausted')）或被杀，此时账本会永停在「无 finishedAt」，
    // verify 永远报 Run is not finalized（runId ea010891 的另一入口）。ensureRunGuardian
    // 自带 already 幂等短路（见 guardianPid 活着且命令行含 runId 就返回 {already:true}），
    // 原 guardian 仍在时这里是 no-op。Never let the guard fail a run.
    if(hooks.guardian)try{hooks.guardian({runId,workspace,stateDir:options.stateDir,coordinator,timeoutMs:options.timeoutMs||21600000,owner:claim.owner,dir});}catch(e){console.warn('[guardian] unavailable: '+e.message);}
    // Optional spawn pacing (options.spawnStaggerMs, from ORCH_WINDOW_STAGGER_MS):
    // serializes window births within this run so a burst of first turns cannot
    // trip the agent account's per-minute rate limiter. 0 keeps the burst as-is.
    const staggerMs=Math.max(0,Number(options.spawnStaggerMs||0));
    let staggerChain=Promise.resolve();
    const stagger=()=>{const turn=staggerChain;staggerChain=staggerChain.then(()=>pause(staggerMs));return turn;};
    async function execute(r) {
      const b=sum.blocks.find(b=>b.key===r.key),tasks=b.taskIds.map(id=>sum.tasks.find(t=>t.id===id));
      const leaseId=crypto.createHash('sha256').update(runKey).digest('hex').slice(0,16)+'-'+r.key;
      let attemptsThisController=0,spawnConfirmed=false,transientRetries=0,transientGrant=false,unproductiveRetries=0,unprovenRetries=0,peakSampled=false;
      const limit=Math.max(1,Math.min(3,Number(options.maxAttempts||2)));
      while(Date.now()<deadline) {
        let e=sum.results[r.key],la=e.launcherFiles,identity;spawnConfirmed=false;
        // 采纳读加固（2026-09-16 L5 复跑实逮）：**接管（generation>1）且单元还没出结果**时，全量快照会
        // 瞬时缺失/超时（见 identityWithGrace 注释），单次读失手会把「还活着的单元」误判为未采纳 ⇒ 走
        // recovery 误收口（实测 headless 接管引擎 ~3s 内把在飞单元判 needs-reconciliation）；此时改用与
        // spawn 读同一套宽限重试（identityWithGrace 默认 10s／800ms；仍无则按未采纳走 recovery，且宽限
        // 期间引擎存活⇒二次杀有靶）。首轮（fresh）与已有结果文件的路径保持单读旧语义（fresh 判据零扰动）。
        if(la)try{identity=(Number(sum.generation)>1&&!fs.existsSync(la.rf))?await identityWithGrace(hooks,la):launcherIdentity(hooks.readPid(la.pidf),la.pidf);}catch{identity=undefined;}
        const adopted=identity&&(!e.launcher||sameProcess(e.launcher,identity));
        let active;
        if(adopted) {
          active=e.attempts.at(-1);console.log(`[resume] adopting live ${r.key}; no duplicate window`);
        }else {
          const cps=blockCheckpoints(e,b,sum);
          const recovery=recoveryTasks(tasks,cps,checks,workspace);
          Object.assign(sum.taskResults,recovery.results);
          if(recovery.verified.length===tasks.length){e.status='verified';e.endedAt=Date.now();persist();return;}
          if(recovery.uncertain.length){
            // 瞬时故障自动处理：单元“启动即死”（无终态检查点）且最近尝试存活时长短 ⇒ 自动重跑一轮，
            // 而不是把"不确定"直接当结论。retrySafe:false 可否决（连瞬时也不重跑）；未声明=允许瞬时重跑。
            const runtimeMs=Math.max(0,(e.endedAt||Date.now())-(e.startedAt||Date.now()));
            const envRetries=Number(process.env.ORCH_TRANSIENT_RETRIES);
            const transientMax=Number.isFinite(envRetries)&&envRetries>=0?Math.floor(envRetries):TRANSIENT_RETRIES;
            const transientWindowMs=Math.max(1000,Number(process.env.ORCH_TRANSIENT_WINDOW_MS||TRANSIENT_WINDOW_MS)||TRANSIENT_WINDOW_MS);
            const transientBackoffMs=Math.max(0,Number(process.env.ORCH_TRANSIENT_BACKOFF_MS||TRANSIENT_BACKOFF_MS)||TRANSIENT_BACKOFF_MS);
            const transient=transientRetries<transientMax&&runtimeMs<=transientWindowMs&&recovery.uncertain.every(id=>{
              const cp=cps[id];
              return cp&&cp.state==='started'&&!taskPolicy(checks[id]).retryVeto;
            });
            if(transient){
              transientRetries++;transientGrant=true;
              e.transientRetries=(e.transientRetries||0)+1;
              e.transientReason=`unit exited after ${Math.round(runtimeMs/1000)}s with no terminal checkpoint`;
              console.log(`[recovery] ${r.key}: transient unit failure (${e.transientReason}) -> auto-retry ${transientRetries}/${transientMax}`);
              for(const id of recovery.uncertain){recovery.pending.push(id);delete recovery.results[id];}
              recovery.uncertain=[];
              persist();
              await pause(Math.min(transientBackoffMs+Math.floor(Math.random()*transientBackoffMs),Math.max(0,deadline-Date.now())));
            }else{
              // 无成果重跑（2026-10-11 用户口径）：单元“跑了一阵、既没有已证成果、也没声明可重跑”时，
              // 不再把“不确定”直接当结论 —— 与瞬时/无产出两档同构，自动补跑一次（独立预算
              // ORCH_UNPROVEN_RETRIES，默认 1，0=关闭；retrySafe:false 照旧可否决）。重跑=任务回到
              // pending 走同一条窗口流水线；已验证任务本就禁止重做，重复副作用面仅限未验过的任务。
              const unprovenEnv=Number(process.env.ORCH_UNPROVEN_RETRIES);
              const unprovenMax=Number.isFinite(unprovenEnv)&&unprovenEnv>=0?Math.floor(unprovenEnv):1;
              const unproven=unprovenRetries<unprovenMax&&recovery.uncertain.every(id=>!taskPolicy(checks[id]).retryVeto);
              if(unproven){
                unprovenRetries++;transientGrant=true;
                e.unprovenRetries=(e.unprovenRetries||0)+1;
                e.unprovenReason=`no proven result after ${Math.round(runtimeMs/1000)}s for ${recovery.uncertain.join(', ')}`;
                console.log(`[recovery] ${r.key}: no proven result (${e.unprovenReason}; not declared retryable) -> auto-retry ${unprovenRetries}/${unprovenMax}`);
                for(const id of recovery.uncertain){recovery.pending.push(id);delete recovery.results[id];}
                recovery.uncertain=[];
                persist();
                await pause(Math.min(transientBackoffMs+Math.floor(Math.random()*transientBackoffMs),Math.max(0,deadline-Date.now())));
              }else{
                e.status='needs-reconciliation';e.reason='Uncertain tasks: '+recovery.uncertain.join(', ')+' — hint: declare {"checks":[...],"retrySafe":true} for idempotent tasks so the engine auto-retries instead of reporting';e.endedAt=Date.now();persist();return;
              }
            }
          }
          if(attemptsThisController>=limit&&!transientGrant){
            // 无产出单元自动补一次：整块剩余任务从未写过终态检查点（缺少检查点或停在 started）时，
            // 说明这轮 agent 只是“说了没干”（模型偶发跑偏/被中断/只顾分析），属可自愈的瞬时行为，
            // 不该把失败直接甩给调用方。次数由 ORCH_UNPRODUCTIVE_RETRIES 控制（默认 1，0=关闭）。
            const unproductiveMax=(()=>{const v=Number(process.env.ORCH_UNPRODUCTIVE_RETRIES);return Number.isFinite(v)&&v>=0?Math.floor(v):1;})();
            const noProgress=recovery.pending.length>0&&recovery.pending.every(id=>!cps[id]&&!taskPolicy(checks[id]).retryVeto);
            if(noProgress&&unproductiveRetries<unproductiveMax){
              unproductiveRetries++;transientGrant=true;
              e.unproductiveRetries=(e.unproductiveRetries||0)+1;
              console.log(`[recovery] ${r.key}: unproductive unit (no terminal checkpoint for any remaining task, last reason: ${String(e.reason||'none')}) -> auto-retry ${unproductiveRetries}/${unproductiveMax}`);
            }else{
              mark(r,'failed','Safe recovery attempt budget exhausted'+(e.reason?': '+e.reason:''));return;
            }
          }
          transientGrant=false;
          if(attemptsThisController)await pause(Math.min(2000*attemptsThisController,Math.max(0,deadline-Date.now())));
          let reserved=false,waitAttempt=0,waitStart=Date.now(),lastReason='';
          while(Date.now()<deadline) {
            const result=await coordinate(()=>reserve(coordinator,{id:leaseId,runId,keys:r.keys},windowCap),deadline);
            if(result.ok){reserved=true;if(waitAttempt)console.log(`[queue] ${r.key}: window slot acquired after ${waitAttempt} wait(s)`);break;}
            // 排队退避（指数+抖动）：不再每秒重试；等待状态仅在理由变化时重写，少刷账本。
            lastReason=String(result.reason||'');
            const waitMsg='Waiting for '+result.reason,cur=sum.results[r.key];
            if(!cur||cur.status!=='waiting'||cur.reason!==waitMsg){mark(r,'waiting',waitMsg);console.log(`[queue] ${r.key}: ${waitMsg} — backing off (wait #${waitAttempt+1}); waiting is normal under machine-level contention, not a hang`);}
            await pause(Math.min(waitBackoffMs(waitAttempt++,WAIT_BACKOFF),Math.max(0,deadline-Date.now())));
          }
          if(!reserved){const mins=Math.round((Date.now()-waitStart)/60000);mark(r,'timeout',`Window capacity/resource wait timed out after ~${mins}min (last reason: ${lastReason||'unknown'}). Another run holds the window slots or the same files; this is a machine-level wait, not a unit failure — retry when the machine is quieter, or reduce concurrent runs.`);return;}
          attemptsThisController++;
          const number=e.attempts.length+1,token=runId+'-'+r.key+'-a'+number+'-'+crypto.randomBytes(6).toString('hex');
          const attemptFile=path.join(dir,'attempts',r.key,String(number),'attempt.json');
          active={file:attemptFile,runId,token,number,taskIds:recovery.pending,createdAt:Date.now()};
          atomicJson(attemptFile,active);e.attempts.push(active);
          const helper=fileURLToPath(new URL('./checkpoint.mjs',import.meta.url));
          // checkpoint 载体（2026-10-01）：宿主直接拼 `node "abs" "abs" <id> <state>` 在跨 shell 场景下会被
          // 引号语义吃掉（cmd 把引号并进路径 ⇒ MODULE_NOT_FOUND；Git Bash 宿主则会陷入 MSYS/cmd 多层转义的
          // 自我推演而根本不执行）。这里为每个 attempt 预生成一个路径写死的 checkpoint.cmd，prompt 只下发
          // 单一令牌 + id + state，宿主无需理解任何 shell 语义。
          const cpCmdFile=path.join(path.dirname(attemptFile),'checkpoint.cmd');
          fs.writeFileSync(cpCmdFile,
            '@echo off\r\n'+
            'node "'+escapeCmdBatchPath(helper)+'" "'+escapeCmdBatchPath(attemptFile)+'" %1 %2\r\n'+
            'exit /b %errorlevel%\r\n','utf8');
          const command=(id,state)=>`"${cpCmdFile}" ${id} ${state}`;
          const body=options.auth+'\n本窗目录为 '+workspace+'；所有工具 workdir 保持此目录，除非原始任务明确另指定。\n'+
            '仅按顺序执行下列待办任务。每项开始前必须成功执行 started 命令，失败则停止该项，禁止重复执行。完成并自验后立即执行 completed 命令。每项都立即写检查点，不能等整块完成。任何项失败则停止后续任务，说明情况并退出本轮，不自行重跑整块。\n'+
            '【硬规则】检查点命令形如 "<路径>\\checkpoint.cmd" <任务ID> <状态> —— 它是一条**完整可执行命令**（路径已写死在该 .cmd 内）。PowerShell（Codex Windows 默认 shell）执行带引号路径时必须使用调用运算符 `& "<路径>\\checkpoint.cmd" <任务ID> <状态>`；cmd.exe 或 Git Bash 则使用各自宿主的原生执行方式，不要把命令再交给另一层 shell 包装，也不要把路径内引号当成命令名。不要拆分、重组或改写路径和参数。执行后必须确认该 attempt 的 checkpoints/<任务ID>.json 已生成（状态为 started 或 completed），未生成即视为该命令失败。\n'+
            (recovery.verified.length?'已独立验收的任务禁止重做：'+recovery.verified.join(', ')+'\n':'')+
            '【硬规则】本窗只做下列任务：不要阅读、分析或讨论本提示词的生成方式或编排器的实现（runner、模板、检查点工具内部细节），也不要据此推断任务背景；下面给出的命令行照原样执行即可。\n'+
            recovery.pending.map(id=>`任务 ${id}\n开始前：${command(id,'started')}\n原始任务：${tasks.find(t=>t.id===id).prompt}\n完成自验后：${command(id,'completed')}`).join('\n\n')+
            '\n全部待办完成后，最后仅输出 __ORCH_DONE__ '+token;
          try{la=hooks.launcher(r.key,hooks.prompt(body,token),runId+'-a'+number);}
          catch(error){await coordinate(()=>release(coordinator,leaseId),deadline);throw error;}
          e={...e,status:'launching',leaseId,token,launcherFiles:la,launcher:null,endedAt:null,startedAt:Date.now()};sum.results[r.key]=e;persist();
          try {
            hooks.register({id:leaseId,runId,title:r.title,keys:r.keys,pidFile:la.pidf,pid:0,pending:true,sanctionToken:la.sanctionToken,reservedAt:Date.now()});
            await coordinate(()=>prepare(coordinator,leaseId,la.pidf),deadline);
            await stagger();
            // 起窗重试预算：交给 spawnHeadlessWithRetry 自己的默认值（3），不再写死 1。
            // 实测（exam-v6-opencode）：传 1 时 35s 确认窗一次不过即抛 'Visible window did not start'，
            // 一个 12 题巨块因此整块判死（run.log: "launch FAILED after 1 attempts for [fit-merged-12]"）。
            // spawnHeadlessWithRetry 的形参默认值本就是 3，原注释写明「keep the retry budget for
            // cold-start hiccups」——调用方传 1 把这层保护作废了。
            if(!await hooks.spawn(la.lp,r.title,la.pidf,3,token))throw new Error('Visible window did not start');
            spawnConfirmed=true;
            // 秒退单元：结果文件已落盘时无需身份绑定（launcher 已退出，身份无法取得），直接进入结果读取路径。
            if(fs.existsSync(la.rf)){
              console.log(`[run] ${r.key} launcher already finished; reading its result without identity binding`);
              identity=null;
            }else{
              identity=await identityWithGrace(hooks,la);
              if(!identity)throw new Error('Launcher process identity mismatch');
              await coordinate(()=>bind(coordinator,leaseId,identity),deadline);hooks.commit(leaseId,identity.ProcessId);
            }
          }catch(error){e.status='popup-failed';e.reason=error.message;}
        }
        e=sum.results[r.key];e.launcher=identity||e.launcher;
        try {
          if(identity||fs.existsSync(la.rf)) {
            e.status='running';persist();
            // 0.9.17：单元起来了 ⇒ 挂通用采样器（拿根 pid 收进程树峰值；成败都不影响编排）。
            peakSampled=startUnitSampler(la, r.key, active.token, Number(identity?.ProcessId||hooks.readPid(la.pidf)), identity?.Started)||peakSampled;
            const session=hooks.session?await hooks.session('【本块唯一标识】'+active.token,Math.min(90000,Math.max(0,deadline-Date.now())),la.rf):null;
            const unitBudget=Math.max(0,Math.min(deadline,Date.now()+UNIT_TIMEOUT_MS)-Date.now());
            let waited;
            if (session) waited=await waitWithStallWatchdog(hooks,la,session,active,unitBudget);
            else {
              // 2026-09-18：TUI 窗不会自己退（如 hermes chat --tui）⇒ 以「盘上验收已满足」作为合法 done
              //（"看验收就收窗"）：每 10s 检查本块任务是否已被盘上证据全数验证；是 ⇒ 收口并关窗（finally 里统一关）。
              // 2026-09-22（第 3 轮 S2 真机实测）：这条路原来**只有**运行上限（默认 45min），没有首检查点期限。
              // 实测场景：未受信任工作区里 codex 停在"是否信任本目录"的可见提示上 ⇒ 宿主会话文件永远不会出现
              //（session=null 走这里）⇒ 账本 200s+ 停在 ▶ running，既不说真因也不重试，直到 45 分钟上限。
              // 补上与 stall 看门狗**同源**的首检查点期限（默认 1200000ms=20 分钟，0=关闭；2026-10-09 由 300s
              // 上调，慢启动宿主实测依据见 waitWithStallWatchdog 处的注释）：一个单元连第一项任务都没开工，
              // 就该像会话路径一样收口重跑并在 reason 里说清，而不是把调用方吊在运行上限上。
              const endAt=Date.now()+unitBudget;
              let done=false,exitCode=null;
              const rawFirst=process.env.ORCH_UNIT_FIRST_CHECKPOINT_MS;
              const firstCheckpointMs=rawFirst===undefined?1200000:Math.max(0,Number(rawFirst)||0);
              const cpDir=path.join(path.dirname(active.file),'checkpoints');
              const cpDirMtime=()=>{try{return fs.statSync(cpDir).mtimeMs;}catch{return 0;}};
              const waitStarted=Date.now(),waitBaseline=Number(active?.createdAt)||waitStarted;
              let stall=null;
              while(Date.now()<endAt){
                if(fs.existsSync(la.rf)){done=true;exitCode=hooks.exitCode(la.rf);break;}
                const cps=blockCheckpoints(e,b,sum);
                const rec=recoveryTasks(tasks,cps,checks,workspace);
                if(rec.verified.length===tasks.length){done=true;exitCode=0;break;}
                if(firstCheckpointTimedOut({firstCheckpointMs,now:Date.now(),baseline:waitBaseline,checkpointMtime:cpDirMtime()})){
                  stall='unproductive: no task checkpoint within '+Math.round(firstCheckpointMs/1000)+'s (the unit never started its first task; a hidden TUI can be sitting on a prompt that needs a human); retrying within the attempt budget';
                  break;
                }
                await pause(10000);
              }
              waited=stall?{stall}:{result:{done,exitCode}};
            }
            if(waited.stall){e.status='failed';e.reason=waited.stall;}
            else {const result=waited.result||{};e.exitCode=result.exitCode??hooks.exitCode(la.rf);e.status=result.done?'awaiting-verification':'timeout';if(result.terminal){e.status='failed';e.reason=result.text||'Adapter preflight failed';e.terminalFailure=true;}}
          }
        }catch(error){e.status='failed';e.reason=error.message;}
        finally {
          // 收尾的每一步必须彼此隔离（2026-10-24 事故：runId 6f7b8f2e / ea010891 都是收尾中断 ⇒ 账本停在
          // running、lease 没释放 ⇒ 同键块永远 reserve 失败 ⇒ 426/429 级联到 run deadline）。约定：易抛步骤
          // 逐个 try/catch，错误记到块上（e.*Error，不静默吞）；无论哪一步失败，内层 finally 都保证写
          // endedAt、按盘上证据重算并落盘。
          let launcherAlive=false;
          try {
            if(!identity&&la&&spawnConfirmed&&!fs.existsSync(la.rf))try{identity=await identityWithGrace(hooks,la,{graceMs:4000,intervalMs:300});}catch{identity=undefined;}
            if(identity)try{await hooks.close(identity.ProcessId,identity);}catch(error){e.closeError=String(error?.message??error);}
            if(identity){
              // 探活本身失败 ≠ 进程已退：保守按「可能还活着」处理（保留 lease）。把「不知道」当「已死」会在
              // 活窗还在改文件时放掉同键 lease ⇒ 两个单元同时写同一批文件（重复副作用，比占位更难恢复）；
              // 保留的 lease 由协调器的 stale 回收（bootId/owner 失效）或 recover-stale 收口，不会永久占位。
              try{launcherAlive=!(await waitForProcessExit(identity));}catch(error){launcherAlive=true;e.exitProbeError=String(error?.message??error);}
            }
            if(launcherAlive){
              e.status='failed';
              e.reason=e.exitProbeError?('Launcher liveness unknown ('+e.exitProbeError+'); lease retained'):'Launcher still alive; lease retained';
              return;   // 内层 finally 仍会写 endedAt / 按盘上证据重算 / 落盘
            }
            try{await coordinate(()=>release(coordinator,e.leaseId||leaseId),Date.now()+30000);}catch(error){e.leaseReleaseError=String(error?.message??error);}
            try{await recordUnitPeakIfReady(la, r.key, active?.token, options.agent || sum.agent || 'caller', peakSampled);}catch(error){e.peakRecordError=String(error?.message??error);}
            try{hooks.unregister(e.leaseId||leaseId);}catch(error){e.unregisterError=String(error?.message??error);}
            try{if(la)hooks.cleanup(la);}catch(error){e.cleanupError=String(error?.message??error);}
            // 2026-09-19：单元收尾后扫残窗（含"launcher 已死、WT 面板赖着"的僵尸窗）——只扫本单位自己那一扇（stem 过滤），
            // 绝不触碰并行中的其它窗：全域扫会在旁窗忙碌判定失败时误杀活窗。
            try{await hooks.sweep?.(active?.token?String(active.token):'');}catch{}
          } finally {
            e.endedAt=Date.now();if(active){active.endedAt=e.endedAt;active.exitCode=e.exitCode;}
            try{collectVerification(sum,checks,workspace);}catch(error){e.verificationError=String(error?.message??error);}
            persist();
          }
        }
        // 542 的 collectVerification 可能刚把这枚块按盘上证据改判成 verified —— 适配器的 terminal 结论
        // 不能反过来把「证据已证明做完」的块再压成 failed（潜伏：当前仓内无 terminalFailure producer）。
        if(e.terminalFailure&&e.status!=='verified'){mark(r,'failed',e.reason||'Adapter preflight failed');return;}
        if(e.status==='verified')return;
        // A launcher-start failure is recoverable. Let the normal attempt,
        // transient, and unproductive-retry budgets decide when to stop; an
        // early popup-failed return here used to bypass all recovery.
      }
      mark(r,'timeout','Run deadline exhausted');
    }
    const memCfg=memConfig();
    const memStore=loadUnitMemory(unitMemoryStorePath(process.env));
    const unitMb=unitEstimateMb(memStore,options.agent||sum.agent||'caller',memCfg);
    const expectedMemory=r=>estimateBlockMemoryMb(r.b,unitMb,memCfg);
    const onReadyWave=ready=>{
      const order=ready.map(({record,score})=>record.key+'('+score+'MB)').join(' -> ');
      console.log('[schedule] ready wave launch order: '+order);
    };
    await scheduleReady(sum.plan,async r=>{try{await execute(r);}catch(e){mark(r,'failed',e.message);}},key=>sum.results[key]?.status,
      (r,failed)=>mark(r,'blocked','Predecessors not verified: '+failed.join(', ')),
      {priority:expectedMemory,onWave:onReadyWave});
    for(const r of sum.plan)if(!TERMINAL.has(sum.results[r.key]?.status))mark(r,'failed','No terminal result');
    // 整轮收尾再按盘上证据重算一次（mark 已按块算过，但保证所有块同一时刻、同一份口径），
    // 让 run 自评与 --verify-run 读同一份 summary.json 得到同一个结论。
    finalizeRunLedger(sum,checks,workspace);persist();
    console.log(`[run] finalized runId=${runId} success=${sum.success} summary=${summaryFile}`);
    console.log(`[env] phase=final platform=${process.platform} node=${process.version} free=${Math.round(os.freemem()/1024**2)}MB total=${Math.round(os.totalmem()/1024**2)}MB concluded=${sum.concluded?'yes':'no'}`);return sum;
  }finally{await coordinate(()=>releaseRun(coordinator,runKey,claim),Date.now()+30000);}
}
