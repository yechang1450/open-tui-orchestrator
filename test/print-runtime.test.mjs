import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runProfilePlanner,writeProfileLauncher} from '../scripts/core/print-runtime.mjs';
import {writeUnitLauncher} from '../scripts/core/unit-runtime.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');fs.mkdirSync(family,{recursive:true});
const fakeConfig=(worker)=>({id:'fakeprint',label:'fakeprint',bin:process.execPath,prefixArgs:[worker],profile:{args:{prompt:['--message']}}});

test('print planner decodes UTF-8 split across stdout chunks without replacement characters',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'print-runtime-utf8-'));
 try{
  const worker=path.join(dir,'split-utf8.mjs');
  fs.writeFileSync(worker,"const buf=Buffer.from('你');\nprocess.stdout.write(buf.subarray(0,2));\nsetTimeout(()=>{process.stdout.write(buf.subarray(2));},30);\n");
  const r=await runProfilePlanner(fakeConfig(worker),'规划',dir);
  assert.equal(r.final,'你');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('print planner reports an explicit oversized-output failure instead of an ambiguous kill',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'print-runtime-oversize-'));
 try{
  const worker=path.join(dir,'oversize.mjs');
  fs.writeFileSync(worker,"const chunk='A'.repeat(65536);\nlet n=0;\nconst pump=()=>{while(n<140){n++;if(!process.stdout.write(chunk)){process.stdout.once('drain',pump);return;}}}\npump();\n");
  await assert.rejects(runProfilePlanner(fakeConfig(worker),'规划',dir),/PLANNER_OUTPUT_TOO_LARGE/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('print planner kills a hung child after the configured timeout and settles',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'print-runtime-timeout-'));
 const prev=process.env.ORCH_DECOMPOSE_TIMEOUT_MS;process.env.ORCH_DECOMPOSE_TIMEOUT_MS='500';
 try{
  const worker=path.join(dir,'hung.mjs');
  fs.writeFileSync(worker,'setTimeout(()=>{},30000);\n');
  await assert.rejects(runProfilePlanner(fakeConfig(worker),'规划',dir),/PLANNER_TIMEOUT/);
 }finally{if(prev===undefined)delete process.env.ORCH_DECOMPOSE_TIMEOUT_MS;else process.env.ORCH_DECOMPOSE_TIMEOUT_MS=prev;fs.rmSync(dir,{recursive:true,force:true});}
});

test('print planner timeout path guards the exit race and escalates the kill',()=>{
 const src=fs.readFileSync(path.join(root,'scripts/core/print-runtime.mjs'),'utf8');
 assert.match(src,/child\.exitCode !== null \|\| child\.signalCode !== null/,'timer must not flag a timeout once the child has already exited');
 assert.match(src,/SIGKILL/,'timeout kill must escalate beyond a single child.kill()');
 assert.match(src,/StringDecoder/,'stdout must be decoded across chunk boundaries');
 assert.match(src,/child\.on\('close'/,'settlement must wait for stdio close, not just exit');
});

test('print launcher quotes the display label so quotes and $() cannot break the PowerShell body',()=>{
 const dir=fs.mkdtempSync(path.join(family,'print-launch-label-'));
 try{
  const la=writeProfileLauncher({id:'fakeprint',label:'Evil"$(1)',bin:process.execPath,profile:{args:{prompt:['--message']}}},{key:'B1',suffix:'esc',prompt:'任务\n【本块唯一标识】tok1',workspace:dir,temp:path.join(dir,'temp')});
  const body=fs.readFileSync(la.lp,'utf8');
  assert.ok(body.includes("Write-Host '  EVIL\"$(1) TASK RUNNING - closes automatically on completion'"),'label must be a single-quoted PowerShell literal');
  assert.ok(!/Write-Host "  EVIL/.test(body),'label must not be interpolated into a double-quoted literal');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('unit launcher quotes the display label the same way',()=>{
 const dir=fs.mkdtempSync(path.join(family,'unit-launch-label-'));
 try{
  const unit={schema:1,id:'fakeunit',label:'Evil"$(1)',bin:process.execPath,args:['{prompt}'],promptDelivery:'arg',modelArgs:null,effortArgs:null,timeoutMs:null};
  const la=writeUnitLauncher(unit,{key:'B1',suffix:'esc',prompt:'任务\n【本块唯一标识】tok2',workspace:dir,temp:path.join(dir,'temp')});
  const body=fs.readFileSync(la.lp,'utf8');
  assert.ok(body.includes("Write-Host '  EVIL\"$(1) TASK RUNNING - closes automatically on completion'"),'unit label must be a single-quoted PowerShell literal');
  assert.ok(!/Write-Host "  EVIL/.test(body),'unit label must not be interpolated into a double-quoted literal');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
