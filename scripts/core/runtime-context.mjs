import path from 'node:path';
import {realpathWithMissing,containedBy} from './path-security.mjs';

// MSYS/Git-Bash 风格路径（/d/temp/x）对原生进程是"当前盘符相对路径"，会被拼成 D:\d\temp\x。
// 统一归一为原生形式（D:/temp/x），避免下游 spawn 以无效 cwd 秒死（症状是难以定位的 ENOENT）。
// 只在 Windows 上成立：Linux/macOS 的 /d/temp/x 就是普通绝对路径，照原样返回，
// 否则会被拼成 /d/temp/x 之外的怪路径（例如 <cwd>/D:/temp/x）。
// 平台可注入（默认当前平台）：两种语义（Windows 归一 / POSIX 原样）都要能在**任何**平台上被判定，
// 否则 Windows 上就有一个"永远跳过、永远不会红"的盲区（2026-09-22：gate 的 L1 要求 skipped==0）。
export const msysToNative = (s, platform = process.platform) => {
  if (platform !== 'win32') return s;
  const m = /^\/([a-zA-Z])\//.exec(s);
  return m ? `${m[1].toUpperCase()}:/` + s.slice(3) : s;
};

function stateWithinTemp(temp, candidate) {
  const lexical = path.relative(path.resolve(temp), path.resolve(candidate));
  if (lexical === '..' || lexical.startsWith('..' + path.sep) || path.isAbsolute(lexical)) return false;
  return containedBy(realpathWithMissing(temp), realpathWithMissing(candidate));
}

// Resolve once at the caller's entry point. Never substitute the install directory
// or CODEX_HOME for the directory that initiated this run.
export function resolveRuntimeContext(env = process.env, cwd = process.cwd()) {
  const workspace = path.resolve(cwd, msysToNative(String(env.WORKSPACE_DIR || '').trim()) || '.');
  const temp = path.join(workspace, 'temp');
  return { workspace, temp, state: resolveStateDirectory(workspace, env) };
}

// Every run ledger, board, guardian and poller must resolve the same state root.
// Keep this derivation in one place so ORCH_STATE_DIR cannot affect only the
// engine while readers silently continue using workspace/temp/orchestrator.
export function resolveStateDirectory(workspace, env = process.env) {
  const base = path.resolve(workspace);
  const temp = path.join(base, 'temp');
  const override = msysToNative(String(env.ORCH_STATE_DIR || '').trim());
  return override ? resolveStateOverride(temp, override) : path.join(temp, 'orchestrator');
}

export function runDirectory(workspace, runId, stateDir) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId || '')) throw new Error('A valid --run-id is required');
  // Direct library callers own their workspace. The CLI passes the resolved
  // stateDir explicitly, so an ambient ORCH_STATE_DIR cannot redirect tests or
  // another caller's run ledger to the initiating shell's workspace.
  const workspaceRoot = path.resolve(workspace);
  const temp = path.join(workspaceRoot, 'temp');
  const root = stateDir ? path.resolve(stateDir) : path.join(temp, 'orchestrator');
  if (!stateWithinTemp(temp, root)) {
    throw new Error(`State directory must stay under the workspace temp directory: ${root}`);
  }
  return path.join(root, 'runs', String(runId));
}

function resolveStateOverride(temp, override) {
  // Runtime state is part of the initiating workspace. Relative overrides are
  // rooted at workspace/temp, while absolute overrides are accepted only when
  // they already point below that directory.
  const candidate = path.isAbsolute(override) ? path.resolve(override) : path.resolve(temp, override);
  if (!stateWithinTemp(temp, candidate)) {
    throw new Error(`ORCH_STATE_DIR must stay under the initiating workspace temp directory: ${candidate}`);
  }
  return candidate;
}
