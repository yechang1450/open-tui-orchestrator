import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {kimiAssistantText,writeKimiLauncher,waitKimiResult} from '../scripts/core/kimi-runtime.mjs';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');fs.mkdirSync(family,{recursive:true});
test('kimi planner consumes assistant stream-json content only and rejects failed responses',()=>{
 const ok=['{"role":"meta","type":"system.version","version":"0.41.0"}','{"role":"assistant","content":"first"}','{"role":"assistant","content":"final answer"}','{"role":"meta","type":"session.resume_hint","session_id":"s"}'].join('\n');
 assert.equal(kimiAssistantText(ok),'final answer');
 assert.throws(()=>kimiAssistantText('{"type":"session.error","message":"boom"}'),/KIMI_RESPONSE_FAILED/);
 assert.equal(kimiAssistantText('not json\n{"role":"user","content":"ignored"}'),'');
});
test('kimi PowerShell launcher preserves prompt argv, captures the token line and writes the result',()=>{
 const dir=fs.mkdtempSync(path.join(family,'kimi-launch-'));
 try{
  const worker=path.join(dir,'fake kimi.mjs'),capture=path.join(dir,'argv.json');
  fs.writeFileSync(worker,'import fs from "node:fs";\nconst p=process.argv.at(-1);\nconst m=/^capture:(.+)$/m.exec(p);\nfs.writeFileSync(m[1].trim(),JSON.stringify(process.argv.slice(2)));\nconsole.log("done 【本块唯一标识】 kimitest1");\n');
  const prompt='执行窗口任务 "带引号" 与中文\n第二行 D:\\path\\\n【本块唯一标识】kimitest1\ncapture:'+capture;
  const la=writeKimiLauncher({bin:process.execPath,prefixArgs:[worker]},{key:'B1',suffix:'test',prompt,workspace:dir,temp:path.join(dir,'temp')});
  const result=spawnSync('powershell.exe',['-NoProfile','-File',la.lp],{windowsHide:true,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);
  const r=JSON.parse(fs.readFileSync(la.rf,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/)[0]);
  assert.equal(r.__EXIT__,0);assert.ok(r.__REPORT__.includes('kimitest1'));
  assert.deepEqual(JSON.parse(fs.readFileSync(capture,'utf8')),['-p',prompt.trim()]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('kimi result wait returns the launcher-written outcome immediately',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'kimi-wait-'));
 try{
  const rf=path.join(dir,'r.json');fs.writeFileSync(rf,JSON.stringify({__EXIT__:0,__DONE__:true,__REPORT__:'ok'}));
  const res=await waitKimiResult(rf,5000,path.join(dir,'missing.pid'));
  assert.equal(res.done,true);assert.equal(res.exitCode,0);assert.equal(res.text,'ok');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
