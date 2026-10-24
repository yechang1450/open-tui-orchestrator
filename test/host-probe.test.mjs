import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {probeCli,normalizeProbeTimeout} from '../scripts/core/host-probe.mjs';
import {resolveHost} from '../scripts/core/host-cli.mjs';

// 假 kimi CLI（.mjs 形态，走 resolveKimiHost 的 prefixArgs 分支）：
// good=正常；flaky=首次调用睡 FAKE_SLEEP_MS 后以 1 退出（模拟冷启动超时），其后正常；
// sleep=每次都睡（持续超时）；exit1=确定性失败。调用次数记进 FAKE_STATE。
const FAKE=`import fs from 'node:fs';
const state=process.env.FAKE_STATE,mode=process.env.FAKE_MODE||'good';
let n=0;try{n=Number(fs.readFileSync(state,'utf8'))}catch{}try{fs.writeFileSync(state,String(n+1))}catch{}
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const args=process.argv.slice(2);
if(mode==='sleep'){sleep(Number(process.env.FAKE_SLEEP_MS||3000));process.exit(1);}
if(args.includes('--version')){console.log('9.9.9');process.exit(0);}
if(args.includes('--help')){
 if(mode==='exit1')process.exit(1);
 if(mode==='flaky'&&n===0){sleep(Number(process.env.FAKE_SLEEP_MS||3000));process.exit(1);}
 console.log('--prompt --output-format --auto');process.exit(0);
}
process.exit(2);
`;

