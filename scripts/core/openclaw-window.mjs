import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {completionText} from './openclaw-config.mjs';
const specFile=process.argv[2],spec=JSON.parse(fs.readFileSync(specFile,'utf8'));
const pty=createRequire(import.meta.url)(spec.ptyEntry);
const env={...process.env,ORCH_OPENCLAW_SPEC:specFile,NODE_DISABLE_COMPILE_CACHE:'1',OPENCLAW_NO_RESPAWN:'1'};
delete env.NODE_COMPILE_CACHE;
const validation=spawnSync(spec.bin,['--import',new URL('./openclaw-bootstrap.mjs',import.meta.url).href,spec.entry,'config','validate','--json'],{env,cwd:spec.workspace,windowsHide:true,timeout:30000,encoding:'utf8'});
if(validation.status!==0){
 fs.writeFileSync(spec.result,JSON.stringify({__EXIT__:1,__DONE__:true,__REPORT__:'OPENCLAW_CONFIG_INVALID: preflight failed before interactive startup',token:spec.token}),'utf8');
 process.exit(1);
}
const child=pty.spawn(spec.bin,['--import',new URL('./openclaw-bootstrap.mjs',import.meta.url).href,spec.entry,'tui','--local','--session','main','--message',fs.readFileSync(spec.prompt,'utf8'),'--timeout-ms',String(spec.timeoutMs)],{cwd:spec.workspace,env,cols:process.stdout.columns||120,rows:process.stdout.rows||35,name:'xterm-256color'});
child.onData(data=>process.stdout.write(data));
let marker=null,seenAt=0,closingAt=0,failure='',finished=false;
const dbFile=path.join(spec.state,'agents','main','agent','openclaw-agent.sqlite');
const started=Date.now();
const timer=setInterval(()=>{
 if(Date.now()-started>spec.timeoutMs&&!closingAt){failure='OPENCLAW_WINDOW_TIMEOUT';closingAt=Date.now();child.write('/exit\r');}
 if(closingAt){if(Date.now()-closingAt>10000)child.kill();return;}
 if(!fs.existsSync(dbFile))return;
 let db;
 try{
  db=new DatabaseSync(dbFile,{readOnly:true});
  const rows=db.prepare('SELECT e.event_json FROM transcript_events e JOIN session_nodes s ON s.current_session_id=e.session_id WHERE s.session_key=? ORDER BY e.seq DESC LIMIT 8').all('agent:main:main');
  const text=completionText(rows.reverse().map(r=>JSON.parse(r.event_json)),spec.token);
  if(!text){seenAt=0;return;}
  if(!seenAt){seenAt=Date.now();return;}
  if(Date.now()-seenAt>=1000){marker=text;closingAt=Date.now();child.write('/exit\r');}
 }catch(error){if(!/locked|busy|no such table/i.test(error.message)){failure='OPENCLAW_TRANSCRIPT_UNSUPPORTED';closingAt=Date.now();child.write('/exit\r');}}
 finally{db?.close();}
},500);
child.onExit(({exitCode})=>{
 if(finished)return;finished=true;clearInterval(timer);
 const result={__EXIT__:marker&&!failure&&exitCode===0?0:1,__DONE__:true,__REPORT__:marker||failure||'OpenClaw exited without a verified completion marker',token:spec.token};
 fs.writeFileSync(path.join(spec.state,'completion.json'),JSON.stringify({...result,nativeExitCode:exitCode,automaticClose:Boolean(marker)&&!failure,finishedAt:Date.now()}),'utf8');
 fs.writeFileSync(spec.result+'.tmp',JSON.stringify(result),'utf8');fs.renameSync(spec.result+'.tmp',spec.result);
 process.exit(result.__EXIT__);
});
process.on('SIGINT',()=>{failure='OPENCLAW_INTERRUPTED';closingAt=Date.now();child.write('\x03');});
