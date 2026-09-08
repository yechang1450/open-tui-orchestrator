import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {nativeArgumentLines} from './native-argv.mjs';
const quote=x=>"'"+String(x).replaceAll("'","''")+"'";
export function writeOpenClawLauncher(config,{key,prompt,suffix,workspace,temp}) {
 const stem=String(key+'-'+suffix).replace(/[^a-zA-Z0-9_-]/g,'-');
 const token=/【本块唯一标识】\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(prompt)?.[1];
 if(!token)throw new Error('OpenClaw window requires a completion token');
 const state=path.join(temp,'orchestrator','openclaw',stem);fs.mkdirSync(state,{recursive:true});
 const lp=path.join(temp,'win-launch-'+stem+'.ps1'),pidf=path.join(temp,'window-'+stem+'.pid'),pf=path.join(temp,'agent-win-'+stem+'.md'),rf=path.join(temp,'win-'+stem+'.result.json'),specFile=path.join(state,'launch.json');
 fs.writeFileSync(pf,prompt,'utf8');
 fs.writeFileSync(specFile,JSON.stringify({...config,state,workspace,prompt:pf,result:rf,token,timeoutMs:Number(process.env.ORCH_MAX_POLL_MS||900000)}),'utf8');
 const args=[fileURLToPath(new URL('./openclaw-window.mjs',import.meta.url)),specFile];
 fs.writeFileSync(lp,'\ufeff'+["$ErrorActionPreference = 'Stop'",`$PID | Set-Content -LiteralPath ${quote(pidf)} -Encoding UTF8`,
 '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8','$OutputEncoding = [System.Text.Encoding]::UTF8','chcp 65001 | Out-Null',`Set-Location -LiteralPath ${quote(workspace)}`,"$env:ORCH_WINDOW = '1'",
 '$agentArgs = @('+args.map(quote).join(',')+')',...nativeArgumentLines(),`& ${quote(config.bin)} @agentArgs`,
 `if (-not (Test-Path -LiteralPath ${quote(rf)})) { @{__EXIT__=1;__DONE__=$true;token=${quote(token)}} | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(rf)} -Encoding UTF8 }`,'exit 0'].join('\r\n'),'utf8');
 return {lp,pidf,pf,rf,openclawState:state};
}
export async function runOpenClawPlanner(config,prompt,cwd) {
 const root=path.join(cwd,'temp','orchestrator','openclaw');fs.mkdirSync(root,{recursive:true});
 const state=fs.mkdtempSync(path.join(root,'planner-')),specFile=path.join(state,'launch.json');
 fs.writeFileSync(specFile,JSON.stringify({...config,state,workspace:cwd,planner:true}),'utf8');
 try{return await new Promise((resolve,reject)=>{
  const child=spawn(config.bin,['--import',new URL('./openclaw-bootstrap.mjs',import.meta.url).href,config.entry,'agent','exec','--cwd',cwd,'--state-dir',state,'--timeout','60','--json',prompt],{cwd,windowsHide:true,env:{...process.env,ORCH_OPENCLAW_SPEC:specFile,NODE_DISABLE_COMPILE_CACHE:'1'},stdio:['ignore','pipe','pipe']});
  let raw='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill();},75000);
  child.stdout.on('data',b=>{raw+=b;if(raw.length>8000000)child.kill();});child.stderr.resume();
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);try{if(code!==0||timedOut)throw new Error('OPENCLAW_PLANNER_FAILED');const value=JSON.parse(raw);const final=value.outputText||value.text||value.result?.finalAssistantVisibleText||value.result?.payloads?.map(p=>p.text||'').join('')||value.payloads?.map(p=>p.text||'').join('');if(!final)throw new Error('OPENCLAW_PLANNER_EMPTY_RESPONSE');resolve({final});}catch(e){reject(e);}});
 });}finally{fs.rmSync(state,{recursive:true,force:true});}
}
