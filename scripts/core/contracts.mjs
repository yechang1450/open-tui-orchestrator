import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import os from 'node:os';

export const CORE_VERSION = '2026.9.19-3';
export const SUCCESS = new Set(['verified']);
export const TERMINAL = new Set(['verified','failed','blocked','cancelled','awaiting-verification','preflight-failed','popup-failed','timeout','needs-reconciliation']);

// 剩余可用内存(MB) → 最大并发 TUI 窗数：每满 1000 MB 给 2 个窗口，向下取整，至少 1 个（2026-09-17 用户口径）。
// 例：剩用 8000 MB → 16 台并发；4G → 8；900 MB → 1（下限）。旧的"标称内存 GB × 3/4"（按总内存）已弃用：
// 它把别人已经占住的内存也算作自己的余量。为可测试而独立成函数。
// fresh 规划与 --resume-run 的恢复校验共用同一容量（contracts 放置以避免 recovery↔sdk 循环依赖）。
// 注意：恢复校验里的"块数上界"用**总内存**推，保持可复算稳定（见 recovery.mjs）。
// 开机标识（2026-09-18 断电恢复 P0）：用 uptime 反推开机时刻，秒级取整——同一次开机的所有进程算出
// 同一个值，跨重启必变。PID 跨重启会重用，时间戳会被改，只有它能确定性判定“这条记录来自上一次开机”。
export function bootId() { return Math.floor((Date.now() - os.uptime() * 1000) / 1000); }
export function computeMaxWindows(availableMemoryMb) {
  const mb = Number(availableMemoryMb);
  if (!Number.isFinite(mb) || mb <= 0) return 1;
  return Math.max(1, Math.floor(mb / 1000) * 2);
}

export function summaryComplete(sum, strict = true) {
  if (!sum?.runId || !Array.isArray(sum.blocks) || !Array.isArray(sum.tasks) || !sum.blocks.length || !sum.tasks.length) return false;
  const exact = (ids, obj) => ids.length === new Set(ids).size && Object.keys(obj || {}).length === ids.length && ids.every(id => Object.hasOwn(obj || {}, id));
  if (!exact(sum.blocks.map(b=>b.key),sum.results) || !exact(sum.tasks.map(t=>t.id),sum.taskResults)) return false;
  const statuses = strict ? SUCCESS : TERMINAL;
  return [...Object.values(sum.results),...Object.values(sum.taskResults)].every(r=>statuses.has(r?.status));
}

export function canonicalKey(key, cwd = process.cwd()) {
  const match = /^(file|dir):(.+)$/i.exec(String(key));
  if (!match) return String(key);
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(match[2]) || process.platform === 'win32';
  const api = windows ? path.win32 : path.posix;
  let p = api.resolve(cwd, match[2]);
  try { p = fs.realpathSync.native(p); } catch {
    // Resolve existing ancestors too, so a not-yet-created file beneath a junction
    // conflicts with the same target reached through its real directory.
    let parent=p; const tail=[];
    while (api.dirname(parent)!==parent && !fs.existsSync(parent)) {tail.unshift(api.basename(parent));parent=api.dirname(parent);}
    try {p=api.join(fs.realpathSync.native(parent),...tail);} catch {}
  }
  p=p.replaceAll('\\','/').replace(/\/+$/,'');
  return match[1].toLowerCase()+':'+(windows?p.toLowerCase():p);
}
export function keysOverlap(a,b) {
  return (a||[]).some(x=>(b||[]).some(y=>{
    x=canonicalKey(x); y=canonicalKey(y);
    if(x===y)return true;
    const xm=/^(file|dir):(.*)$/.exec(x),ym=/^(file|dir):(.*)$/.exec(y);
    if(!xm||!ym)return false;
    return xm[2]===ym[2] || (xm[1]==='dir'&&ym[2].startsWith(xm[2]+'/')) || (ym[1]==='dir'&&xm[2].startsWith(ym[2]+'/'));
  }));
}

export function levelWaves(recs) {
  const aliases=new Map();
  for(const r of recs) for(const alias of [r.key,r.title,r.b?.title].filter(Boolean)) {
    if(aliases.has(alias)&&aliases.get(alias)!==r.key)throw new Error('Ambiguous block identity: '+alias);
    aliases.set(alias,r.key);
  }
  for(const r of recs) r.dependsOn=[...new Set((r.dependsOn||[]).map(d=>{
    if(!aliases.has(d))throw new Error('Unknown dependency: '+d);
    const key=aliases.get(d); if(key===r.key)throw new Error('Self dependency: '+key);return key;
  }))];
  const pending=[...recs],done=new Set(),waves=[];
  while(pending.length) {
    const ready=pending.filter(r=>r.dependsOn.every(d=>done.has(d)));
    if(!ready.length)throw new Error('Cyclic dependencies: '+pending.map(r=>r.key).join(', '));
    waves.push(ready);for(const r of ready){done.add(r.key);pending.splice(pending.indexOf(r),1);}
  }
  return waves;
}

