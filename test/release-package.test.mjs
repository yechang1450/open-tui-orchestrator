import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {verifyRelease} from '../scripts/release-integrity.mjs';

const source=fileURLToPath(new URL('..',import.meta.url));
const family=path.join('D:\\temp','orchestrator');

test('published generic package keeps polling usable and diagnoses missing SDK',()=>{
  fs.mkdirSync(family,{recursive:true});
  const root=fs.mkdtempSync(path.join(family,'generic-package-'));
  try{
    const publish=spawnSync(process.execPath,[path.join(source,'repair.mjs'),'--target',root],{cwd:source,encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(publish.status,0,publish.stderr||publish.stdout);
    const pkg=path.join(root,'open-tui-orchestrator');
    assert.deepEqual(verifyRelease(pkg),verifyRelease(source));
    const poll=spawnSync(process.execPath,[path.join(pkg,'scripts','poll-windows.mjs'),'--run-id','package-test','--timeoutMs','0'],{cwd:source,encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(poll.status,1,poll.stderr);
    assert.match(poll.stderr,/timeout runId=package-test/);
    const doctor=spawnSync(process.execPath,[path.join(pkg,'scripts','orchestrate-sdk.mjs'),'--doctor'],{cwd:source,encoding:'utf8',windowsHide:true,timeout:30000});
    assert.notEqual(doctor.status,0);
    assert.match(doctor.stderr,/RELEASE_DEPENDENCY_MISSING.*npm ci/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
