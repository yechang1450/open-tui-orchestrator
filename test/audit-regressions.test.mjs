import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const family=path.join(root,'temp');

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