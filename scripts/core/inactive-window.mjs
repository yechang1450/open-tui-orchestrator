import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {powershellExe} from './contracts.mjs';

// 锚定 SystemRoot 的 powershell.exe：裸名会先按进程 cwd（任意工作区）解析，防二进制投毒。
const PS_EXE=powershellExe();

// Windows command-line quoting, including quotes and trailing backslashes.
export function quoteWindowsArgument(value){
 const text=String(value);
 if(text.includes('\0'))throw new Error('Invalid NUL in window argument');
 return '"'+text.replace(/(\\*)"/g,'$1$1\\"').replace(/\\+$/g,'$&$&')+'"';
}
// 拉起一个不抢焦点的进程；activate=true 时进一步把新窗口**真的送到用户眼前**
// （置顶→取消置顶、请求前台），并返回助手打印的机读裁决（ok/hwnd/rect/foreground/raised/minimized）。
// 背景（2026-09-17 实测）：旧路径的窗口可见且尺寸正常，但**从不激活**，助手还反复把原前台窗口
// 按回最前 2.5 秒 —— 于是"可见窗口"模式实际上是看不见的，而工具的 popup 判据只查 pidf+launcher
// 存活，因此一直是假绿。现在这个裁决就是引擎必须拿到的弹窗证据。
export function spawnInactiveWindow(file,args,cwd,{invoke=spawnSync,activate=false}={}){
 const payload=Buffer.from(JSON.stringify({file,parameters:args.map(quoteWindowsArgument).join(' '),cwd}),'utf8').toString('base64');
 const argv=['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./inactive-window.ps1',import.meta.url)),'-Payload',payload];
 if(activate)argv.push('-Activate');
 const result=invoke(PS_EXE,argv,{cwd,windowsHide:true,shell:false,encoding:'utf8',timeout:activate?25000:15000});
 if(result.error||result.status===null)throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: '+(result.error?.message||result.status));
 const text=String(result.stdout||'').trim().split(/\r?\n/).filter(Boolean).pop()||'';
 let verdict=null;
 try{verdict=JSON.parse(text);}catch{}
 if(!verdict||typeof verdict.ok!=='boolean'){
   if(result.status!==0)throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: '+(result.stderr||result.status));
   throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: helper did not return a verdict ('+text.slice(0,120)+')');
 }
 return verdict;
}

// Start the same Win32 no-activate helper without holding the scheduler while
// Windows Terminal finishes creating its window. The helper briefly restores
// the initiating foreground window and exits on its own.
export function spawnInactiveWindowDetached(file,args,cwd,{invoke=spawn}={}){
 const payload=Buffer.from(JSON.stringify({file,parameters:args.map(quoteWindowsArgument).join(' '),cwd}),'utf8').toString('base64');
 let child;
 try{
  child=invoke(PS_EXE,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./inactive-window.ps1',import.meta.url)),'-Payload',payload],{cwd,windowsHide:true,shell:false,stdio:'ignore'});
 }catch(error){throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: '+(error?.message||String(error)));}
 if(!child||typeof child.unref!=='function')throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: helper did not return a detached process');
 child.unref();
 return child;
}
