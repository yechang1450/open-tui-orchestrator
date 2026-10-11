import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveOpenClawHost,openclawArgs,OPENCLAW_LAST_VERIFIED} from '../scripts/core/openclaw-host.mjs';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');fs.mkdirSync(family,{recursive:true});
function fakePackage({version='2026.10.1',name='openclaw',help='--local --message --message-file --json'}){
  const dir=fs.mkdtempSync(path.join(family,'openclaw-fake-'));
  fs.writeFileSync(path.join(dir,'openclaw.cmd'),'@ECHO off\r\nnode "%~dp0\\node_modules\\openclaw\\openclaw.mjs" %*\r\n','utf8');
  const pkgDir=path.join(dir,'node_modules','openclaw');fs.mkdirSync(pkgDir,{recursive:true});
  fs.writeFileSync(path.join(pkgDir,'openclaw.mjs'),`if(process.argv.includes('--help')){console.log(${JSON.stringify(help)});process.exit(0);}console.log('{}');`,'utf8');
  fs.writeFileSync(path.join(pkgDir,'package.json'),JSON.stringify({name,version,bin:{openclaw:'openclaw.mjs'}}),'utf8');
  return dir;
}
test('openclaw resolves the npm shim to the packaged entry behind an interface probe',()=>{
 const dir=fakePackage({});
 try{
  const host=resolveOpenClawHost({OPENCLAW_EXE:path.join(dir,'openclaw.cmd'),PATH:''});
  assert.equal(host.agent,'openclaw');
  assert.equal(host.config.id,'openclaw');
  assert.equal(host.config.version,'2026.10.1');
  assert.equal(host.config.lastVerified,OPENCLAW_LAST_VERIFIED);
  assert.equal(host.config.entry,path.join(dir,'node_modules','openclaw','openclaw.mjs'));
  assert.deepEqual(host.config.prefixArgs,[host.config.entry]);
  assert.equal(host.config.native,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('openclaw fails closed when the agent interface probe mismatches',()=>{
 const dir=fakePackage({help:'some unrelated help text'});
 try{
  assert.throws(()=>resolveOpenClawHost({OPENCLAW_EXE:path.join(dir,'openclaw.cmd'),PATH:''}),/CLI_MISSING: openclaw.*flags mismatch/s);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('openclaw fails closed on a package identity mismatch',()=>{
 const dir=fakePackage({name:'not-openclaw'});
 try{
  assert.throws(()=>resolveOpenClawHost({OPENCLAW_EXE:path.join(dir,'openclaw.cmd'),PATH:''}),/CLI_MISSING: openclaw.*package identity/s);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('openclaw argv drives the official headless agent surface and carries the model',()=>{
 const config={prefixArgs:['C:\\x\\openclaw.mjs']};
 assert.deepEqual(openclawArgs(config,{}),['C:\\x\\openclaw.mjs','agent','--local']);
 assert.deepEqual(openclawArgs(config,{model:'opencode-go/deepseek-v4.1-flash'}),['C:\\x\\openclaw.mjs','agent','--local','--model','opencode-go/deepseek-v4.1-flash']);
 assert.deepEqual(openclawArgs(config,{model:'two words'}),['C:\\x\\openclaw.mjs','agent','--local']);
});
