#!/usr/bin/env node
// orch — open-tui-orchestrator 强制编排入口。
// 与常规 --run-windows 完全相同，但跳过所有 inline 回退门：单块、纯串行、只读定性、
// 自改请求都会照常派发执行单元（headless 默认，--mode window 可切弹窗）。
// 唯一仍然生效的门是维护锁：锁定期调用照旧只回固定话术并放行。
// 用法: orch [--mode headless|exec|window] [--run-id id] [--acceptance-file f] <请求...>
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enforceWindowsOnly } from './scripts/platform-guard.mjs';
const args = process.argv.slice(2);
if (!args.length) {
  console.log('usage: orch [--mode headless|exec|window] [--run-id id] [--acceptance-file file] [--plan-file f] [--unit-cmd json | --unit-cmd-file f] <request>\nread-only: orch --tasks <request> | --doctor | --status | --version | --help');
  process.exit(2);
}
if (enforceWindowsOnly(args)) process.exit(1);
// 只读入口透传（2026-10-15 修）：orch 的强制发车语义只该加在【执行类】入口上。旧实现无条件给
// cli.mjs 拼上 --run-windows，于是 `orch --tasks "需求"` 里的 --tasks 落到位置 3，被引擎
// （mode = argv[2]）当成请求文本——只想核对账本却真的发了车。这里让只读入口原样透传：不加
// --run-windows、不注入 ORCH_FORCE_EXECUTE，orch 与 cli.mjs 在只读入口上表现一致。判据是
// 【首个 flag】属于只读入口集合：执行类请求的文本本身可以含短横线，而首个 flag 是用户
// 明确指定的入口模式，歧义最小。
const READ_ONLY_ENTRIES = new Set(['--tasks', '--status', '--doctor', '--watch', '--verify-run', '--clear-cache', '--version', '--help', '-h', '--install-deps']);
const firstFlag = args.findIndex((arg) => arg.startsWith('-'));
const readOnly = firstFlag >= 0 && READ_ONLY_ENTRIES.has(args[firstFlag]);
const child = spawn(process.execPath, [
  fileURLToPath(new URL('./cli.mjs', import.meta.url)),
  ...(readOnly ? args : ['--run-windows', ...args]),
], {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, ORCH_FORCE_EXECUTE: readOnly ? '' : '1' },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
