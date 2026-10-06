import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {powershellExe} from '../scripts/core/contracts.mjs';
import {piAssistantText,writePiLauncher,runPiPlanner,waitPiResult} from '../scripts/core/pi-runtime.mjs';
import completion from '../scripts/core/pi-shutdown.mjs';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');fs.mkdirSync(family,{recursive:true});
test('pi planner consumes assistant output only and rejects failed responses',()=>{
 assert.equal(piAssistantText(JSON.stringify({message:{role:'user',content:[{type:'text',text:'wrong'}]}})+'\n'+JSON.stringify({message:{role:'assistant',content:[{type:'text',text:'answer'}]}})),'answer');
 assert.throws(()=>piAssistantText(JSON.stringify({message:{role:'assistant',stopReason:'error'}})),/PI_RESPONSE_FAILED/);
});
test('pi shutdown waits for settled idle state and never accepts a user completion marker',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'pi-events-')),file=path.join(dir,'result.json');
 const prev={file:process.env.ORCH_PI_RESULT,token:process.env.ORCH_PI_TOKEN};let callback,shutdowns=0,idle=false;
 const branch=[{type:'message',message:{role:'user',content:[{type:'text',text:'__ORCH_DONE__ token'}]}}];
 try{
  process.env.ORCH_PI_RESULT=file;process.env.ORCH_PI_TOKEN='token';
  completion({on:(event,fn)=>{assert.equal(event,'agent_settled');callback=fn;}});
  const ctx={isIdle:()=>idle,sessionManager:{getBranch:()=>branch},shutdown:()=>shutdowns++};
  await callback({},ctx);assert.ok(!fs.existsSync(file));idle=true;
  await callback({},ctx);assert.equal(JSON.parse(fs.readFileSync(file)).__EXIT__,1);
  branch.push({type:'message',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'__ORCH_DONE__ token'}]}});
  await callback({},ctx);assert.equal(JSON.parse(fs.readFileSync(file)).__EXIT__,0);assert.equal(shutdowns,2);
 }finally{if(prev.file===undefined)delete process.env.ORCH_PI_RESULT;else process.env.ORCH_PI_RESULT=prev.file;if(prev.token===undefined)delete process.env.ORCH_PI_TOKEN;else process.env.ORCH_PI_TOKEN=prev.token;fs.rmSync(dir,{recursive:true,force:true});}
});
test('pi shutdown writes a failed result when settled-state inspection throws',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'pi-shutdown-error-')),file=path.join(dir,'result.json');
 const prev={file:process.env.ORCH_PI_RESULT,token:process.env.ORCH_PI_TOKEN};let callback,shutdowns=0;
 try{
  process.env.ORCH_PI_RESULT=file;process.env.ORCH_PI_TOKEN='token';
  completion({on:(event,fn)=>{assert.equal(event,'agent_settled');callback=fn;}});
  const ctx={isIdle:()=>true,sessionManager:{getBranch:()=>{throw new Error('session unavailable');}},shutdown:()=>shutdowns++};
  await callback({},ctx);
  const result=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(result.__DONE__,true);assert.equal(result.__EXIT__,1);assert.match(result.__REPORT__,/session unavailable/);assert.equal(shutdowns,1);
  assert.equal(fs.existsSync(file+'.'+process.pid+'.tmp'),false);
 }finally{if(prev.file===undefined)delete process.env.ORCH_PI_RESULT;else process.env.ORCH_PI_RESULT=prev.file;if(prev.token===undefined)delete process.env.ORCH_PI_TOKEN;else process.env.ORCH_PI_TOKEN=prev.token;fs.rmSync(dir,{recursive:true,force:true});}
});
test('pi shutdown accepts the completion marker only on the final assistant line',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'pi-marker-tail-')),file=path.join(dir,'result.json');
 const prev={file:process.env.ORCH_PI_RESULT,token:process.env.ORCH_PI_TOKEN};let callback;
 try{
  process.env.ORCH_PI_RESULT=file;process.env.ORCH_PI_TOKEN='token';
  completion({on:(event,fn)=>{assert.equal(event,'agent_settled');callback=fn;}});
  const ctx={isIdle:()=>true,sessionManager:{getBranch:()=>[{type:'message',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'prefix\n__ORCH_DONE__ token\nsuffix'}]}}]},shutdown:()=>{}};
  await callback({},ctx);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).__EXIT__,1);
 }finally{if(prev.file===undefined)delete process.env.ORCH_PI_RESULT;else process.env.ORCH_PI_RESULT=prev.file;if(prev.token===undefined)delete process.env.ORCH_PI_TOKEN;else process.env.ORCH_PI_TOKEN=prev.token;fs.rmSync(dir,{recursive:true,force:true});}
});
test('pi shutdown accepts the completion marker followed only by trailing whitespace',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'pi-marker-trailing-whitespace-')),file=path.join(dir,'result.json');
 const prev={file:process.env.ORCH_PI_RESULT,token:process.env.ORCH_PI_TOKEN};let callback;
 try{
  process.env.ORCH_PI_RESULT=file;process.env.ORCH_PI_TOKEN='token';
  completion({on:(event,fn)=>{assert.equal(event,'agent_settled');callback=fn;}});
  const ctx={isIdle:()=>true,sessionManager:{getBranch:()=>[{type:'message',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'__ORCH_DONE__ token\n\n'}]}}]},shutdown:()=>{}};
  await callback({},ctx);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).__EXIT__,0);
 }finally{if(prev.file===undefined)delete process.env.ORCH_PI_RESULT;else process.env.ORCH_PI_RESULT=prev.file;if(prev.token===undefined)delete process.env.ORCH_PI_TOKEN;else process.env.ORCH_PI_TOKEN=prev.token;fs.rmSync(dir,{recursive:true,force:true});}
});
test('pi shutdown converts idle-state inspection failures into a failed result and still closes',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'pi-idle-error-')),file=path.join(dir,'result.json');
 const prev={file:process.env.ORCH_PI_RESULT,token:process.env.ORCH_PI_TOKEN};let callback,shutdowns=0;
 try{
  process.env.ORCH_PI_RESULT=file;process.env.ORCH_PI_TOKEN='token';
  completion({on:(event,fn)=>{assert.equal(event,'agent_settled');callback=fn;}});
  const ctx={isIdle:()=>{throw new Error('idle unavailable');},sessionManager:{getBranch:()=>[]},shutdown:()=>shutdowns++};
  await callback({},ctx);
  const result=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(result.__DONE__,true);assert.equal(result.__EXIT__,1);assert.match(result.__REPORT__,/idle unavailable/);assert.equal(shutdowns,1);
 }finally{if(prev.file===undefined)delete process.env.ORCH_PI_RESULT;else process.env.ORCH_PI_RESULT=prev.file;if(prev.token===undefined)delete process.env.ORCH_PI_TOKEN;else process.env.ORCH_PI_TOKEN=prev.token;fs.rmSync(dir,{recursive:true,force:true});}
});
test('pi PowerShell launcher preserves native argv and initiating directory',()=>{
 const dir=fs.mkdtempSync(path.join(family,'pi-launch-')),worker=path.join(dir,'fake cli.mjs');
 try{
  fs.writeFileSync(worker,'import fs from "node:fs";fs.writeFileSync(process.env.ORCH_PI_RESULT,JSON.stringify({__EXIT__:0,cwd:process.cwd(),args:process.argv.slice(2)}));');
  const la=writePiLauncher({bin:process.execPath,prefixArgs:[worker]},{key:'B1',suffix:'test',prompt:'执行测试\n【本块唯一标识】token',workspace:dir,temp:path.join(dir,'temp')});
  const result=spawnSync(powershellExe(),['-NoProfile','-File',la.lp],{windowsHide:true,encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);const r=JSON.parse(fs.readFileSync(la.rf));assert.equal(r.cwd,dir);assert.ok(r.args.includes('--approve'));assert.equal(r.args.at(-1),'@'+la.pf);assert.ok(r.args.includes(la.piSession));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('pi planner treats a malformed ORCH_DECOMPOSE_TIMEOUT_MS as the default, not as a 1ms kill',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'pi-planner-env-'));
 const prev=process.env.ORCH_DECOMPOSE_TIMEOUT_MS;process.env.ORCH_DECOMPOSE_TIMEOUT_MS='not-a-number';
 try{
  const worker=path.join(dir,'planner.mjs');
  fs.writeFileSync(worker,"process.stdout.write(JSON.stringify({role:'assistant',content:[{type:'text',text:'plan-ok'}]})+'\\n');\n");
  const r=await runPiPlanner({bin:process.execPath,prefixArgs:[worker]},'规划',dir);
  assert.equal(r.final,'plan-ok','a malformed timeout must fall back to the default instead of killing the planner instantly');
 }finally{if(prev===undefined)delete process.env.ORCH_DECOMPOSE_TIMEOUT_MS;else process.env.ORCH_DECOMPOSE_TIMEOUT_MS=prev;fs.rmSync(dir,{recursive:true,force:true});}
});
test('pi launcher clears stale result and session files before a replay of the same stem',()=>{
 const dir=fs.mkdtempSync(path.join(family,'pi-launch-stale-'));
 try{
  const cfg={bin:process.execPath,prefixArgs:[]};
  const opts={key:'B1',suffix:'rep',prompt:'任务\n【本块唯一标识】piStale1',workspace:dir,temp:path.join(dir,'temp')};
  const first=writePiLauncher(cfg,opts);
  fs.writeFileSync(first.rf,'{"stale":true}');
  fs.writeFileSync(first.piSession,'{"old":"session"}\n');
  const second=writePiLauncher(cfg,opts);
  assert.equal(second.rf,first.rf);
  assert.equal(fs.existsSync(first.rf),false,'stale result must be cleared before a replay');
  assert.equal(fs.existsSync(first.piSession),false,'stale session must be cleared before a replay');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('pi result wait survives a malformed or unreadable pid file without a false exit report',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'pi-wait-pid-'));
 try{
  const rf=path.join(dir,'missing.result.json');
  const badPid=path.join(dir,'bad.pid');fs.writeFileSync(badPid,'not-a-pid','utf8');
  const r1=await waitPiResult(rf,700,badPid);
  assert.equal(r1.done,false,'malformed pid must not be read as an exited launcher: '+JSON.stringify(r1));
  const dirPid=path.join(dir,'pid-as-dir');fs.mkdirSync(dirPid);
  const r2=await waitPiResult(rf,700,dirPid);
  assert.equal(r2.done,false,'unreadable pid file must not reject the wait: '+JSON.stringify(r2));
  const deadPid=path.join(dir,'dead.pid');fs.writeFileSync(deadPid,'99999999','utf8');
  const r3=await waitPiResult(rf,3000,deadPid);
  assert.equal(r3.done,true);assert.equal(r3.exitCode,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