function setup(mode,extra={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-probe-'));
 const fake=path.join(dir,'fake-kimi.mjs');
 fs.writeFileSync(fake,FAKE);
 const state=path.join(dir,'state.txt');
 return {dir,fake,state,env:{...process.env,FAKE_STATE:state,FAKE_MODE:mode,...extra},cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
const callCount=s=>{try{return Number(fs.readFileSync(s,'utf8'))}catch{return 0;}};

test('probeCli retries a timed-out probe and a later attempt succeeds',()=>{
 const {fake,state,env,cleanup}=setup('flaky',{FAKE_SLEEP_MS:'8000'});
 try{
  const r=probeCli(process.execPath,[fake,'--help'],{env,timeoutMs:2000,attempts:3});
  assert.equal(r.status,0);
  assert.ok(r.out.includes('--prompt'));
  assert.ok(callCount(state)>=2,'a timed-out first attempt must be retried');
 }finally{cleanup();}
});

test('probeCli gives up after the configured attempts on persistent timeout',()=>{
 const {fake,state,env,cleanup}=setup('sleep',{FAKE_SLEEP_MS:'8000'});
 try{
  const r=probeCli(process.execPath,[fake,'--help'],{env,timeoutMs:2500,attempts:2});
  assert.notEqual(r.status,0);
  assert.match(r.error||'',/ETIMEDOUT|timed out/i);
  assert.ok(callCount(state)>=2,'both attempts must have been launched (retry on persistent timeout)');
 }finally{cleanup();}
});

test('probeCli never retries deterministic failures',()=>{
 const {fake,state,env,cleanup}=setup('exit1');
 try{
  const r=probeCli(process.execPath,[fake,'--help'],{env,timeoutMs:8000,attempts:3});
  assert.equal(r.status,1);
  assert.equal(callCount(state),1);
 }finally{cleanup();}
});
test('probeCli normalizes invalid bounds and treats zero attempts as one attempt',()=>{
 const {fake,state,env,cleanup}=setup('exit1');
 try{
  const r=probeCli(process.execPath,[fake,'--help'],{env,timeoutMs:-1,attempts:0});
  assert.equal(r.status,1);
  assert.equal(callCount(state),1);
 }finally{cleanup();}
});
test('probeCli gives timeoutMs=0 an explicit default-timeout meaning',()=>{
 assert.equal(normalizeProbeTimeout(undefined),10000);
 assert.equal(normalizeProbeTimeout(0),10000);
 assert.equal(normalizeProbeTimeout(-1),10000);
 assert.equal(normalizeProbeTimeout(Infinity),10000);
 assert.equal(normalizeProbeTimeout(150000),120000);
});

test('kimi resolution survives a transient probe timeout (fake CLI)',()=>{
 // 钉死 attempts=2：probeCli 的 rawAttempts 读 env.ORCH_HOST_PROBE_ATTEMPTS（host-probe.mjs:20），
 // 而 setup() 继承 process.env —— 调用方为了缩短探测预算设成 1 时，这条「超时后重试」的用例就会
 // 必红（2026-10-25 实测：门禁带 ORCH_HOST_PROBE_ATTEMPTS=1 时红，去掉即绿）。用例的自变量不应
 // 由外部环境决定。
 const {fake,env,cleanup}=setup('flaky',{FAKE_SLEEP_MS:'8000',ORCH_HOST_PROBE_TIMEOUT_MS:'3000',ORCH_HOST_PROBE_ATTEMPTS:'2'});
 try{
  const host=resolveHost({env:{...env,ORCH_AGENT:'kimi',ORCH_CLI:fake}});
  assert.equal(host.agent,'kimi');
  assert.equal(host.config.version,'9.9.9');
 }finally{cleanup();}
});

test('CLI_MISSING diagnostics name the rejected candidate and reason',()=>{
 const {fake,env,cleanup}=setup('exit1');
 try{
  assert.throws(()=>resolveHost({env:{...env,ORCH_AGENT:'kimi',ORCH_CLI:fake}}),err=>{
   assert.match(err.message,/CLI_MISSING: kimi/);
   assert.ok(err.message.includes(fake),'message names the tried path');
   assert.match(err.message,/--help/);
   return true;
  });
 }finally{cleanup();}
});

// .cmd/.bat 不能直接 spawn（CreateProcess 执行不了批处理，实测 EINVAL）——2026-10-06 实测：
// hermes 现场 4 个候选里两个 .cmd 全部 EINVAL，而 EINVAL 不是超时、不会被重试，
// 等于把「npm 全局装出来的宿主 CLI」永久判成不可用。修法与 install-deps.mjs 同形：
// 走 cmd /d /s /c 的 verbatim 形态。
// 红例：退回裸 spawnSync(bin,args,{shell:false}) 时本用例必红（EINVAL）。
test('probeCli can actually run a .cmd shim instead of reporting EINVAL',{skip:process.platform!=='win32'},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-probe-cmd-'));
 const shim=path.join(dir,'fake-host.cmd');
 fs.writeFileSync(shim,'@echo off\r\nif "%1"=="--version" echo 7.7.7\r\nexit /b 0\r\n');
 try{
  const r=probeCli(shim,['--version'],{timeoutMs:30000,attempts:1});
  assert.equal(r.error,null,'a .cmd shim must be spawnable, got '+(r.error||'none'));
  assert.equal(r.status,0,'the shim must run: '+JSON.stringify(r));
  assert.match(r.out,/7\.7\.7/,'the shim output must be captured');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

// ANSI 剥离（2026-10-11）：--help 在 FORCE_COLOR/PTY 继承下可能带色（pi 实测）；probeCli 的
// 合并校验面 out 必须先剥 CSI 序列，stdout/stderr 保留原文供需要原字节的调用者。
// 红例：out 退回原文时，下面这种「颜色把旗标切成两段」的形态会让 includes('--prompt') 失配。
test('probeCli strips ANSI from the merged verdict surface but keeps raw streams',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-probe-ansi-'));
 const esc=String.fromCharCode(27);
 const fake=path.join(dir,'fake-ansi.mjs');
 fs.writeFileSync(fake,`const e=String.fromCharCode(27);console.log('--pro'+e+'[1m'+'mpt --auto');process.exit(0);\n`);
 try{
  const r=probeCli(process.execPath,[fake,'--help'],{timeoutMs:15000,attempts:1});
  assert.equal(r.status,0);
  assert.ok(r.out.includes('--prompt'),'the verdict surface must be plain text, got: '+JSON.stringify(r.out));
  assert.ok(!r.out.includes(esc),'ANSI sequences must be stripped from out');
  assert.ok(r.stdout.includes(esc),'raw stdout keeps the original bytes');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

// 宽列注入（2026-10-11）：窄终端下列宽敏感的 CLI 会省略旗标（kimi 实测 80 列丢 --auto、
// COLUMNS=200 全量）；probeCli 默认注入 COLUMNS=200，调用者显式设置优先。
test('probeCli injects COLUMNS=200 by default and respects an explicit override',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-probe-cols-'));
 const fake=path.join(dir,'fake-cols.mjs');
 fs.writeFileSync(fake,`console.log('COLUMNS='+(process.env.COLUMNS===undefined?'<unset>':process.env.COLUMNS));process.exit(0);\n`);
 try{
  const baseEnv={...process.env};delete baseEnv.COLUMNS;
  const base=probeCli(process.execPath,[fake,'--help'],{env:baseEnv,timeoutMs:15000,attempts:1});
  assert.ok(base.out.includes('COLUMNS=200'),'a wide-column default must be injected, got: '+base.out.trim());
  const over=probeCli(process.execPath,[fake,'--help'],{env:{...baseEnv,COLUMNS:'300'},timeoutMs:15000,attempts:1});
  assert.ok(over.out.includes('COLUMNS=300'),'an explicit COLUMNS must win, got: '+over.out.trim());
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
