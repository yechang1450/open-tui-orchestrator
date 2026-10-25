import {levelWaves,verifyChecks,requestTasks,computeMaxWindows,staleEvidence} from './contracts.mjs';
import os from 'node:os';
import path from 'node:path';
import {realpathWithMissing,containedBy} from './path-security.mjs';

// Validate persisted structure before recovery can change state or invoke tools.
export function validateRecoverySummary(sum) {
  const fail=reason=>{throw new Error('Invalid recovery ledger: '+reason);};
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const strings=x=>Array.isArray(x)&&x.every(v=>typeof v==='string'&&v.length>0);
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const exact=(ids,value)=>object(value)&&new Set(ids).size===ids.length&&Object.keys(value).length===ids.length&&ids.every(id=>Object.hasOwn(value,id)&&object(value[id]));
  if(!object(sum)||sum.protocol!==2||!/^[-_a-zA-Z0-9]{1,100}$/.test(sum.runId||'')||typeof sum.workspace!=='string'||!sum.workspace||typeof sum.request!=='string'||!Number.isSafeInteger(sum.generation)||sum.generation<1||!Array.isArray(sum.history))fail('invalid header');
  if(sum.acceptanceSha256!==undefined&&(typeof sum.acceptanceSha256!=='string'||!/^[0-9a-f]{64}$/.test(sum.acceptanceSha256)))fail('invalid acceptance hash');
  const tasks=requestTasks(sum.request);
  if(!tasks.length||!Array.isArray(sum.tasks)||!same(sum.tasks.map(t=>({id:t?.id,prompt:t?.prompt})),tasks))fail('original task inventory mismatch');
  // 块数上界是**可复算的合理性上界**，不是当时的活动容量：容量按"剩余可用内存"算会随机器负载浮动，
  // 若拿它当恢复门，一台忙起来的机器会把合法账本误判成篡改（2026-09-17 实测：GiB 喂给新公式直接把上界算成 1）。
  // 用总内存推上界：稳定、可复算，且恒 ≥ 任何"剩余可用"推出的容量（可用内存 ≤ 总内存）。
  if(!Array.isArray(sum.blocks)||!sum.blocks.length||sum.blocks.length>computeMaxWindows(os.totalmem()/1024**2)||!Array.isArray(sum.plan)||sum.plan.length!==sum.blocks.length)fail('block inventory mismatch');
  const ids=tasks.map(t=>t.id),blockIds=sum.blocks.map(b=>b?.key);
  if(!strings(blockIds)||!exact(blockIds,sum.results)||!exact(ids,sum.taskResults))fail('result inventory mismatch');
  const covered=[];
  // resolve 后的盘符根自带尾分隔符（D:\），再拼一个 sep 会变 D:\\ 导致根工作区的
  // 合法 launcherFiles 全被误判为逃逸（E 验收实跑发现）；只在缺尾分隔符时补。
  const resolvedWorkspace=path.resolve(sum.workspace);
  const stateRoot=path.join(resolvedWorkspace,'temp');
  const realWorkspace=realpathWithMissing(resolvedWorkspace),realStateRoot=realpathWithMissing(stateRoot);
  const insideWorkspace=file=>containedBy(realWorkspace,realpathWithMissing(path.resolve(resolvedWorkspace,file)));
  const insideStateRoot=file=>containedBy(realStateRoot,realpathWithMissing(path.resolve(resolvedWorkspace,file)));
  for(let i=0;i<sum.blocks.length;i++) {
    const block=sum.blocks[i],plan=sum.plan[i],entry=sum.results[block.key];
    if(!strings(block.taskIds)||!block.taskIds.length||!object(plan)||plan.key!==block.key||!strings(plan.keys)||!strings(plan.dependsOn)||!Array.isArray(plan.b?.tasks))fail('invalid block or plan');
    if(!plan.b.tasks.every(t=>strings(t?.sourceIds)&&t.sourceIds.length)||!same(plan.b.tasks.flatMap(t=>t.sourceIds),block.taskIds))fail('plan task coverage mismatch');
    covered.push(...block.taskIds);
    if(!Array.isArray(entry.attempts))fail('missing attempt inventory');
    // launcherFiles 会被 resume 的 adopt/cleanup 直接使用（含 rmSync）：每个路径都必须
    // 解析到本工作区之内，否则被篡改的账本能借控制器之手删工作区外的任意文件。
    for(const f of Object.values(entry.launcherFiles||{})) {
      const resolved=typeof f==='string'&&f?path.resolve(resolvedWorkspace,f):'';
      if(!resolved||!insideWorkspace(resolved))fail('launcher files escape the workspace');
    }
    if(!entry.attempts.length&&(entry.launcherFiles||entry.launcher||entry.token||['launching','running','verified','awaiting-verification'].includes(entry.status)))fail('launched block has no attempt inventory');
    for(const attempt of entry.attempts) {
      if(!object(attempt)||attempt.runId!==sum.runId||typeof attempt.token!=='string'||!attempt.token||typeof attempt.file!=='string'||!attempt.file||!insideStateRoot(attempt.file)||!strings(attempt.taskIds)||!attempt.taskIds.length||new Set(attempt.taskIds).size!==attempt.taskIds.length||attempt.taskIds.some(id=>!block.taskIds.includes(id)))fail('invalid attempt identity or task coverage');
    }
  }
  if(covered.length!==ids.length||new Set(covered).size!==ids.length||covered.some(id=>!ids.includes(id)))fail('incomplete or duplicate task coverage');
  try{levelWaves(structuredClone(sum.plan));}catch(error){fail(error.message);}
  return sum;
}

