import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {nativeArgumentLines} from './native-argv.mjs';
const quote=x=>"'"+String(x).replaceAll("'","''")+"'";
export function writeOpenClawLauncher(config,{key,prompt,suffix,workspace,temp}) {
 const stem=String(key+'-'+suffix).replace(/[^a-zA-Z0-9_-]/g,'-');
 const token=/【本块唯一标识】\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(prompt)?.[1];
 if(!token)throw new Error('OpenClaw window requires a completion token');
 const sanctionToken=crypto.randomBytes(18).toString('hex');
 const state=path.join(temp,'orchestrator','openclaw',stem);fs.mkdirSync(state,{recursive:true});
 const lp=path.join(temp,'win-launch-'+stem+'.ps1'),pidf=path.join(temp,'window-'+stem+'.pid'),pf=path.join(temp,'agent-win-'+stem+'.md'),rf=path.join(temp,'win-'+stem+'.result.json'),specFile=path.join(state,'launch.json');
 // 同 stem 重放前清掉上一轮产物：stale result 会被 waitOpenClawResult 当成完成、stale pid 会干扰存活判定。
 for(const stale of [rf,pidf]){try{fs.rmSync(stale,{force:true});}catch{/* best effort */}}
 fs.writeFileSync(pf,prompt,'utf8');
 fs.writeFileSync(specFile,JSON.stringify({...config,state,workspace,prompt:pf,result:rf,token,timeoutMs:Number(process.env.ORCH_MAX_POLL_MS||900000)}),'utf8');
 const args=[fileURLToPath(new URL('./openclaw-window.mjs',import.meta.url)),specFile];
 fs.writeFileSync(lp,'\ufeff'+["$ErrorActionPreference = 'Stop'",`$PID | Set-Content -LiteralPath ${quote(pidf)} -Encoding UTF8`,
 '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8','$OutputEncoding = [System.Text.Encoding]::UTF8','chcp 65001 | Out-Null',`Set-Location -LiteralPath ${quote(workspace)}`,"$env:ORCH_WINDOW = '1'",`$env:ORCH_WINDOW_TOKEN = ${quote(sanctionToken)}`,`$env:ORCH_OPENCLAW_PACKAGE_ROOT = ${quote(config.packageRoot)}`,
 '$agentArgs = @('+args.map(quote).join(',')+')',...nativeArgumentLines(),`& ${quote(config.bin)} @agentArgs`,
 `if (-not (Test-Path -LiteralPath ${quote(rf)})) { @{__EXIT__=1;__DONE__=$true;token=${quote(token)}} | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(rf)} -Encoding UTF8 }`,'exit 0'].join('\r\n'),'utf8');
 return {lp,pidf,pf,rf,openclawState:state,sanctionToken};
}
export async function runOpenClawPlanner(config,prompt,cwd) {
 const root=path.join(cwd,'temp','orchestrator','openclaw');fs.mkdirSync(root,{recursive:true});
 const state=fs.mkdtempSync(path.join(root,'planner-')),specFile=path.join(state,'launch.json');
 fs.writeFileSync(specFile,JSON.stringify({...config,state,workspace:cwd,planner:true}),'utf8');
 try{return await new Promise((resolve,reject)=>{
  const child=spawn(config.bin,['--import',new URL('./openclaw-bootstrap.mjs',import.meta.url).href,config.entry,'agent','exec','--cwd',cwd,'--state-dir',state,'--timeout','60','--json',prompt],{cwd,windowsHide:true,env:{...process.env,ORCH_OPENCLAW_SPEC:specFile,ORCH_OPENCLAW_PACKAGE_ROOT:config.packageRoot,NODE_DISABLE_COMPILE_CACHE:'1'},stdio:['ignore','pipe','pipe']});
  let raw='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill();},75000);
  child.stdout.on('data',b=>{raw+=b;if(raw.length>8000000)child.kill();});child.stderr.resume();
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);try{if(code!==0||timedOut)throw new Error('OPENCLAW_PLANNER_FAILED');const value=JSON.parse(raw);const final=value.outputText||value.text||value.result?.finalAssistantVisibleText||value.result?.payloads?.map(p=>p.text||'').join('')||value.payloads?.map(p=>p.text||'').join('');if(!final)throw new Error('OPENCLAW_PLANNER_EMPTY_RESPONSE');resolve({final});}catch(e){reject(e);}});
 });}finally{fs.rmSync(state,{recursive:true,force:true});}
}

export async function waitOpenClawResult(rf,timeoutMs,pidf,expectedToken) {
 const end=Date.now()+timeoutMs;
 while(Date.now()<end) {
  if(fs.existsSync(rf)) {
   try {
    const result=JSON.parse(fs.readFileSync(rf,'utf8').replace(/^\uFEFF/,''));
    if(result&&result.__DONE__===true&&Number.isInteger(result.__EXIT__)) {
     // 调用方给了期望 token 时，result.token 必须匹配（防 stale/别的 stem 的结果被当成完成）；
     // 不匹配就不接受、继续等待。未给 token 时保持旧契约。
     if(!expectedToken||result.token===expectedToken){
      const text=result.__REPORT__||'';
      const terminal=result.__EXIT__!==0&&/^OPENCLAW_CONFIG_INVALID: preflight failed before interactive startup/.test(String(text));
      return terminal?{done:true,exitCode:result.__EXIT__,text,terminal:true}:{done:true,exitCode:result.__EXIT__,text};
     }
    }
   }catch{}
  }
  if(fs.existsSync(pidf)) {
   // 读取可能撞上删除/占用，解析可能得到非数字——不能抛出，也不能把非法值喂给 process.kill；
   // 只有合法 PID + ESRCH 才算“启动器已退出”，其余（含非法值）继续等待。
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
