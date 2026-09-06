#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
if (!args.length || args.includes('--help')) {
  console.log('open-tui-orchestrator [--agent codex] [--cli native-executable] [--workspace directory] --doctor|--plan request|--run-windows request|--spawn title prompt|--status\nHost identity is required. Missing or unsupported CLIs fail without fallback.');
} else {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./scripts/orchestrate-sdk.mjs', import.meta.url)), ...args], {
    env, stdio: 'inherit', windowsHide: true,
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
