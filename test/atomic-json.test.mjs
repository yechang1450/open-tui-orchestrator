import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {atomicJson} from '../scripts/core/leases.mjs';

test('atomicJson preserves the previous state when every replacement rename fails',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'otui-atomic-json-'));
 const file=path.join(dir,'state.json');
 const originalRename=fs.renameSync;
 fs.writeFileSync(file,JSON.stringify({old:true}),'utf8');
 fs.renameSync=(...args)=>{throw Object.assign(new Error('simulated lock'),{code:'EPERM'});};
 try{
  assert.throws(()=>atomicJson(file,{new:true}),/simulated lock/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{old:true});
 }finally{
  fs.renameSync=originalRename;
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
