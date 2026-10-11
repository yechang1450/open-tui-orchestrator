import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {powershellExe} from '../scripts/core/contracts.mjs';
import {writeClaudeLauncher,waitClaudeResult,runClaudePlanner,CLAUDE_DECOMPOSE_TIMEOUT_DEFAULT_MS,claudePlannerTimeoutMs} from '../scripts/core/claude-runtime.mjs';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');fs.mkdirSync(family,{recursive:true});
test('claude planner keeps the prompt after -p and resolves stdout text',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'claude-planner-'));
 try{
  const worker=path.join(dir,'fake claude planner.mjs'),capture=path.join(dir,'argv.json');
  fs.writeFileSync(worker,'import fs from "node:fs";\nfs.writeFileSync('+JSON.stringify(capture)+',JSON.stringify(process.argv.slice(2)));\nconsole.log("plan-ok");\n');
  const r=await runClaudePlanner({bin:process.execPath,prefixArgs:[worker]},'规划 "带引号" 与中文',dir);
  assert.equal(r.final,'plan-ok');
  const argv=JSON.parse(fs.readFileSync(capture,'utf8')),p=argv.indexOf('-p');
  assert.equal(argv[p+1],'规划 "带引号" 与中文');
  assert.equal(argv[argv.length-1],'规划 "带引号" 与中文');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('claude PowerShell launcher preserves prompt argv, captures the token line and writes the result',()=>{
 const dir=fs.mkdtempSync(path.join(family,'claude-launch-'));
 try{
  const worker=path.join(dir,'fake claude.mjs'),capture=path.join(dir,'argv.json');
  fs.writeFileSync(worker,'import fs from "node:fs";\nconst p=process.argv.at(-1);\nconst m=/^capture:(.+)$/m.exec(p);\nfs.writeFileSync(m[1].trim(),JSON.stringify(process.argv.slice(2)));\nconsole.log("done 【本块唯一标识】 claudetest1");\n');
  const prompt='执行窗口任务 "带引号" 与中文\n第二行\n【本块唯一标识】claudetest1\ncapture:'+capture;
  const la=writeClaudeLauncher({bin:process.execPath,prefixArgs:[worker]},{key:'B1',suffix:'test',prompt,workspace:dir,temp:path.join(dir,'temp')});
  const result=spawnSync(powershellExe(),['-NoProfile','-File',la.lp],{windowsHide:true,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);
  const r=JSON.parse(fs.readFileSync(la.rf,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/)[0]);
  assert.equal(r.__EXIT__,0);assert.ok(r.__REPORT__.includes('claudetest1'));
  const argv=JSON.parse(fs.readFileSync(capture,'utf8'));
  assert.ok(argv.includes('--dangerously-skip-permissions'));
  assert.equal(argv[argv.indexOf('-p')+1],prompt.trim());
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('claude result wait returns the launcher-written outcome immediately',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'claude-wait-'));
 try{
  const rf=path.join(dir,'r.json');fs.writeFileSync(rf,JSON.stringify({__EXIT__:0,__DONE__:true,__REPORT__:'ok'}));
  const res=await waitClaudeResult(rf,5000,path.join(dir,'missing.pid'));
  assert.equal(res.done,true);assert.equal(res.exitCode,0);assert.equal(res.text,'ok');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('claude result wait does not treat a malformed pid file as a dead launcher',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'claude-bad-pid-'));
 try{
  const pidf=path.join(dir,'window.pid');fs.writeFileSync(pidf,'abc','utf8');
  const res=await waitClaudeResult(path.join(dir,'missing.json'),80,pidf);
  assert.deepEqual(res,{done:false,exitCode:null,text:'Claude completion timeout'});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('claude planner timeout defaults to 240s and honors ORCH_DECOMPOSE_TIMEOUT_MS',()=>{
 assert.equal(CLAUDE_DECOMPOSE_TIMEOUT_DEFAULT_MS,240000);
 const prev=process.env.ORCH_DECOMPOSE_TIMEOUT_MS;
 try{
  delete process.env.ORCH_DECOMPOSE_TIMEOUT_MS;
  assert.equal(claudePlannerTimeoutMs(),240000);
  process.env.ORCH_DECOMPOSE_TIMEOUT_MS='12345';assert.equal(claudePlannerTimeoutMs(),12345);
 }finally{if(prev===undefined)delete process.env.ORCH_DECOMPOSE_TIMEOUT_MS;else process.env.ORCH_DECOMPOSE_TIMEOUT_MS=prev;}
});
