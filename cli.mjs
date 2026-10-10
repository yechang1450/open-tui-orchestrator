#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeContext } from './scripts/runtime-context.mjs';
import { enforceWindowsOnly } from './scripts/platform-guard.mjs';
import { formatFailureLines } from './scripts/core/failure-report.mjs';

// 机器可调用失败契约（与 scripts/orchestrate-sdk.mjs 同一形状）：任何失败只回一行
// `[orchestrator] FATAL: <原因>`，完整栈帧仅 ORCH_DEBUG=1 时才打。入口自己（解析运行上下文、
// 解析工作区、拉起引擎）也属于公开面：坏 ORCH_STATE_DIR 过去会把 7 帧 Node 栈直接甩给调用方。
function fatal(error) {
  for (const line of formatFailureLines(error)) console.error(line);
  if (process.env.ORCH_DEBUG === '1' && error && error.stack) console.error(error.stack);
}
// spawn 的 cwd 必须真实存在且是目录，否则 Node 只回一句 `spawn <node.exe> ENOENT`：
// 既没指出是哪个路径错，也不符合上面的契约。
function isDirectory(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

const args = process.argv.slice(2);
// 只读版本面：纯元数据，不解析 agent CLI、不落任何状态（发行副本验收的版本痕迹检查用）。
if (args.includes('--version')) {
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));
  const core = /CORE_VERSION\s*=\s*'([^']+)'/.exec(fs.readFileSync(fileURLToPath(new URL('./scripts/core/contracts.mjs', import.meta.url)), 'utf8'))?.[1] ?? 'unknown';
  console.log(`open-tui-orchestrator ${pkg.version} (core ${core})`);
  process.exit(0);
}
// Windows-only 承诺在入口强制（见 scripts/platform-guard.mjs）：拒绝要发生在解析宿主、调用模型、落任何状态之前。
if (enforceWindowsOnly(args)) process.exit(1);
const env = { ...process.env };
for (const [flag, key] of [['--agent', 'ORCH_AGENT'], ['--cli', 'ORCH_CLI'], ['--workspace', 'WORKSPACE_DIR']]) {
  const index = args.indexOf(flag);
  if (index < 0) continue;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    console.error(`${flag} needs a value`); process.exit(2);
  }
  env[key] = args[index + 1]; args.splice(index, 2);
}
// 用法面与引导面必须先于运行上下文解析：它们是环境坏掉时唯一还能用的自救入口
// （scripts/platform-guard.mjs 的 PLATFORM_NEUTRAL_ARGS：--version / --help / --install-deps
// 正是排障所需）。坏 ORCH_STATE_DIR 不该连 --help 和 --install-deps 都吃掉。
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log('open-tui-orchestrator --agent codex|pi|opencode|kimi|hermes [--cli executable-or-supported-entry] [--workspace directory] [--acceptance file] [--mode headless|exec|window] --install-deps|--doctor|--plan request|--tasks request|--run-windows request|--resume-run id|--verify-run id|--spawn title prompt|--status|--watch id|--version\nInstall: npm i -g open-tui-orchestrator && open-tui-orchestrator --install-deps (fetches the locked SDK dependencies; see INSTALL.md).\nCaller-driven channel (any agent): --plan-file <plan.json> (caller-supplied ledger/blocks; zero LLM) and --unit-cmd/--unit-cmd-file <unit.json> (your own unit command template; no adapter needed). --tasks <request> prints the authoritative T001... ledger so any caller can align ids before writing a plan file. See docs/caller-driven.md.\nHost identity comes from --agent/ORCH_AGENT, then host env markers, then the initiating process chain; an explicit unit command overrides host resolution entirely. Fresh --run-windows opens TUI windows only for a genuinely parallel wave; single-block and dependency-only serial plans return an inline task inventory, and an explicit --plan-file skips the read-only classification model call. Spawn mode defaults to headless (hidden carrier); --mode window keeps the visible Windows Terminal popups. Missing or unsupported CLIs fail without fallback.');
} else if (args.includes('--install-deps')) {
  // 引导入口同样先于一切可失败的东西：依赖没装/环境坏掉时它必须可达（scripts/install-deps.mjs
  // 的硬约束「不能依赖引擎」——实现只有一份，引擎侧的 bootstrap 走同一份）。
  const { installDepsCli } = await import('./scripts/install-deps.mjs');
  process.exitCode = installDepsCli();
} else {
  let context;
  try {
    context = resolveRuntimeContext(env);
  } catch (error) {
    fatal(error);
    process.exit(1);
  }
  env.WORKSPACE_DIR = context.workspace;
  env.ORCH_STATE_DIR = context.state;
  if (!isDirectory(context.workspace)) {
    fatal(new Error(`Workspace is not a directory: ${context.workspace} (pass --workspace <directory>, or run from the workspace you meant)`));
    process.exit(1);
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./scripts/orchestrate-sdk.mjs', import.meta.url)), ...args], {
    cwd: context.workspace, env, stdio: 'inherit', windowsHide: true,
  });
  // 启动失败（典型：--workspace 指向不存在的目录 ⇒ cwd 无效 ⇒ ENOENT）也必须走同一失败契约：
  // 旧行为只打一行 'spawn C:\Program Files\nodejs\node.exe ENOENT'——没有 FATAL 前缀，也没有
  // failure-report 里本就写好的 cause/tried/fix 出路（那条 ENOENT 规则正是为这种场景写的）。
  child.on('error', error => { fatal(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
