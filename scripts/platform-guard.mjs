#!/usr/bin/env node
/**
 * platform-guard.mjs — enforces the front-page promise "Windows-only today".
 *
 * The promise is worth nothing if it is only a sentence in the README, and it is *worse* than
 * nothing if a non-Windows user gets a half-working install: measured 2026-09-15, an entry with
 * no guard reported a healthy `--doctor` (exit 0, `terminal: "wt"`) on a simulated Linux platform.
 *
 * So the refusal happens **at the entry** (cli.mjs / orch.mjs / the SDK wrapper), before host
 * resolution, before any model call, before any state. Three entries stay available because they
 * are platform-neutral and are exactly what somebody debugging a platform issue needs:
 * `--version`, `--help`, `--install-deps`.
 *
 * Callers: `if (enforceWindowsOnly(args)) process.exit(1);`
 */
export const PLATFORM_NEUTRAL_ARGS = new Set(['--version', '--help', '-h', '--install-deps']);

export function enforceWindowsOnly(argv = process.argv.slice(2), platform = process.platform) {
  if (platform === 'win32') return false;
  // 豁免必须是「整个调用就是中立面」：任意位置混入 --help 不能把一条真实命令洗白成排障调用。
  // 空调用也不是中立面（要明确要求 --help/-h/--version/--install-deps）。
  if (argv.length > 0 && argv.every((arg) => PLATFORM_NEUTRAL_ARGS.has(arg))) return false;
  console.error('[orchestrator] FATAL: Windows-only: this build drives Windows Terminal, the ConPTY carrier and the HKCU coordinator; detected platform "' + platform + '" — only --version, --help/-h and --install-deps are available here');
  return true;
}
