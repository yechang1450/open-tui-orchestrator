import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {probeCli} from '../scripts/core/host-probe.mjs';
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
 const {fake,state,env,cleanup}=setup('flaky',{FAKE_SLEEP_MS:'3000'});
 try{
  const r=probeCli(process.execPath,[fake,'--help'],{env,timeoutMs:1200,attempts:3});
  assert.equal(r.status,0);
  assert.ok(r.out.includes('--prompt'));
  assert.equal(callCount(state),2);
 }finally{cleanup();}
});

test('probeCli gives up after the configured attempts on persistent timeout',()=>{
 const {fake,state,env,cleanup}=setup('sleep',{FAKE_SLEEP_MS:'3000'});
 try{
  const r=probeCli(process.execPath,[fake,'--help'],{env,timeoutMs:800,attempts:2});
  assert.notEqual(r.status,0);
  assert.match(r.error||'',/ETIMEDOUT|timed out/i);
  assert.equal(callCount(state),2);
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

test('kimi resolution survives a transient probe timeout (fake CLI)',()=>{
 const {fake,env,cleanup}=setup('flaky',{FAKE_SLEEP_MS:'3000',ORCH_HOST_PROBE_TIMEOUT_MS:'1200'});
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
