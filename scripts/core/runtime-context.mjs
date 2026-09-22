import path from 'node:path';

// MSYS/Git-Bash 风格路径（/d/temp/x）对原生进程是"当前盘符相对路径"，会被拼成 D:\d\temp\x。
// 统一归一为原生形式（D:/temp/x），避免下游 spawn 以无效 cwd 秒死（症状是难以定位的 ENOENT）。
// 只在 Windows 上成立：Linux/macOS 的 /d/temp/x 就是普通绝对路径，照原样返回，
// 否则会被拼成 /d/temp/x 之外的怪路径（例如 <cwd>/D:/temp/x）。
const msysToNative = (s) => {
  if (process.platform !== 'win32') return s;
  const m = /^\/([a-zA-Z])\//.exec(s);
  return m ? `${m[1].toUpperCase()}:/` + s.slice(3) : s;
};

// Resolve once at the caller's entry point. Never substitute the install directory
// or CODEX_HOME for the directory that initiated this run.
export function resolveRuntimeContext(env = process.env, cwd = process.cwd()) {
  const workspace = path.resolve(cwd, msysToNative(String(env.WORKSPACE_DIR || '').trim()) || '.');
  const temp = path.join(workspace, 'temp');
  const override = msysToNative(String(env.ORCH_STATE_DIR || '').trim());
  const state = override ? resolveStateOverride(temp, override) : path.join(temp, 'orchestrator');
  return { workspace, temp, state };
}

function resolveStateOverride(temp, override) {
  // Runtime state is part of the initiating workspace. Relative overrides are
  // rooted at workspace/temp, while absolute overrides are accepted only when
  // they already point below that directory.
  const candidate = path.isAbsolute(override) ? path.resolve(override) : path.resolve(temp, override);
  const relative = path.relative(temp, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`ORCH_STATE_DIR must stay under the initiating workspace temp directory: ${candidate}`);
  }
  return candidate;
}
