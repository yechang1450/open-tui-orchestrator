import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
if(!process.argv.includes('--smoke')){
 process.env.ORCH_LIVE_AGENT='openclaw';await import('./live-codex.mjs');
}else{
 const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url))),workspace=process.cwd(),runId='openclaw-smoke-'+crypto.randomUUID();
 const root=path.join(workspace,'temp',runId);fs.mkdirSync(root,{recursive:true});
 const output=path.join(root,'result.json'),acceptance=path.join(root,'acceptance.json'),nonce=crypto.randomUUID();
 fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'json',path:output,equals:{cwd:workspace,nonce,ok:true}}]}),'utf8');
 const request=`Execute node "${path.join(repo,'test','workspace-probe.mjs')}" "${output}" "${workspace.replaceAll('\\','/')}" "${nonce}" and read back the output file. Follow the supplied checkpoint commands. Only run the supplied probe and checkpoint commands.`;
 const env={...process.env,ORCH_AGENT:'openclaw',ORCH_MAX_POLL_MS:'180000'};
 const result=spawnSync(process.execPath,[path.join(repo,'cli.mjs'),'--agent','openclaw','--run-id',runId,'--acceptance-file',acceptance,'--run-windows',request],{cwd:workspace,env,stdio:'inherit',windowsHide:true});
 const poll=spawnSync(process.execPath,[path.join(repo,'scripts','poll-windows.mjs'),'--run-id',runId,'--require-all-success','--timeoutMs','10000'],{cwd:workspace,env,stdio:'inherit',windowsHide:true});
 console.log(JSON.stringify({runId,root,engineExit:result.status,pollExit:poll.status}));
 process.exitCode=result.status===0&&poll.status===0?0:1;
}