// 纯元指令句过滤（0.9.16）：分类器与请求切分都可能把「必须按上述顺序执行：…」这类只有约束、没有
// 动作或产物的元句当成一条任务（2026-09-18 验收实测：连真模型也照建不误，提示词规则不总是生效）。
// 判据＝首句命中元前缀（按上述/以上…顺序/先后/要求/依赖 或 以上任务请依次…），且前缀之后没有
// 任何具体物（路径/文件名/动作动词/业务名词）。命中即从任务清单剔除——但绝不剔到一条不剩（保底）。
const META_PREFIX_RE = /^(?:(?:必须|请|一定|务必|注意)?(?:严格)?(?:切)?(?:按|按照)?(?:上述|以上)(?:顺序|先后|次序|要求|依赖)|(?:上述|以上)(?:全部)?任务(?:请)?(?:依次|按顺序)?(?:执行|完成|处理|做))/;
const CONCRETE_RE = /[\/\\]|\.\w{1,6}\b|(?:修复|优化|修改|更新|检查|创建|生成|写入|读取|删除|实现|开发|添加|移除|重构|部署|安装|配置|登录|注册|下单|商品|订单|页面|接口|功能|按钮|数据|文件|模块|数据库|测试|文档|代码)/;
export function isMetaOnlyTask(prompt) {
  const seg = String(prompt || '').trim().split(/[。；;！!？?\n]/)[0].trim();
  if (!seg || !META_PREFIX_RE.test(seg)) return false;
  const tail = seg.replace(META_PREFIX_RE, '').trim().replace(/^[：:，,、\-]+/, '');
  return !CONCRETE_RE.test(tail);
}
export function requestTasks(request) {
  const text=String(request),parts=[];let start=0,quote='',depth=0;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(quote){if(c===quote&&text[i-1]!=='\\'&&text[i-1]!=='`')quote='';continue;}
    if(c==="'"&&/[\p{L}\p{N}]/u.test(text[i-1]||'')&&/[\p{L}\p{N}]/u.test(text[i+1]||''))continue;
    if(['"',"'",'`'].includes(c)){quote=c;continue;}
    if('([{'.includes(c)){depth++;continue;}if(')]}'.includes(c)){depth=Math.max(0,depth-1);continue;}
    const explicitNext=/^\s*(?:(?:项目|工程|project|proj)\s*[-/]?\s*\d+|(?:修复|优化|修改|更新|检查|创建)\s*\d{2,3}(?!\d))/i.test(text.slice(i+1));
    if(!depth&&(/[；;\n]/.test(c)||(/[，,。]/.test(c)&&explicitNext))){parts.push(text.slice(start,i));start=i+1;}
  }
  parts.push(text.slice(start));
  const all=parts.map(s=>s.trim()).filter(Boolean).map((prompt,i)=>({id:`T${String(i+1).padStart(3,'0')}`,prompt}));
  const kept=all.filter(t=>!isMetaOnlyTask(t.prompt));
  return kept.length?kept:all;
}
export function bindClassifiedTasks(request,classified) {
  const tasks=requestTasks(request),byId=new Map(tasks.map(t=>[t.id,t]));
  if(!Array.isArray(classified)||classified.length!==tasks.length||new Set(classified.map(t=>t.id)).size!==tasks.length||classified.some(t=>!byId.has(t.id)))throw new Error('Classified task inventory mismatch');
  return classified.map(t=>({...t,summary:byId.get(t.id).prompt,prompt:byId.get(t.id).prompt}));
}
export function ledgerPlan(request, candidate, capacity, compact) {
  const tasks=requestTasks(request);
  if(!tasks.length)throw new Error('Empty task inventory');
  let plan=structuredClone(candidate),assigned=new Set(),valid=true;
  for(const block of plan) for(const task of block.tasks||[]) {
    task.sourceIds=tasks.filter(t=>String(task.prompt||'').includes(t.prompt)).map(t=>t.id);
    if(!task.sourceIds.length)valid=false;
    for(const id of task.sourceIds){if(assigned.has(id))valid=false;assigned.add(id);}
  }
  // A model's omission or paraphrase must never discard the original instructions.
  // Retain the entire inventory in one serial block when coverage is uncertain.
  if(!valid||assigned.size!==tasks.length) plan=[{type:'linked',title:'complete-inventory',dependsOn:[],conflictKeys:[],tasks:tasks.map(t=>({...t,title:t.id,sourceIds:[t.id]}))}];
  plan=compact(plan,capacity);
  const ids=plan.flatMap(b=>b.tasks.flatMap(t=>t.sourceIds||[]));
  if(ids.length!==tasks.length||new Set(ids).size!==tasks.length)throw new Error('Task inventory mismatch');
  levelWaves(plan.map((b,i)=>({key:`B${i+1}`,title:b.title,b,dependsOn:b.dependsOn||[]})));
  return {plan,tasks};
}

