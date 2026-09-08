import {spawnSync} from 'node:child_process';

// codex CLI 在 PATH 上的探测（回归环境约定：Windows 下前置 codex vendor bin，见 README 测试环境说明）。
// Windows 上 codex 是 .cmd shim，需要 shell 解析；非 Windows 直接探测。
export function codexCliOnPath() {
  try {
    const r = spawnSync('codex', ['--version'], {encoding: 'utf8', shell: process.platform === 'win32', timeout: 20000, windowsHide: true});
    return r.status === 0;
  } catch { return false; }
}

export const CODEX_CLI_SKIP = codexCliOnPath() ? false : 'codex CLI not on PATH (prepend the codex vendor bin; see README test-env note)';