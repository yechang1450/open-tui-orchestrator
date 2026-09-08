import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteWindowsArgument,spawnInactiveWindow,spawnInactiveWindowDetached} from '../scripts/core/inactive-window.mjs';

test('inactive launch preserves arguments and hides only its short-lived helper',()=>{
 assert.equal(quoteWindowsArgument(''),'""');
 assert.equal(quoteWindowsArgument('a"b'),'"a\\"b"');
 assert.equal(quoteWindowsArgument('C:\\space dir\\'),'"C:\\space dir\\\\"');
 assert.throws(()=>quoteWindowsArgument('\0'),/NUL/);
 let called=0;
 spawnInactiveWindow('C:\\Windows\\powershell.exe',['中文 空格','a"b'],'D:\\',{invoke:(file,args,options)=>{
  called++;assert.equal(file,'powershell.exe');assert.equal(options.windowsHide,true);assert.equal(options.shell,false);
  const payload=JSON.parse(Buffer.from(args.at(-1),'base64').toString('utf8'));
  assert.equal(payload.cwd,'D:\\');
  assert.equal(payload.parameters,'"中文 空格" "a\\"b"');
  return {status:0};
 }});assert.equal(called,1);
});

test('inactive launch fails explicitly instead of falling back to a focusing window',()=>{
 assert.throws(()=>spawnInactiveWindow('missing',[],'D:\\',{invoke:()=>({status:1,stderr:'failed'})}),/INACTIVE_WINDOW_LAUNCH_FAILED/);
});

test('detached inactive launch starts the focus-restoring helper without blocking the scheduler',()=>{
 let called=0,unref=0;
 const child={unref(){unref++;}};
 const result=spawnInactiveWindowDetached('C:\\Windows\\wt.exe',['-w','win-x'],'D:\\',{invoke:(file,args,options)=>{
  called++;assert.equal(file,'powershell.exe');assert.equal(options.detached,true);assert.equal(options.windowsHide,true);assert.equal(options.stdio,'ignore');
  const payload=JSON.parse(Buffer.from(args.at(-1),'base64').toString('utf8'));
  assert.equal(payload.file,'C:\\Windows\\wt.exe');assert.equal(payload.cwd,'D:\\');assert.equal(payload.parameters,'"-w" "win-x"');
  return child;
 }});
 assert.equal(result,child);assert.equal(called,1);assert.equal(unref,1);
});
