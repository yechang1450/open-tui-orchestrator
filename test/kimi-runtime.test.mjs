import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {powershellExe} from '../scripts/core/contracts.mjs';
import {kimiAssistantText,writeKimiLauncher,waitKimiResult,runKimiPlanner} from '../scripts/core/kimi-runtime.mjs';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');fs.mkdirSync(family,{recursive:true});
test('kimi planner binds the prompt immediately after -p (kimi CLI parses flag values greedily)',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'kimi-planner-argv-'));
 try{
  const worker=path.join(dir,'fake kimi planner.mjs'),capture=path.join(dir,'argv.json');
  fs.writeFileSync(worker,'import fs from "node:fs";\nfs.writeFileSync('+JSON.stringify(capture)+',JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({role:"assistant",content:"plan-ok"}));\n');
  const r=await runKimiPlanner({bin:process.execPath,prefixArgs:[worker]},'规划 "带引号" 与中文',dir);
  assert.equal(r.final,'plan-ok');
  const argv=JSON.parse(fs.readFileSync(capture,'utf8')),p=argv.indexOf('-p');
  assert.equal(argv[p+1],'规划 "带引号" 与中文');
  assert.deepEqual(argv.slice(p+2),['--output-format','stream-json']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
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
  const result=spawnSync(powershellExe(),['-NoProfile','-File',la.lp],{windowsHide:true,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);
  const r=JSON.parse(fs.readFileSync(la.rf,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/)[0]);
  assert.equal(r.__EXIT__,0);assert.ok(r.__REPORT__.includes('kimitest1'));
  assert.deepEqual(JSON.parse(fs.readFileSync(capture,'utf8')),['-p',prompt.trim()]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('kimi launcher with ORCH_MODEL emits -m before -p through real PowerShell argv',()=>{
 const pm=process.env.ORCH_MODEL;process.env.ORCH_MODEL='kimi-k3';
 const dir=fs.mkdtempSync(path.join(family,'kimi-launch-model-'));
 try{
  const worker=path.join(dir,'fake kimi.mjs'),capture=path.join(dir,'argv.json');
  fs.writeFileSync(worker,'import fs from "node:fs";\nconst p=process.argv.at(-1);\nconst m=/^capture:(.+)$/m.exec(p);\nfs.writeFileSync(m[1].trim(),JSON.stringify(process.argv.slice(2)));\nconsole.log("done 【本块唯一标识】 kimitest2");\n');
  const prompt='带 model 的窗口任务\n【本块唯一标识】kimitest2\ncapture:'+capture;
  const la=writeKimiLauncher({bin:process.execPath,prefixArgs:[worker]},{key:'B1',suffix:'test2',prompt,workspace:dir,temp:path.join(dir,'temp')});
  const result=spawnSync(powershellExe(),['-NoProfile','-File',la.lp],{windowsHide:true,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture,'utf8')),['-m','kimi-k3','-p',prompt.trim()]);
 }finally{if(pm===undefined)delete process.env.ORCH_MODEL;else process.env.ORCH_MODEL=pm;fs.rmSync(dir,{recursive:true,force:true});}
});
test('kimi result wait returns the launcher-written outcome immediately',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'kimi-wait-'));
 try{
  const rf=path.join(dir,'r.json');fs.writeFileSync(rf,JSON.stringify({__EXIT__:0,__DONE__:true,__REPORT__:'ok'}));
  const res=await waitKimiResult(rf,5000,path.join(dir,'missing.pid'));
  assert.equal(res.done,true);assert.equal(res.exitCode,0);assert.equal(res.text,'ok');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('kimi planner timeout defaults to 360s (cold start ~295s) and honors ORCH_DECOMPOSE_TIMEOUT_MS',async()=>{
 const {plannerTimeoutMs,KIMI_DECOMPOSE_TIMEOUT_DEFAULT_MS}=await import('../scripts/core/kimi-runtime.mjs');
 assert.equal(KIMI_DECOMPOSE_TIMEOUT_DEFAULT_MS,360000);
 const prev=process.env.ORCH_DECOMPOSE_TIMEOUT_MS;
 try{
  delete process.env.ORCH_DECOMPOSE_TIMEOUT_MS;
  assert.equal(plannerTimeoutMs(),360000);
  process.env.ORCH_DECOMPOSE_TIMEOUT_MS='12345';assert.equal(plannerTimeoutMs(),12345);
  process.env.ORCH_DECOMPOSE_TIMEOUT_MS='bogus';assert.equal(plannerTimeoutMs(),360000);
 }finally{if(prev===undefined)delete process.env.ORCH_DECOMPOSE_TIMEOUT_MS;else process.env.ORCH_DECOMPOSE_TIMEOUT_MS=prev;}
});
test('kimi planner kills a cold-hung planner after the configured timeout',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'kimi-planner-timeout-'));
 const prev=process.env.ORCH_DECOMPOSE_TIMEOUT_MS;process.env.ORCH_DECOMPOSE_TIMEOUT_MS='400';
 try{
  const worker=path.join(dir,'hung kimi.mjs');
  fs.writeFileSync(worker,'setTimeout(()=>{},30000);\n');
  await assert.rejects(runKimiPlanner({bin:process.execPath,prefixArgs:[worker]},'规划',dir),/KIMI_PLANNER_TIMEOUT/);
 }finally{if(prev===undefined)delete process.env.ORCH_DECOMPOSE_TIMEOUT_MS;else process.env.ORCH_DECOMPOSE_TIMEOUT_MS=prev;fs.rmSync(dir,{recursive:true,force:true});}
});
test('kimi launcher unwraps native stderr (no NativeCommandError red block) but keeps it in the log',()=>{
 const dir=fs.mkdtempSync(path.join(family,'kimi-launch-stderr-'));
 try{
  const worker=path.join(dir,'fake kimi stderr.mjs');
  fs.writeFileSync(worker,'console.error("kimi version 9.9.9 fake-diag");\nconsole.log("done 【本块唯一标识】 kimitest4");\n');
  const prompt='stderr 外观测试\n【本块唯一标识】kimitest4';
  const la=writeKimiLauncher({bin:process.execPath,prefixArgs:[worker]},{key:'B1',suffix:'test4',prompt,workspace:dir,temp:path.join(dir,'temp')});
  const result=spawnSync(powershellExe(),['-NoProfile','-File',la.lp],{windowsHide:true,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);
  assert.doesNotMatch(result.stderr,/NativeCommandError/,'native stderr must not surface as PowerShell error records');
  const buf=fs.readFileSync(la.log);
  const log=buf.length>=2&&buf[0]===0xFF&&buf[1]===0xFE?buf.toString('utf16le'):buf.toString('utf8'); // Tee-Object 默认 UTF-16LE（带 BOM）
  assert.ok(log.includes('kimi version 9.9.9 fake-diag'),'stderr diagnostics stay in the tee log');
  const r=JSON.parse(fs.readFileSync(la.rf,'utf8').replace(/^﻿/,'').split(/\r?\n/)[0]);
  assert.equal(r.__EXIT__,0);assert.ok(r.__REPORT__.includes('kimitest4'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