export async function scheduleReady(recs,execute,status,onBlocked=()=>{},options={}) {
  const waves=levelWaves(recs); // Validate the whole graph before any work starts.
  const priority=typeof options.priority==='function'?options.priority:()=>0;
  const index=new Map(recs.map((r,i)=>[r.key,i]));
  const score=r=>{const value=Number(priority(r));return Number.isFinite(value)?value:0;};
  const compare=(a,b)=>{const delta=score(b)-score(a);return delta||((index.get(a.key)??0)-(index.get(b.key)??0));};
  // 依赖语义**不得**退化成「整波栅栏」：每个块只等它自己的前置（原实现），
  // 与它同波但不相关的块不得拖住它——否则一个长块会把同波所有依赖块一起拖到它结束。
  // 本轮只加两件事：① start() 的调用顺序按预计内存降序（高者先弹出，同分按原索引稳定）；
  // ② 每波启动前报一次 launch order（日志与事实一致：第一次真要跑该波时才报）。
  const byKey=new Map(recs.map(r=>[r.key,r])),jobs=new Map();
  const waveOf=new Map();waves.forEach((w,i)=>w.forEach(r=>waveOf.set(r.key,i)));
  const reported=new Set();
  const reportWave=r=>{
    if(typeof options.onWave!=='function')return undefined;
    const i=waveOf.get(r.key);
    if(i===undefined||reported.has(i))return undefined;
    reported.add(i);
    return options.onWave([...waves[i]].sort(compare).map(x=>({record:x,score:score(x)})));
  };
  const start=r=>{
    if(jobs.has(r.key))return jobs.get(r.key);
    const job=Promise.resolve().then(async()=>{
      await Promise.all(r.dependsOn.map(id=>start(byKey.get(id))));
      await reportWave(r);
      const failed=r.dependsOn.filter(id=>status(id)!=='verified');
      if(failed.length)return onBlocked(r,failed);
      return execute(r);
    });
    jobs.set(r.key,job);return job;
  };
  await Promise.all([...recs].sort(compare).map(start));
}

// retrySafe 三态：true=总是可重跑；false=明确否决（连瞬时故障也不重跑）；未声明=仅对"瞬时故障特征"
// 自动重跑（见 runner.mjs 的 TRANSIENT_RETRIES）。retryVeto 让"未声明"与"明确否决"可区分——
// 旧实现两者都塌缩成 false，导致合法账本在偶发故障时只能停在 needs-reconciliation。
export const taskPolicy=value=>Array.isArray(value)?{checks:value,retrySafe:false,retryVeto:false}:{checks:value?.checks||[],retrySafe:value?.retrySafe===true,retryVeto:value?.retrySafe===false};
export function recoveryTasks(tasks,checkpoints,checks,workspace) {
  const result={verified:[],pending:[],uncertain:[],results:{}};
  for(const task of tasks) {
    const cp=checkpoints[task.id],policy=taskPolicy(checks[task.id]);
    if(!cp){result.pending.push(task.id);continue;}
    if(cp.state==='invalid'){result.uncertain.push(task.id);result.results[task.id]={status:'needs-reconciliation',reason:'Invalid checkpoint',checkpoint:cp};continue;}
    const verification=verifyChecks(policy.checks,workspace);
    // 2026-10-26（M5）：与 collectVerification 共用同一条新鲜度判据 —— checkpoint 停在 started 而
    // 验收通过的产物早于本次 startedAt 时，那是「上一代留下的旧产物」，不能算本次完成。
    // 不同步的后果（审查实测指出）：resume 把任务判 verified 直接跳过 → runner 的等待循环据此收窗 →
    // **杀掉还在写文件的单元**；收尾时同一账本又被 collectVerification 判 needs-reconciliation → run 假失败。
    const stale=(verification.status==='verified'&&cp.state==='started')?staleEvidence(policy.checks,workspace,cp.startedAt):[];
    if(verification.status==='verified'&&stale.length===0){result.verified.push(task.id);result.results[task.id]={...verification,checkpoint:cp};}
    else if(stale.length){result.uncertain.push(task.id);result.results[task.id]={status:'needs-reconciliation',reason:'Task started but evidence predates this attempt: '+stale.join(', '),verification,checkpoint:cp};}
    else if(policy.retrySafe){result.pending.push(task.id);}
    else {result.uncertain.push(task.id);result.results[task.id]={status:'needs-reconciliation',reason:'Started task has no proven result and is not declared safe to retry',hint:'Declare {"checks":[...],"retrySafe":true} for this task if it is idempotent so the engine auto-retries instead of reporting; otherwise inspect the workspace for the product (it may exist outside the checked path) and the checkpoint under attempts/<block>/<n>/checkpoints/.',verification,checkpoint:cp};}
  }
  return result;
}
