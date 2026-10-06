import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const family=path.resolve(root,'temp');fs.mkdirSync(family,{recursive:true});
const node=process.execPath;

function makeLink(){
  const dir=fs.mkdtempSync(path.join(family,'entry-realpath-'));
  const link=path.join(dir,'repo-link');
  fs.symlinkSync(root,link,'junction');
  return {dir,link};
}

test('todo-list runs its checker when invoked through a junction',()=>{
 const {dir,link}=makeLink();
 try{
  const list=path.join(dir,'list.md');
  fs.writeFileSync(list,'目标\n- [ ] 步骤一\n- [ ] 步骤二\n收尾验证完成\n');
  const r=spawnSync(node,[path.join(link,'scripts','todo-list.mjs'),'--check',list,'--json'],{encoding:'utf8',timeout:60000});
  const parsed=JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.checks)&&parsed.checks.length>0,'the checker must actually run through a junction entry');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('force CLI answers --status when invoked through a junction',()=>{
 const {dir,link}=makeLink();
 try{
  const r=spawnSync(node,[path.join(link,'scripts','open-tui-orchestrator-force.mjs'),'--status'],{encoding:'utf8',timeout:60000});
  assert.ok(r.stdout.includes('enforcement:'),'force --status must run through a junction entry: '+JSON.stringify(r.stdout));
  assert.ok(r.stdout.includes('alive execution windows:'),'force --status must run through a junction entry');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('orchestrate-sdk answers --status when invoked through a junction',()=>{
 const {dir,link}=makeLink();
 try{
  const r=spawnSync(node,[path.join(link,'scripts','orchestrate-sdk.mjs'),'--status'],{encoding:'utf8',timeout:120000});
  assert.ok(r.stdout.includes('=== alive agent TUI windows ==='),'sdk --status must run through a junction entry: '+JSON.stringify(r.stdout.slice(0,400)));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});


test('entry identity resolution failures fail closed instead of silently skipping main logic',()=>{
 for(const f of ['scripts/open-tui-orchestrator-force.mjs','scripts/orchestrate-sdk.mjs','scripts/todo-list.mjs']){
  const src=fs.readFileSync(path.join(root,f),'utf8');
  assert.match(src,/entryIdentityError\s*=\s*error/,f+' must retain the realpath error for the failure branch');
  assert.match(src,/ENTRY_IDENTITY_UNAVAILABLE/,f+' must name the identity failure');
  assert.match(src,/process\.exit(?:Code)?\s*(?:=|\()\s*1/,f+' must return a non-zero result on identity failure');
 }
});
