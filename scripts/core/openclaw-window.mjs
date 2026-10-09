import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {completionText} from './openclaw-config.mjs';
const specFile=process.argv[2];
let spec=null;
// 设置阶段守卫：spec 读取/解析、pty 载体解析、pty.spawn 任一失败都必须收敛成一行失败 result，
// 绝不让裸 Node 栈甩给启动器；等待方由启动器 ps1 的兜底 result 保证不悬挂。
const failSetup=(reason)=>{
 try{if(spec&&spec.result)fs.writeFileSync(spec.result,JSON.stringify({__EXIT__:1,__DONE__:true,__REPORT__:reason,token:spec&&spec.token}),'utf8');}catch{/* launcher ps1 fallback owns the result when we cannot write */}
 console.error('[openclaw-window] '+reason);
 process.exit(1);
};
try{spec=JSON.parse(fs.readFileSync(specFile,'utf8'));}catch(error){failSetup('OPENCLAW_SPEC_UNREADABLE: '+((error&&error.message)||error));}
// 同 stem 重放：旧 result 会被等待方当成完成——启动前必须清除。
try{fs.rmSync(spec.result,{force:true});}catch{/* best effort */}
let pty;
try{pty=createRequire(import.meta.url)(spec.ptyEntry);}catch(error){failSetup('OPENCLAW_PTY_UNAVAILABLE: '+((error&&error.message)||error));}
const env={...process.env,ORCH_OPENCLAW_SPEC:specFile,NODE_DISABLE_COMPILE_CACHE:'1',OPENCLAW_NO_RESPAWN:'1'};
delete env.NODE_COMPILE_CACHE;
const validation=spawnSync(spec.bin,['--import',new URL('./openclaw-bootstrap.mjs',import.meta.url).href,spec.entry,'config','validate','--json'],{env,cwd:spec.workspace,windowsHide:true,timeout:30000,encoding:'utf8'});
if(validation.status!==0){
 fs.writeFileSync(spec.result,JSON.stringify({__EXIT__:1,__DONE__:true,__REPORT__:'OPENCLAW_CONFIG_INVALID: preflight failed before interactive startup',token:spec.token}),'utf8');
 process.exit(1);
}
let child;
try{child=pty.spawn(spec.bin,['--import',new URL('./openclaw-bootstrap.mjs',import.meta.url).href,spec.entry,'tui','--local','--session','main','--message',fs.readFileSync(spec.prompt,'utf8'),'--timeout-ms',String(spec.timeoutMs)],{cwd:spec.workspace,env,cols:process.stdout.columns||120,rows:process.stdout.rows||35,name:'xterm-256color'});}catch(error){failSetup('OPENCLAW_PTY_SPAWN_FAILED: '+((error&&error.message)||error));}
child.onData(data=>process.stdout.write(data));
let marker=null,seenAt=0,closingAt=0,failure='',finished=false;
const dbFile=path.join(spec.state,'agents','main','agent','openclaw-agent.sqlite');
const started=Date.now();
// 抽取为可复用函数：轮询与退出前最终检查共用同一判定（completionText 取含 token 的最后助手消息）。
const readCompletion=()=>{
 if(!fs.existsSync(dbFile))return '';
 let db;
 try{
  db=new DatabaseSync(dbFile,{readOnly:true});
  const rows=db.prepare('SELECT e.event_json FROM transcript_events e JOIN session_nodes s ON s.current_session_id=e.session_id WHERE s.session_key=? ORDER BY e.seq DESC LIMIT 8').all('agent:main:main');
  return completionText(rows.reverse().map(r=>JSON.parse(r.event_json)),spec.token);
 }catch(error){
  if(!/locked|busy|no such table/i.test(error.message))failure='OPENCLAW_TRANSCRIPT_UNSUPPORTED: '+error.message;
  return '';
 }finally{db?.close();}
};
const timer=setInterval(()=>{
 if(Date.now()-started>spec.timeoutMs&&!closingAt){failure='OPENCLAW_WINDOW_TIMEOUT';closingAt=Date.now();child.write('/exit\r');}
 if(closingAt){if(Date.now()-closingAt>10000)child.kill();return;}
 const text=readCompletion();
 if(failure){closingAt=Date.now();child.write('/exit\r');return;}
 if(!text){seenAt=0;return;}
 if(!seenAt){seenAt=Date.now();return;}
 if(Date.now()-seenAt>=1000){marker=text;closingAt=Date.now();child.write('/exit\r');}
},500);
child.onExit(({exitCode})=>{
 if(finished)return;finished=true;clearInterval(timer);
 // 退出前最终检查：合法 marker 可能在最后 500ms 轮询窗口内写入、或 1s 稳定窗未走完就退出——
 // 进程已结束即最终态，直接采信一次 transcript 读取，避免把合法完成误报成“无 marker”。
 if(!marker&&!failure){const finalText=readCompletion();if(finalText)marker=finalText;}
 const result={__EXIT__:marker&&!failure&&exitCode===0?0:1,__DONE__:true,__REPORT__:marker||failure||'OpenClaw exited without a verified completion marker',token:spec.token};
 fs.writeFileSync(path.join(spec.state,'completion.json'),JSON.stringify({...result,nativeExitCode:exitCode,automaticClose:Boolean(marker)&&!failure,finishedAt:Date.now()}),'utf8');
 fs.writeFileSync(spec.result+'.tmp',JSON.stringify(result),'utf8');fs.renameSync(spec.result+'.tmp',spec.result);
 process.exit(result.__EXIT__);
});
process.on('SIGINT',()=>{failure='OPENCLAW_INTERRUPTED';closingAt=Date.now();child.write('\x03');});
