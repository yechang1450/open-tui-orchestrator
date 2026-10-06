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
 const env={...process.env,ORCH_AGENT:'openclaw',ORCH_SPAWN_MODE:'window',ORCH_MAX_POLL_MS:'180000'};
 const result=spawnSync(process.execPath,[path.join(repo,'cli.mjs'),'--agent','openclaw','--run-id',runId,'--acceptance-file',acceptance,'--run-windows',request],{cwd:workspace,env,stdio:'inherit',windowsHide:true});
 // spawn 失败（ENOENT/EACCES）或被信号终止时 status=null——必须显式检查，否则与真实断言失败
 // 坍缩成同一个 exit 1，且对从未启动的 run 空跑 10s poll。独立退出码 2 区分 spawn 故障。
 if(result.error||result.signal||result.status===null){
  console.log(JSON.stringify({runId,root,engineExit:result.status,engineError:result.error?result.error.message:null,engineSignal:result.signal||null,pollSkipped:true}));
  process.exitCode=2;
 }else{
  const poll=spawnSync(process.execPath,[path.join(repo,'scripts','poll-windows.mjs'),'--run-id',runId,'--require-all-success','--timeoutMs','10000'],{cwd:workspace,env,stdio:'inherit',windowsHide:true});
  if(poll.error||poll.signal||poll.status===null){
   console.log(JSON.stringify({runId,root,engineExit:result.status,pollExit:poll.status,pollError:poll.error?poll.error.message:null,pollSignal:poll.signal||null}));
   process.exitCode=2;
  }else{
   console.log(JSON.stringify({runId,root,engineExit:result.status,pollExit:poll.status}));
   process.exitCode=result.status===0&&poll.status===0?0:1;
  }
 }
}
