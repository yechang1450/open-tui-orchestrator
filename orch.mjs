#!/usr/bin/env node
// orch — open-tui-orchestrator 强制编排入口。
// 与常规 --run-windows 完全相同，但跳过所有 inline 回退门：单块、纯串行、只读定性、
// 自改请求都会照常派发执行单元（headless 默认，--mode window 可切弹窗）。
// 唯一仍然生效的门是维护锁：锁定期调用照旧只回固定话术并放行。
// 用法: orch [--mode headless|exec|window] [--run-id id] [--acceptance-file f] <请求...>
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
if (!args.length) {
  console.log('usage: orch [--mode headless|exec|window] [--run-id id] [--acceptance-file file] <request>');
  process.exit(2);
}
const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), '--run-windows', ...args], {
  stdio: 'inherit', windowsHide: true, env: { ...process.env, ORCH_FORCE_EXECUTE: '1' },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
