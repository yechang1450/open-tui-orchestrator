import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {waitOpenClawResult,writeOpenClawLauncher} from '../scripts/core/openclaw-runtime.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const family=path.resolve(root,'temp');fs.mkdirSync(family,{recursive:true});
const windowScript=path.join(root,'scripts','core','openclaw-window.mjs');

function tempFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otui-openclaw-runtime-'));
  return {dir, rf: path.join(dir, 'result.json'), pidf: path.join(dir, 'launcher.pid')};
}

test('waitOpenClawResult accepts an atomically written verified result', async () => {
  const {dir, rf, pidf} = tempFiles();
  try {
    fs.writeFileSync(pidf, String(process.pid), 'utf8');
    setTimeout(() => {
      const tmp = `${rf}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({__EXIT__: 0, __DONE__: true, __REPORT__: '__ORCH_DONE__ T001'}), 'utf8');
      fs.renameSync(tmp, rf);
    }, 20);
    const result = await waitOpenClawResult(rf, 500, pidf);
    assert.deepEqual(result, {done: true, exitCode: 0, text: '__ORCH_DONE__ T001'});
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('waitOpenClawResult reports a dead launcher without a result', async () => {
  const {dir, rf, pidf} = tempFiles();
  try {
    // 用合法范围内不存在的 PID（真 ESRCH）；超范围值（4294967295 → ERR_INVALID_ARG_TYPE）属
    // “非法值”而非“已死”，健壮化后不得据此判死（见 malformed pid 用例）。
    fs.writeFileSync(pidf, '99999999', 'utf8');
    const result = await waitOpenClawResult(rf, 300, pidf);
    assert.equal(result.done, true);
    assert.equal(result.exitCode, 1);
    assert.match(result.text, /OpenClaw launcher exited without result/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('waitOpenClawResult distinguishes a completion timeout', async () => {
  const {dir, rf, pidf} = tempFiles();
  try {
    const result = await waitOpenClawResult(rf, 40, pidf);
    assert.deepEqual(result, {done: false, exitCode: null, text: 'OpenClaw completion timeout'});
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('openclaw launcher clears stale result and pid files before a replay of the same stem',()=>{
 const dir=fs.mkdtempSync(path.join(family,'openclaw-launch-stale-'));
 try{
  const cfg={bin:process.execPath,entry:'noop.mjs',packageRoot:dir};
  const opts={key:'B1',suffix:'rep',prompt:'任务\n【本块唯一标识】ocStale1',workspace:dir,temp:path.join(dir,'temp')};
  const first=writeOpenClawLauncher(cfg,opts);
  fs.writeFileSync(first.rf,'{"stale":true}');
  fs.writeFileSync(first.pidf,'12345');
  const second=writeOpenClawLauncher(cfg,opts);
  assert.equal(second.rf,first.rf);
  assert.equal(fs.existsSync(first.rf),false,'stale result must be cleared before a replay');
  assert.equal(fs.existsSync(first.pidf),false,'stale pid file must be cleared before a replay');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('openclaw result wait only accepts a result carrying the expected token',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'openclaw-wait-token-'));
 try{
  const rf=path.join(dir,'r.json');
  fs.writeFileSync(rf,JSON.stringify({__EXIT__:0,__DONE__:true,__REPORT__:'ok',token:'other-stem'}),'utf8');
  const mismatch=await waitOpenClawResult(rf,700,path.join(dir,'missing.pid'),'expected-stem');
  assert.equal(mismatch.done,false,'a result from another stem must not be accepted: '+JSON.stringify(mismatch));
  fs.writeFileSync(rf,JSON.stringify({__EXIT__:0,__DONE__:true,__REPORT__:'ok',token:'expected-stem'}),'utf8');
  const match=await waitOpenClawResult(rf,700,path.join(dir,'missing.pid'),'expected-stem');
  assert.equal(match.done,true);assert.equal(match.exitCode,0);assert.equal(match.text,'ok');
  const noExpectation=await waitOpenClawResult(rf,700,path.join(dir,'missing.pid'));
  assert.equal(noExpectation.done,true,'omitting the expected token keeps the previous contract');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('openclaw result wait survives a malformed pid file without a false exit report',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'openclaw-wait-pid-'));
 try{
  const badPid=path.join(dir,'bad.pid');fs.writeFileSync(badPid,'not-a-pid','utf8');
  const r=await waitOpenClawResult(path.join(dir,'missing.json'),600,badPid);
  assert.equal(r.done,false,'malformed pid must not be read as an exited launcher: '+JSON.stringify(r));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('openclaw window writes a failed result instead of a raw stack when setup fails',()=>{
 const dir=fs.mkdtempSync(path.join(family,'openclaw-window-setup-'));
 try{
  const rf=path.join(dir,'result.json');
  const specFile=path.join(dir,'spec.json');
  fs.writeFileSync(path.join(dir,'p.md'),'prompt','utf8');
  fs.writeFileSync(specFile,JSON.stringify({ptyEntry:'no-such-module-xyz',bin:process.execPath,entry:'x.mjs',workspace:dir,result:rf,token:'tok',state:path.join(dir,'state'),prompt:path.join(dir,'p.md'),timeoutMs:1000}),'utf8');
  const r=spawnSync(process.execPath,[windowScript,specFile],{encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(r.status,1,r.stderr);
  assert.doesNotMatch(r.stderr,/node:internal/,'setup failures must not leak raw Node stacks: '+r.stderr);
  const res=JSON.parse(fs.readFileSync(rf,'utf8'));
  assert.equal(res.__DONE__,true);assert.equal(res.__EXIT__,1);assert.match(res.__REPORT__,/OPENCLAW_PTY_UNAVAILABLE/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('openclaw window refuses an unreadable spec without a raw stack',()=>{
 const dir=fs.mkdtempSync(path.join(family,'openclaw-window-spec-'));
 try{
  const r=spawnSync(process.execPath,[windowScript,path.join(dir,'no-spec.json')],{encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(r.status,1,r.stderr);
  assert.doesNotMatch(r.stderr,/node:internal/,'spec failures must not leak raw Node stacks: '+r.stderr);
  assert.match(r.stderr,/OPENCLAW_SPEC_UNREADABLE/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('openclaw window re-checks the transcript once on exit before giving up on the marker',()=>{
 const src=fs.readFileSync(windowScript,'utf8');
 assert.match(src,/const readCompletion=/,'transcript read must be a reusable function');
 assert.match(src,/onExit\([\s\S]{0,800}?readCompletion\(\)/,'onExit must perform a final transcript check');
});