export function sha256(file) {return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}

// 裸名可执行文件在 Windows 上会先按进程 cwd（编排器的 cwd = 任意工作区）解析，
// 在不受信目录里运行时构成二进制投毒入口。一律锚定到 SystemRoot；锚定目标不存在才回退裸名。
export function systemToolExe(name, env = process.env) {
  const anchored = path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', String(name));
  return fs.existsSync(anchored) ? anchored : String(name);
}
export function powershellExe(env = process.env) {
  const anchored = path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(anchored) ? anchored : 'powershell.exe';
}
export function verifyTask(receipt, task, checks, context) {
  if(!receipt || receipt.runId!==context.runId || receipt.token!==context.token || receipt.id!==task.id || receipt.status!=='completed')return {status:'failed',reason:'Missing or mismatched task receipt'};
  return verifyChecks(checks,context.workspace);
}
// 校验 acceptance 契约 key 与 task id 的一致性：unknown key（拼错/多余）= 直接报错；task 无 check = 告警（将停在 awaiting-verification）。
export function acceptanceKeyDiff(checks,tasks) {
  if(!checks||typeof checks!=='object'||Array.isArray(checks)||!Object.keys(checks).length)return null;
  const ids=[...(new Set((tasks||[]).map(t=>t?.id).filter(Boolean)))],keys=Object.keys(checks);
  const unknown=keys.filter(k=>!ids.includes(k)),missing=ids.filter(k=>!keys.includes(k));
  return (unknown.length||missing.length)?{unknown,missing}:null;
}

export function verifyChecks(checks,workspace) {
  if(!Array.isArray(checks)||!checks.length)return {status:'awaiting-verification',reason:'No parent-defined acceptance checks; window report is not proof of success'};
  const evidence=[];
  try {
    for(const check of checks) {
      if(check.type==='command') {
        if(!check.command||!Array.isArray(check.args))throw new Error('Command acceptance requires command and args');
        const result=spawnSync(check.command,check.args,{cwd:workspace,encoding:'utf8',windowsHide:true,shell:false,timeout:check.timeoutMs||30000});
        if(result.error||result.status!==(check.exitCode??0))throw new Error('Acceptance command failed: '+(result.error?.message||result.status));
        if(check.stdout!==undefined&&result.stdout.trim()!==check.stdout)throw new Error('Acceptance stdout mismatch');
        evidence.push({type:'command',command:check.command,args:check.args,exitCode:result.status});continue;
      }
      const file=path.resolve(workspace,check.path);
      if(check.type==='file') {
        if(!fs.existsSync(file))throw new Error('Acceptance file missing: '+file+(String(check.path)!==file?' (check.path="'+check.path+'")':''));
        if(!fs.statSync(file).isFile())throw new Error('Not a file: '+file);if(check.sha256&&sha256(file)!==check.sha256)throw new Error('Hash mismatch: '+file);}
      else if(check.type==='json') {
        if(!fs.existsSync(file))throw new Error('Acceptance file missing: '+file+(String(check.path)!==file?' (check.path="'+check.path+'")':''));
        let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){throw new Error('Acceptance JSON parse failed: '+file+': '+e.message);}
        for(const [key,expected] of Object.entries(check.equals||{})){
          if(!(key in value))throw new Error('JSON field missing: '+file+' key="'+key+'" expected='+JSON.stringify(expected));
          if(JSON.stringify(value[key])!==JSON.stringify(expected))throw new Error('JSON mismatch: '+file+' key="'+key+'" expected='+JSON.stringify(expected)+' actual='+JSON.stringify(value[key]));}}
      else if(check.type==='absent') {if(fs.existsSync(file))throw new Error('Unexpected path: '+file);}
      else throw new Error('Unsupported acceptance check: '+check.type);
      evidence.push({type:check.type,path:file,sha256:check.type==='absent'?undefined:sha256(file)});
    }
    return {status:'verified',evidence};
  } catch(e){return {status:'failed',reason:e.message};}
}
