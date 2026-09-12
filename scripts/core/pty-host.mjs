#!/usr/bin/env node
// PTY 载体宿主：把单个启动器（win-launch-*.ps1）放进 ConPTY 伪终端里运行。
// 需要终端的 TUI 类 agent 因此拿到真实控制台，而整条链完全不可见（无窗口、不抢焦点）。
// 独立进程：控制器死亡不影响本宿主；进程树（宿主→ps1→agent）、pidf、身份、租约、
// 恢复/收编契约与窗口模式同构。stdout/stderr 落在 ORCH_PTY_LOG 指向的日志文件里，
// 供失败诊断（该文件由控制器的清理钩子在块结束后回收）。
// 用法：node pty-host.mjs <win-launch-*.ps1>   （cwd/env 由控制器给出）
import fs from 'node:fs';
import path from 'node:path';
import { loadPtyEngine } from './unit-carrier.mjs';
import { powershellExe } from './contracts.mjs';

const lp = String(process.argv[2] || '');
const logFile = String(process.env.ORCH_PTY_LOG || '').trim()
  || (lp ? path.join(path.dirname(lp), path.basename(lp).replace(/\.ps1$/, '') + '.pty.log') : '');

function fail(message) {
  try { if (logFile) fs.appendFileSync(logFile, '[pty-host] ' + message + '\n', 'utf8'); } catch { /* best effort */ }
  console.error(message);
  process.exit(3);
}

if (!lp || !fs.existsSync(lp)) fail('PTY_HOST_USAGE: node pty-host.mjs <win-launch.ps1> (got: ' + lp + ')');

let pty;
try { pty = loadPtyEngine(); } catch (error) { fail(String(error && error.message || error)); }

let stream = null;
try { stream = fs.createWriteStream(logFile, { flags: 'a' }); } catch { /* diagnostics only */ }

const term = pty.spawn(powershellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', lp], {
  name: 'xterm-256color', cols: 200, rows: 50, cwd: process.cwd(), env: process.env,
});
term.onData((data) => { if (stream) { try { stream.write(data); } catch { /* best effort */ } } });
term.onExit(() => {
  if (stream) { try { stream.end(); } catch { /* best effort */ } }
  process.exit(0);
});
