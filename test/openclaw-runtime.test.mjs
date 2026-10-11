import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeOpenClawLauncher,runOpenClawPlanner,waitOpenClawResult} from '../scripts/core/openclaw-runtime.mjs';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');fs.mkdirSync(family,{recursive:true});
function stubEntry(body){
  const dir=fs.mkdtempSync(path.join(family,'openclaw-stub-'));
  const entry=path.join(dir,'openclaw.mjs');fs.writeFileSync(entry,body,'utf8');
  return {dir,entry};
}
test('openclaw planner consumes the json envelope and rejects error envelopes',async()=>{
 const ok=stubEntry(`console.log(JSON.stringify({ok:true,result:{terminalReply:{disposition:'visible',text:'HELLO'}}}));`);
 const bad=stubEntry(`console.log(JSON.stringify({ok:false,error:{type:'cli_error',message:'no auth'}}));`);
 const weird=stubEntry(`console.log('not json at all');`);
 try{
  const r=await runOpenClawPlanner({bin:process.execPath,prefixArgs:[ok.entry]},'classify this',family);
  assert.equal(r.final,'HELLO');
  await assert.rejects(()=>runOpenClawPlanner({bin:process.execPath,prefixArgs:[bad.entry]},'x',family),/OPENCLAW_PLANNER_ERROR/);
  await assert.rejects(()=>runOpenClawPlanner({bin:process.execPath,prefixArgs:[weird.entry]},'x',family),/OPENCLAW_PLANNER_UNPARSEABLE/);
 }finally{for(const s of [ok,bad,weird])fs.rmSync(s.dir,{recursive:true,force:true});}
});
test('openclaw launcher clears stale artifacts and writes a token-carrying result contract',()=>{
 const temp=fs.mkdtempSync(path.join(family,'openclaw-launch-'));
 try{
  const prompt='任务。\n【本块唯一标识】 tok1';
  const launcher=writeOpenClawLauncher({bin:process.execPath,prefixArgs:['C:\\x\\openclaw.mjs']},{key:'B1',prompt,suffix:'a',workspace:temp,temp});
  assert.ok(fs.existsSync(launcher.lp));
  assert.ok(fs.existsSync(launcher.pf));
  assert.equal(fs.existsSync(launcher.rf),false,'a fresh launcher must not leave a stale result');
  const ps1=fs.readFileSync(launcher.lp,'utf8');
  assert.match(ps1,/agent/);assert.match(ps1,/--message-file/);assert.match(ps1,/OPENCLAW_STATE_DIR/);assert.match(ps1,/OPENCLAW_CONFIG_PATH/);assert.match(ps1,/tok1/);
  // 同 stem 重放：预置 stale result/pid，重写启动器后必须被清掉。
  fs.writeFileSync(launcher.rf,'{"__EXIT__":0,"__DONE__":true,"token":"tok1"}');fs.writeFileSync(launcher.pidf,'999999');
  writeOpenClawLauncher({bin:process.execPath,prefixArgs:['C:\\x\\openclaw.mjs']},{key:'B1',prompt,suffix:'a',workspace:temp,temp});
  assert.equal(fs.existsSync(launcher.rf),false);
  assert.equal(fs.existsSync(launcher.pidf),false);
  assert.throws(()=>writeOpenClawLauncher({bin:process.execPath,prefixArgs:[]},{key:'B1',prompt:'no token here',suffix:'a',workspace:temp,temp}),/completion token/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('openclaw wait accepts the matching token and rejects foreign results (ID37)',async()=>{
 const temp=fs.mkdtempSync(path.join(family,'openclaw-wait-'));
 try{
  const rf=path.join(temp,'win.result.json'),pidf=path.join(temp,'win.pid');
  fs.writeFileSync(rf,JSON.stringify({__EXIT__:0,__DONE__:true,token:'tok1',__REPORT__:'__ORCH_DONE__ tok1'}));
  const ok=await waitOpenClawResult(rf,1000,pidf,'tok1');
  assert.equal(ok.done,true);assert.equal(ok.exitCode,0);assert.equal(ok.text,'__ORCH_DONE__ tok1');
  const foreign=await waitOpenClawResult(rf,1000,pidf,'other');
  assert.equal(foreign.done,true);assert.equal(foreign.exitCode,1);assert.match(foreign.text,/foreign result rejected/);
  const legacy=await waitOpenClawResult(rf,1000,pidf);
  assert.equal(legacy.exitCode,0);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('openclaw wait reports launcher exit without result via ESRCH on a dead pid',async()=>{
 const temp=fs.mkdtempSync(path.join(family,'openclaw-wait-dead-'));
 try{
  const rf=path.join(temp,'win.result.json'),pidf=path.join(temp,'win.pid');
  fs.writeFileSync(pidf,'999999');
  const dead=await waitOpenClawResult(rf,2000,pidf,'tok1');
  assert.equal(dead.done,true);assert.equal(dead.exitCode,1);assert.match(dead.text,/launcher exited without result/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
