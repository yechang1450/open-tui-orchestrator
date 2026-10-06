import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const family=path.join(root,'temp');

test('junction switch rejects release traversal before touching the junction', {skip:process.platform!=='win32'}, ()=>{
 const home=fs.mkdtempSync(path.join(family,'junction-audit-'));
 const tools=path.join(home,'.tools'),junction=path.join(tools,'node24-fresh','node_modules','open-tui-orchestrator');
 const target=path.join(tools,'escape','open-tui-orchestrator');
 fs.mkdirSync(target,{recursive:true});
 const script=path.join(root,'tools','flip-orch-junction.ps1');
 try{
  const result=spawnSync('pwsh',['-NoProfile','-File',script,'-Version','..\\escape'],{cwd:root,env:{...process.env,USERPROFILE:home},encoding:'utf8',windowsHide:true,timeout:15000});
  assert.notEqual(result.status,0,result.stdout+result.stderr);
  assert.equal(fs.existsSync(junction),false,'a traversal attempt must not create the junction');
 }finally{try{fs.rmSync(path.join(tools,'node24-fresh'),{recursive:true,force:true});}catch{}fs.rmSync(home,{recursive:true,force:true});}
});

test('leak scanner exits non-zero for a credential-shaped worktree hit', ()=>{
 const dir=fs.mkdtempSync(path.join(family,'leak-audit-'));
 const file=path.join(dir,'fixture.txt');
 const fakeKey='sk-'+'fixture'.repeat(3);
 fs.writeFileSync(file,'token=«redacted:'+fakeKey+'»\n','utf8');
 const script=path.join(root,'tools','orch-leak-scan.py');
 try{
  const result=spawnSync('python',[script,dir,'--no-history','--identity','audit-user'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:15000});
  assert.notEqual(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/凭据形态/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});