import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {opencodeAssistantText,writeOpenCodeLauncher,waitOpenCodeResult} from '../scripts/core/opencode-runtime.mjs';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');fs.mkdirSync(family,{recursive:true});
test('opencode planner consumes assistant text events only and rejects failed responses',()=>{
 const ok=['{"type":"step_start"}','{"type":"text","part":{"type":"text","text":"first"}}','{"type":"text","part":{"type":"text","text":"final answer"}}'].join('\n');
 assert.equal(opencodeAssistantText(ok),'final answer');
 assert.throws(()=>opencodeAssistantText('{"type":"error","error":"boom"}'),/OPENCODE_RESPONSE_FAILED/);
 assert.equal(opencodeAssistantText('not json\n{"type":"tool_use","part":{"type":"tool","text":"ignored"}}'),'');
});
test('opencode PowerShell launcher preserves prompt argv, captures the token line and writes the result',()=>{
 const dir=fs.mkdtempSync(path.join(family,'opencode-launch-'));
 try{
  const worker=path.join(dir,'fake opencode.mjs'),capture=path.join(dir,'argv.json');
  fs.writeFileSync(worker,'import fs from "node:fs";\nconst p=process.argv.at(-1);\nconst m=/^capture:(.+)$/m.exec(p);\nfs.writeFileSync(m[1].trim(),JSON.stringify(process.argv.slice(2)));\nconsole.log("done 【本块唯一标识】 octest1");\n');
  const prompt='执行窗口任务 "带引号" 与中文\n第二行 D:\\path\\\n【本块唯一标识】octest1\ncapture:'+capture;
  const la=writeOpenCodeLauncher({bin:process.execPath,prefixArgs:[worker]},{key:'B1',suffix:'test',prompt,workspace:dir,temp:path.join(dir,'temp')});
  const result=spawnSync('powershell.exe',['-NoProfile','-File',la.lp],{windowsHide:true,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);
  const r=JSON.parse(fs.readFileSync(la.rf,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/)[0]);
  assert.equal(r.__EXIT__,0);assert.ok(r.__REPORT__.includes('octest1'));
  assert.deepEqual(JSON.parse(fs.readFileSync(capture,'utf8')),['run','-i','--auto','--dir',dir,prompt.trim()]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('opencode result wait reads the JSON record ahead of the __EXIT__ trailer line',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'opencode-wait-'));
 try{
  const rf=path.join(dir,'r.json');fs.writeFileSync(rf,JSON.stringify({__EXIT__:0,__DONE__:true,__REPORT__:'ok'})+'\r\n__EXIT__=0\r\n');
  const res=await waitOpenCodeResult(rf,5000,path.join(dir,'missing.pid'));
  assert.equal(res.done,true);assert.equal(res.exitCode,0);assert.equal(res.text,'ok');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('opencode planner passes the prompt after -- and consumes the final text event',async()=>{
 const {runOpenCodePlanner}=await import('../scripts/core/opencode-runtime.mjs');
 const dir=fs.mkdtempSync(path.join(family,'opencode-planner-argv-'));
 try{
  const worker=path.join(dir,'fake opencode planner.mjs'),capture=path.join(dir,'argv.json');
  fs.writeFileSync(worker,'import fs from "node:fs";\nfs.writeFileSync('+JSON.stringify(capture)+',JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({type:"text",part:{type:"text",text:"plan-ok"}}));\n');
  const r=await runOpenCodePlanner({bin:process.execPath,prefixArgs:[worker]},'规划 "带引号" 任务',dir);
  assert.equal(r.final,'plan-ok');
  const argv=JSON.parse(fs.readFileSync(capture,'utf8')),sep=argv.indexOf('--');
  assert.deepEqual(argv.slice(0,4),['run','--format','json','--dir']);
  assert.equal(argv[argv.length-2],'--');assert.equal(argv[argv.length-1],'规划 "带引号" 任务');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('opencode launcher with ORCH_MODEL emits --model before the prompt through real PowerShell argv',()=>{
 const pm=process.env.ORCH_MODEL;process.env.ORCH_MODEL='oc-k3';
 const dir=fs.mkdtempSync(path.join(family,'opencode-launch-model-'));
 try{
  const worker=path.join(dir,'fake opencode.mjs'),capture=path.join(dir,'argv.json');
  fs.writeFileSync(worker,'import fs from "node:fs";\nconst p=process.argv.at(-1);\nconst m=/^capture:(.+)$/m.exec(p);\nfs.writeFileSync(m[1].trim(),JSON.stringify(process.argv.slice(2)));\nconsole.log("done 【本块唯一标识】 octest2");\n');
  const prompt='带 model 的窗口任务\n【本块唯一标识】octest2\ncapture:'+capture;
  const la=writeOpenCodeLauncher({bin:process.execPath,prefixArgs:[worker]},{key:'B1',suffix:'test2',prompt,workspace:dir,temp:path.join(dir,'temp')});
  const result=spawnSync('powershell.exe',['-NoProfile','-File',la.lp],{windowsHide:true,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture,'utf8')),['run','-i','--auto','--dir',dir,'--model','oc-k3',prompt.trim()]);
 }finally{if(pm===undefined)delete process.env.ORCH_MODEL;else process.env.ORCH_MODEL=pm;fs.rmSync(dir,{recursive:true,force:true});}
});
test('opencode launcher unwraps native stderr (no NativeCommandError) but keeps it in the log',()=>{
 const dir=fs.mkdtempSync(path.join(family,'opencode-launch-stderr-'));
 try{
  const worker=path.join(dir,'fake opencode stderr.mjs');
  fs.writeFileSync(worker,'console.error("opencode 1.2.3 fake-diag");\nconsole.log("done 【本块唯一标识】 octest3");\n');
  const prompt='stderr 外观测试\n【本块唯一标识】octest3';
  const la=writeOpenCodeLauncher({bin:process.execPath,prefixArgs:[worker]},{key:'B1',suffix:'test3',prompt,workspace:dir,temp:path.join(dir,'temp')});
  const result=spawnSync('powershell.exe',['-NoProfile','-File',la.lp],{windowsHide:true,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);
  assert.doesNotMatch(result.stderr,/NativeCommandError/);
  const buf=fs.readFileSync(la.log);
  const log=buf.length>=2&&buf[0]===0xFF&&buf[1]===0xFE?buf.toString('utf16le'):buf.toString('utf8');
  assert.ok(log.includes('opencode 1.2.3 fake-diag'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('opencode result wait reports a dead launcher without result as exit 1',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'opencode-wait-dead-'));
 try{
  const pidf=path.join(dir,'w.pid');fs.writeFileSync(pidf,'999999','utf8'); // 必不存在的 PID
  const res=await waitOpenCodeResult(path.join(dir,'missing.result.json'),3000,pidf);
  assert.equal(res.done,true);assert.equal(res.exitCode,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
