import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {openclawArgs} from './openclaw-host.mjs';
import {nativeArgumentLines} from './native-argv.mjs';

const quote=(s)=>"'"+String(s).replaceAll("'","''")+"'";

// Per-unit state isolation (official env pair): each unit gets its own
// OPENCLAW_STATE_DIR (sessions/sqlite land there) while OPENCLAW_CONFIG_PATH
// keeps pointing at the real config (providers + default model). No internal
// hooks — the old bootstrap mechanism died with the 2026.9.2 internals.
function realConfigPath(env=process.env) {
  return env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(),'.openclaw','openclaw.json');
}
function unitStateDir(temp,stem) {
  const state=path.join(temp,'orchestrator','openclaw',stem);
  fs.mkdirSync(state,{recursive:true});
  return state;
}

// Planner: one read-only classify turn via `agent --local --json`.
export const OPENCLAW_DECOMPOSE_TIMEOUT_DEFAULT_MS = 240000;
export function openclawPlannerTimeoutMs(env = process.env) {
  const v = Number(env.ORCH_DECOMPOSE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : OPENCLAW_DECOMPOSE_TIMEOUT_DEFAULT_MS;
}
function openclawFinalText(value) {
  const res=(value&&value.result)||value||{};
  return String(
    (res.terminalReply&&res.terminalReply.text)||res.outputText||res.text||res.finalAssistantVisibleText||
    (Array.isArray(res.payloads)?res.payloads.map(p=>p.text||'').join(''):'')||
    (value&&value.outputText)||(value&&value.text)||''
  ).trim();
}
export async function runOpenClawPlanner(config,prompt,cwd) {
  const root=path.join(cwd,'temp','orchestrator','openclaw');
  fs.mkdirSync(root,{recursive:true});
  const state=fs.mkdtempSync(path.join(root,'planner-'));
  const args=[...openclawArgs(config,{model:process.env.ORCH_MODEL}),'--json','-m',prompt];
  try{
    return await new Promise((resolve,reject)=>{
      const child=spawn(config.bin,args,{cwd,env:{...process.env,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:realConfigPath(),NODE_DISABLE_COMPILE_CACHE:'1'},windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
      let raw='',errorText='',timedOut=false;
      const timer=setTimeout(()=>{timedOut=true;child.kill();},openclawPlannerTimeoutMs());
      child.stdout.on('data',b=>{raw+=b;if(raw.length>8000000)child.kill();});
      child.stderr.on('data',b=>{errorText+=b;});
      child.on('error',e=>{clearTimeout(timer);reject(e);});
      child.on('exit',code=>{
        clearTimeout(timer);
        try{
          if(timedOut||code!==0)throw new Error(timedOut?'OPENCLAW_PLANNER_TIMEOUT':'OPENCLAW_PLANNER_FAILED: exit '+code+(errorText?': '+String(errorText).slice(0,300):''));
          let value=null;
          try{value=JSON.parse(raw);}catch{throw new Error('OPENCLAW_PLANNER_UNPARSEABLE: '+JSON.stringify(String(raw).slice(0,200)));}
          if(value&&value.ok===false)throw new Error('OPENCLAW_PLANNER_ERROR: '+JSON.stringify(value.error||{}).slice(0,300));
          const final=openclawFinalText(value);
          if(!final)throw new Error('OPENCLAW_PLANNER_EMPTY_RESPONSE');
          resolve({final});
        }catch(e){reject(e);}
      });
    });
  } finally {
    try{fs.rmSync(state,{recursive:true,force:true});}catch{/* best effort */}
  }
}

export function writeOpenClawLauncher(config,{key,prompt,suffix,workspace,temp}) {
  const stem=String(key+'-'+suffix).replace(/[^a-zA-Z0-9_-]/g,'-');
  const token=/【本块唯一标识】\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(prompt)?.[1];
  if(!token)throw new Error('OpenClaw window requires a completion token');
  const sanctionToken=crypto.randomBytes(18).toString('hex');
  const state=unitStateDir(temp,stem);
  const lp=path.join(temp,'win-launch-'+stem+'.ps1');
  const pidf=path.join(temp,'window-'+stem+'.pid');
  const pf=path.join(temp,'agent-win-'+stem+'.md');
  const rf=path.join(temp,'win-'+stem+'.result.json');
  const log=path.join(temp,'win-'+stem+'.out.log');
  // 同 stem 重放前清掉上一轮产物：stale result 会被 waitOpenClawResult 当成完成、
  // stale pid 会干扰存活判定（对照 pi/codex/claude 启动器的清理纪律）。
  for(const stale of [rf,rf+'.self-closed',pidf]){try{fs.rmSync(stale,{force:true});}catch{/* best effort */}}
  fs.writeFileSync(pf,prompt,'utf8');
  const timeoutSec=Math.ceil((Number(process.env.ORCH_MAX_POLL_MS)||900000)/1000)+60;
  const args=[...openclawArgs(config,{model:process.env.ORCH_MODEL}),'--message-file',pf,'--timeout',String(timeoutSec)];
  const body=[
    "$ErrorActionPreference = 'Stop'",
    `$PID | Set-Content -LiteralPath ${quote(pidf)} -Encoding UTF8`,
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    'chcp 65001 | Out-Null',
    `Set-Location -LiteralPath ${quote(workspace)}`,
    `$env:ORCH_WINDOW = '1'`,
    `$env:ORCH_WINDOW_TOKEN = ${quote(sanctionToken)}`,
    `$env:OPENCLAW_STATE_DIR = ${quote(state)}`,
    `$env:OPENCLAW_CONFIG_PATH = ${quote(realConfigPath())}`,
    `$token = ${quote(token)}`,
    `$log = ${quote(log)}`,
    '$code = 1',
    'try {',
    '$agentArgs = @('+args.map(quote).join(',')+')',
    ...nativeArgumentLines(),
    `& ${quote(config.bin)} @agentArgs 2>&1 | Tee-Object -FilePath $log`,
    '$code = $LASTEXITCODE',
    '} catch { $code = 1 }',
    "$report = ''",
    'if (Test-Path -LiteralPath $log) {',
    '  $lines = Get-Content -LiteralPath $log -Encoding UTF8 -ErrorAction SilentlyContinue',
    '  $hit = $lines | Where-Object { $_.Contains($token) } | Select-Object -Last 1',
    '  if ($hit) { $report = $hit } else { $report = ($lines | Select-Object -Last 3) -join "`n" }',
    '}',
    `@{__EXIT__=$code;__DONE__=$true;token=$token;__REPORT__=$report} | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(rf)} -Encoding UTF8`,
    'exit 0',
  ].join('\r\n');
  fs.writeFileSync(lp,'\uFEFF'+body,'utf8');
  return {lp,pidf,pf,rf,log,openclawState:state,sanctionToken};
}

export async function waitOpenClawResult(rf,timeoutMs,pidf,expectedToken) {
  const end=Date.now()+timeoutMs;
  while(Date.now()<end) {
    if(fs.existsSync(rf)) {
      try {
        const r=JSON.parse(fs.readFileSync(rf,'utf8').replace(/^\uFEFF/,''));
        // 第二道关联检查（审计 ID37）：启动前清理是第一条防线；携带 token 且与本单元
        // 不符的 result 一律拒绝（fail-closed），不采信它的 __EXIT__。
        if(expectedToken&&r&&typeof r==='object'&&r.token&&r.token!==expectedToken)
          return {done:true,exitCode:1,text:'OpenClaw foreign result rejected (token mismatch): '+path.basename(rf)};
        return {done:true,exitCode:r.__EXIT__,text:r.__REPORT__||''};
      } catch {}
    }
    if(fs.existsSync(pidf)) {
      let pid=0;
      try{pid=Number(String(fs.readFileSync(pidf,'utf8')).replace(/^\uFEFF/,'').trim());}catch{pid=0;}
      if(Number.isInteger(pid)&&pid>0){
        try{process.kill(pid,0);}catch(e){if(e&&e.code==='ESRCH')return {done:true,exitCode:1,text:'OpenClaw launcher exited without result'};}
      }
    }
    await new Promise(r=>setTimeout(r,300));
  }
  return {done:false,exitCode:null,text:'OpenClaw completion timeout'};
}
