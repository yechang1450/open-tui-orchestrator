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
// 2026-10-26（P9）：createWriteStream 是**懒打开**的 —— 构造后文件并不存在，首次 write 才落盘
//（实测 existsSync 立即返回 false）。所以写入失败时（磁盘满/杀软锁文件）只会异步 emit 'error'，
// 原代码没有监听 ⇒ 未捕获异常直接把宿主打死，单元以 "Launcher exited without result" 失败，
// 而且 .pty.log 根本不存在 ⇒ 3 次重试全是零诊断秒退。这里把错误降级为 stderr 提示，不中断单元。
if (stream) stream.on('error', (error) => { try { process.stderr.write('[pty-host] trace log unwritable: ' + String(error && error.message || error) + '\n'); } catch { /* nothing left */ } });

// 2026-10-26（P4）：ConPTY 每一帧重绘都无条件落盘 —— TUI 的 spinner/计时器会让单个单元的
// .pty.log 长到几十~几百 MB（200×50 全屏重绘 × 每秒数帧），8 并发叠加足以在 45 分钟窗口里爆盘
// （checkDiskSpace 只在开跑前查一次）。这里只保留前 PTY_LOG_MAX_BYTES，之后停止落盘但**不中断**
// 终端本身（单元照常跑到结束，只是不再留全量屏帧）；超限时写一行说明，事后复盘知道被截过。
const PTY_LOG_MAX_BYTES = 8 * 1024 * 1024;
let written = 0, truncated = false;

// 2026-10-26（P9）：ConPTY 创建失败（旧 Win10/Server Core、conhost 被策略禁用、pty 句柄耗尽）
// 时 pty.spawn 会直接抛，原来不在任何 try 内 ⇒ 未捕获异常秒退、零诊断。
let term;
try {
  term = pty.spawn(powershellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', lp], {
    name: 'xterm-256color', cols: 200, rows: 50, cwd: process.cwd(), env: process.env,
  });
} catch (error) {
  fail('ConPTY could not be created: ' + String(error && error.message || error));
}
term.onData((data) => {
  if (!stream || truncated) return;
  written += Buffer.byteLength(String(data));
  if (written > PTY_LOG_MAX_BYTES) {
    truncated = true;
    try { stream.write('\r\n[pty-host] trace truncated at ' + PTY_LOG_MAX_BYTES + ' bytes — further screen frames are not logged\r\n'); } catch { /* best effort */ }
    return;
  }
  try { stream.write(data); } catch { /* best effort */ }
});
term.onExit(({ exitCode } = {}) => {
  // 2026-10-26（P10）：原来 stream.end() 后立刻 process.exit(0) —— 缓冲未 flush，尾部屏帧
  //（错误横幅恰在这最后几百 KB 里）被截掉；而且退出码恒 0，任何把宿主当子进程等待的调用方
  // 都会把单元崩溃读成成功。现在等 flush 完成再退出，并把 ConPTY 的 exitCode 透传出去；
  // 2 秒兜底防止 stream 已出错时 end() 的回调永不触发。
  const code = Number.isInteger(exitCode) ? exitCode : 0;
  if (!stream) { process.exit(code); return; }
  let done = false;
  const finish = () => { if (done) return; done = true; process.exit(code); };
  setTimeout(finish, 2000).unref?.();
  try { stream.end(finish); } catch { finish(); }
});
