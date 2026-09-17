import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {quoteWindowsArgument,spawnInactiveWindow,spawnInactiveWindowDetached} from '../scripts/core/inactive-window.mjs';
import {powershellExe} from '../scripts/core/contracts.mjs';

// 拉起宿主统一锚定 SystemRoot 的 powershell.exe（裸名会先按 cwd=任意工作区解析，防二进制投毒）。
const PS_EXE=powershellExe();
const HELPER=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','scripts','core','inactive-window.ps1');

test('inactive launch preserves arguments and hides only its short-lived helper',()=>{
 assert.equal(quoteWindowsArgument(''),'"' + '"');
 assert.equal(quoteWindowsArgument('a"b'),'"a\\"b"');
 assert.equal(quoteWindowsArgument('C:\\space dir\\'),'"C:\\space dir\\\\"');
 assert.throws(()=>quoteWindowsArgument('\0'),/NUL/);
 let called=0;
 const verdict=spawnInactiveWindow('C:\\Windows\\powershell.exe',['中文 空格','a"b'],'D:\\',{invoke:(file,args,options)=>{
  called++;assert.equal(file,PS_EXE);assert.equal(options.windowsHide,true);assert.equal(options.shell,false);
  assert.ok(!args.includes('-Activate'),'默认不激活（保持不抢焦点的历史行为）');
  const payload=JSON.parse(Buffer.from(args.at(-1),'base64').toString('utf8'));
  assert.equal(payload.cwd,'D:\\');
  assert.equal(payload.parameters,'"中文 空格" "a\\"b"');
  return {status:0,stdout:'{"ok":true,"activated":false}\n'};
 }});
 assert.equal(called,1);
 assert.equal(verdict.ok,true);
});

// 2026-09-17：窗口"可见但从不激活、用户全程看不见"的现场教训 —— 弹窗必须先拿到机读裁决。
// activate=true 时给助手加 -Activate（它会把新窗口带到最前并回报 hwnd/rect/foreground）。
test('window activation is requested explicitly and the helper verdict is returned verbatim',()=>{
 let seen=null;
 const verdict=spawnInactiveWindow('C:\\Windows\\wt.exe',['-w','win-x'],'D:\\',{activate:true,invoke:(file,args)=>{
  seen=args;return {status:3,stdout:'noise line\n{"ok":false,"reason":"no new visible window appeared within 9000ms"}\n'};
 }});
 assert.ok(seen.includes('-Activate'),'activate=true 必须传 -Activate');
 assert.equal(verdict.ok,false);
 assert.match(verdict.reason,/no new visible window/);
});

test('inactive launch fails explicitly instead of falling back to a focusing window',()=>{
 assert.throws(()=>spawnInactiveWindow('missing',[],'D:\\',{invoke:()=>({status:1,stderr:'failed'})}),/INACTIVE_WINDOW_LAUNCH_FAILED/);
 // status 0 但没有裁决 = 助手被换掉/输出被吞 —— 也必须显式失败，不能当作"弹窗成功"。
 assert.throws(()=>spawnInactiveWindow('missing',[],'D:\\',{invoke:()=>({status:0,stdout:''})}),/INACTIVE_WINDOW_LAUNCH_FAILED/);
});

test('detached inactive launch starts the focus-restoring helper without blocking the scheduler',()=>{
 let called=0,unref=0;
 const child={unref(){unref++;}};
 const result=spawnInactiveWindowDetached('C:\\Windows\\wt.exe',['-w','win-x'],'D:\\',{invoke:(file,args,options)=>{
  called++;assert.equal(file,PS_EXE);assert.equal(options.detached,undefined);assert.equal(options.windowsHide,true);assert.equal(options.stdio,'ignore');
  const payload=JSON.parse(Buffer.from(args.at(-1),'base64').toString('utf8'));
  assert.equal(payload.file,'C:\\Windows\\wt.exe');assert.equal(payload.cwd,'D:\\');assert.equal(payload.parameters,'"-w" "win-x"');
  return child;
 }});
 assert.equal(result,child);assert.equal(called,1);assert.equal(unref,1);
});

test('inactive-window.ps1 stays ANSI-safe (ASCII only, LF) and is PowerShell-parseable', async () => {
 const buf=fs.readFileSync(HELPER);
 const text=buf.toString('utf8');
 assert.ok(!buf.includes(0x0d),'必须 LF 换行（PS5.1 兼容）');
 assert.ok(!/[^\x00-\x7F]/.test(text),'必须纯 ASCII：PS5.1 把无 BOM 的 UTF-8 当 ANSI 读，非 ASCII 会乱码');
 assert.match(text,/\$Activate/,'必须实现 -Activate 开关');
 assert.match(text,/\\"ok\\":/,'必须输出机读裁决 JSON');
 // 语法自检：PowerShell 解析器真跑一次（不拉起任何窗口）。
 const {spawnSync}=await import('node:child_process');
 const script="[void][System.Management.Automation.Language.Parser]::ParseFile('"+HELPER+"',[ref]$null,[ref]$errs);if($errs -and $errs.Count){$errs[0].Message;exit 1}else{'OK'}";
 const check=spawnSync(PS_EXE,['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8'});
 assert.equal(check.status,0,'PowerShell 必须能解析该脚本: '+String(check.stdout||check.stderr||''));
});
