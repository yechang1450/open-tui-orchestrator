import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import {verifyRelease} from '../scripts/release-integrity.mjs';

const source=fileURLToPath(new URL('..',import.meta.url));
// 临时产物落在系统临时目录：写死的 `D:\temp` 只是作者机器的习惯，换一台没有 D: 盘的机器第一步 mkdir 就
// ENOENT（2026-09-22 本机实测：ENOENT mkdir 'D:\temp\orchestrator'，本文件这条用例全红）；也不能落在
// 本仓 temp/ 下——repair 明确拒绝"发布到源码树内部"（Publish target must be outside the source tree）。
const family=path.join(os.tmpdir(),'orchestrator');

test('published generic package keeps polling usable and diagnoses missing SDK',()=>{
  fs.mkdirSync(family,{recursive:true});
  const root=fs.mkdtempSync(path.join(family,'generic-package-'));
  // publish 的礼貌锁必须走本用例私有路径，避免与并行动作类用例的维护锁检查相撞。
  const repairEnv={...process.env,ORCH_MAINTENANCE_LOCK:path.join(root,'publish-lock.json')};
  try{
    const publish=spawnSync(process.execPath,[path.join(source,'repair.mjs'),'--target',root],{cwd:source,env:repairEnv,encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(publish.status,0,publish.stderr||publish.stdout);
    // 发行副本的目录名 = 源目录名（repair.mjs 的既有语义）：判据不得写死 `open-tui-orchestrator`，
    // 否则换名 checkout 下这条用例假红（release.json ENOENT）。
    const pkg=path.join(root,path.basename(path.resolve(source)));
    assert.deepEqual(verifyRelease(pkg),verifyRelease(source));
    const poll=spawnSync(process.execPath,[path.join(pkg,'scripts','poll-windows.mjs'),'--run-id','package-test','--timeoutMs','0'],{cwd:source,encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(poll.status,1,poll.stderr);
    assert.match(poll.stderr,/timeout runId=package-test/);
    // SDK 缺失诊断只在 codex 宿主请求时触发：显式钉住，判据不得随本壳 ORCH_AGENT 变色（2026-09-16）。
    const doctorEnv={...process.env,ORCH_AGENT:'codex'};
    const doctor=spawnSync(process.execPath,[path.join(pkg,'scripts','orchestrate-sdk.mjs'),'--doctor'],{cwd:source,env:doctorEnv,encoding:'utf8',windowsHide:true,timeout:30000});
    assert.notEqual(doctor.status,0);
    assert.match(doctor.stderr,/RELEASE_DEPENDENCY_MISSING.*npm ci/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
