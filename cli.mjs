#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeContext } from './scripts/runtime-context.mjs';
const args = process.argv.slice(2);
const env = { ...process.env };
for (const [flag, key] of [['--agent', 'ORCH_AGENT'], ['--cli', 'ORCH_CLI'], ['--workspace', 'WORKSPACE_DIR']]) {
  const index = args.indexOf(flag);
  if (index < 0) continue;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    console.error(`${flag} needs a value`); process.exit(2);
  }
  env[key] = args[index + 1]; args.splice(index, 2);
}
const context = resolveRuntimeContext(env);
env.WORKSPACE_DIR = context.workspace;
env.ORCH_STATE_DIR = context.state;
if (!args.length || args.includes('--help')) {
  console.log('open-tui-orchestrator --agent codex|pi|openclaw [--cli executable-or-supported-entry] [--workspace directory] --doctor|--plan request|--run-windows request|--resume-run id|--verify-run id|--spawn title prompt|--status\nHost identity is required. Fresh --run-windows opens TUI windows only for a genuinely parallel wave; single-block and dependency-only serial plans return an inline task inventory. OpenClaw support is pinned to 2026.9.2. Missing or unsupported CLIs fail without fallback.');
} else {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./scripts/orchestrate-sdk.mjs', import.meta.url)), ...args], {
    cwd: context.workspace, env, stdio: 'inherit', windowsHide: true,
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
