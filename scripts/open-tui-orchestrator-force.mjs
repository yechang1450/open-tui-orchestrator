#!/usr/bin/env node
/**
 * open-tui-orchestrator-force — technical enforcement gate for open-tui-orchestrator.
 *
 * The ONLY sanctioned path for REAL execution (write / build / install / test / restart / any
 * command that changes state) is a real, visible agent TUI window launched by
 * `--run-windows`. This guard makes that a *checkable invariant*:
 *
 *   - `--enable`  : arm enforcement (write the marker). Once armed, real-execution kinds are
 *                   refused from any NON-window context.
 *   - `--disable` : disarm.
 *   - `--status`  : report armed state + currently alive execution windows.
 *   - `--assert <kind>` : returns 0 (ok) / 1 (refused). A sanctioned window sets
 *                   $env:ORCH_WINDOW=1 (its launcher does), so it passes. A non-window
 *                   context that tries a real-execution kind gets refused with a route hint.
 *   - `--verify <file>` : best-effort check whether a changed file was written inside a live
 *                   sanctioned window. Reliably PASS (in a window), reliably VIOLATION (no live
 *                   window / not in a window), or INDETERMINATE (live window exists but this is
 *                   not that context) — never fabricates a verdict it cannot support.
 *
 * A window is counted as ALIVE only if it is registered in `orchestrator-windows.json` AND its
 * pid file still exists AND `process.kill(pid, 0)` (in try/catch) confirms the process is really
 * running. A record whose pid file exists but whose process has already exited is treated as NOT
 * alive and dropped from results — the old "pid file exists == alive" check is gone.
 *
 * Combined with the hard gate on headless `--run`/`--exec` inside orchestrate-sdk.mjs
 * (ORCH_ALLOW_HEADLESS must be `1`, verboten for real work), this is the "once the skill is
 * enabled, real executions must go through the TUI window" enforcement.
 *
 * Usage (from scripts dir):  node open-tui-orchestrator-force.mjs --status | --assert <kind> | --verify <file> | --enable | --disable
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, lstatSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { powershellExe, systemToolExe } from "./core/contracts.mjs";
import { launcherIdentity, processSnapshot, sameProcess } from "./core/leases.mjs";

// 锚定 SystemRoot：裸名会先按进程 cwd（任意工作区）解析，防二进制投毒。
const PS_EXE = powershellExe();
const TASKLIST_EXE = systemToolExe("tasklist.exe");

import { resolveRuntimeContext } from './runtime-context.mjs';
import { lockedForMaintenance, readMaintenanceLock, MAINTENANCE_MESSAGE } from './core/maintenance-lock.mjs';
const { workspace: WORKSPACE, temp: TMP, state: STATE_DIR } = resolveRuntimeContext();
const FLAG = path.join(STATE_DIR, ".orchestrator-enabled");
const WINDOWS_REG = path.join(STATE_DIR, "orchestrator-windows.json");

// 拒绝符号链接/非常规文件，防止伪造/篡改 registry 或 marker（安全网）。
function isRegularFile(p) { try { return lstatSync(p).isFile(); } catch { return false; } }
function armed() {
  if (!existsSync(FLAG) || !isRegularFile(FLAG)) return false;
  try { return /^\d+$/.test(readFileSync(FLAG, "utf8").trim()); } catch { return false; }
}
function loadJson(f, d) {
  try {
    if (!existsSync(f)) return d;
    if (!isRegularFile(f)) { console.error("[force] refusing non-regular/symlinked registry: " + f); return d; }
    return JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    console.error("[force] registry read/parse failed: " + f + " :: " + e.message);
    return d;
  }
}

// Read the PID stored in a window's pid file. Returns 0 if the record has no pidFile, the pidFile
// is unreadable, or the stored value is not a positive integer.
function pidOf(w) {
  try {
    if (!w || !w.pidFile) return 0;
    if (!isRegularFile(w.pidFile)) return 0; // 拒绝符号链接 pidFile
    const p = Number(String(readFileSync(w.pidFile, "utf8")).trim());
    return Number.isFinite(p) && p >= 1 && p <= 4194304 ? p : 0; // 合理 PID 范围
  } catch { return 0; }
}
// process.kill(pid, 0) inside try/catch: true only if the process is actually alive (ESRCH/throw = dead).
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  if (process.platform === "win32") {
    // 防伪造：仅识别“编排器工作窗”的真实进程，而非任意 powershell/codex 像。
    try {
      const r = spawnSync(TASKLIST_EXE, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
      const out = String(r.stdout || "");
      if (!/"\S+","\d+"/.test(out)) return false; // 该 PID 无对应行
      const img = String(out.split(/\r?\n/)[0] || "").split(",")[0].replace(/"/g, "");
      const codexish = /codex|powershell|pwsh/i.test(img);
      if (!codexish) return false;
      // 命令行动态核对：编排器工作窗的 launcher 命令行是 `powershell -File ...\win-launch-*.ps1`
      // （其 agent 子进程命令行不含编排器字样），故需命中 win-launch-*.ps1；同时保留 orchestrate-sdk.mjs / --run-windows 以兼容旧判定。
      // 其它任意 powershell/codex 一律视作伪造，不得过门禁（fail-closed）。
      // pid 已在 pidOf() 校验为 1..4194304 的合法整数，直接内联进 -Filter 安全；用 `$args[0]` 传参会
      // 触发 PowerShell 的 -Command 解析异常（UnexpectedToken），导致 CommandLine 查询返回空，故改为内联。
      const ps = spawnSync(PS_EXE, ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`], { encoding: "utf8", windowsHide: true });
      const cl = String(ps.stdout || "");
      return /win-launch-.*\.ps1/i.test(cl) || /orchestrate-sdk\.mjs/i.test(cl) || /--run-windows/i.test(cl);
    } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch (e) { return e && (e.code === "EPERM" || e.code === "EACCES") ? true : false; } // EPERM/EACCES = 存在但无权限, 不视为 dead
}
// The registry is cooperative state, not proof by itself. A live record must carry the
// identity captured from the exact launcher path, and that identity must still match the
// current process snapshot (including its creation time via sameProcess()).
function processParentMap() {
  if (process.platform !== "win32") return null;
  const rawTimeout = Number(process.env.ORCH_PS_TIMEOUT_MS);
  const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(120000, Math.ceil(rawTimeout)) : 15000;
  try {
    const result = spawnSync(PS_EXE, ["-NoProfile", "-Command", "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true, timeout });
    if (result.status !== 0) return null;
    const parsed = JSON.parse(String(result.stdout || "null"));
    const rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    const parents = new Map();
    for (const row of rows) {
      const pid = Number(row?.ProcessId);
      const parent = Number(row?.ParentProcessId);
      if (Number.isInteger(pid) && pid > 0 && Number.isInteger(parent) && parent >= 0) parents.set(pid, parent);
    }
    return parents;
  } catch {
    return null;
  }
}

function exactLauncherIdentity(w, snapshot) {
  if (!w?.pidFile || !w?.identity || !isRegularFile(w.pidFile)) return null;
  const pid = pidOf(w);
  if (!pid || Number(w.identity.ProcessId) !== pid) return null;
  const actual = snapshot?.get(pid);
  if (!actual || !sameProcess(w.identity, actual)) return null;
  try {
    const identified = launcherIdentity(pid, w.pidFile, snapshot);
    return identified && sameProcess(w.identity, identified) ? identified : null;
  } catch {
    return null;
  }
}

function isCurrentProcessDescendantOf(expected, snapshot, parents) {
  if (!expected || !(snapshot instanceof Map) || !(parents instanceof Map)) return false;
  let pid = Number(process.pid);
  const seen = new Set();
  while (Number.isInteger(pid) && pid > 0 && !seen.has(pid)) {
    seen.add(pid);
    const actual = snapshot.get(pid);
    if (!actual) return false; // unknown identity is never evidence
    if (sameProcess(expected, actual)) return true;
    const parent = parents.get(pid);
    if (!Number.isInteger(parent) || parent <= 0 || parent === pid) return false;
    pid = parent;
  }
  return false;
}

// Only windows with a committed, exact launcher identity are live. A pid file,
// command-line marker, or Start-Sleep process is not a window proof.
function liveWindows() {
  const reg = loadJson(WINDOWS_REG, []);
  if (!Array.isArray(reg)) { console.error("[force] refusing: orchestrator-windows.json is not an array (fail-closed)."); return []; }
  let snapshot;
  try { snapshot = processSnapshot(); } catch { return []; }
  return reg.filter((w) => Boolean(exactLauncherIdentity(w, snapshot)));
}

function sanctionedWindow(wins = liveWindows(), env = process.env, deps = {}) {
  if (String(env?.ORCH_WINDOW || "") !== "1") return null;
  const token = String(env?.ORCH_WINDOW_TOKEN || "");
  if (!token) return null;
  const candidates = (Array.isArray(wins) ? wins : []).filter((w) => String(w?.sanctionToken || "") === token);
  if (candidates.length !== 1) return null;
  let snapshot;
  try { snapshot = (deps.snapshot || processSnapshot)(); } catch { return null; }
  if (!(snapshot instanceof Map)) return null;
  let parents;
  try { parents = deps.parentMap === undefined ? processParentMap() : deps.parentMap; } catch { return null; }
  if (!(parents instanceof Map)) return null;
  return candidates.find((w) => {
    const identity = exactLauncherIdentity(w, snapshot);
    return identity && isCurrentProcessDescendantOf(identity, snapshot, parents);
  }) || null;
}

const mode = process.argv[2];

function runCli() {
  // 维护锁：上锁期间 --assert/--verify 一律放行并回固定话术（本轮跳过 orchestrator 直接执行）；
  // --status 显示锁状态后继续正常输出；--enable/--disable 属维护操作，不受影响。
  if (lockedForMaintenance()) {
    if (mode === "--assert" || mode === "--verify") {
      console.log(MAINTENANCE_MESSAGE);
      process.exit(0);
    }
    if (mode === "--status") {
      const mlock = readMaintenanceLock();
      console.log("maintenance lock: LOCKED" + (mlock.reason ? " (" + mlock.reason + ")" : "") + (mlock.expiresAt ? ", expires " + new Date(mlock.expiresAt).toISOString() : "") + " - " + MAINTENANCE_MESSAGE);
    }
  }
  if (mode === "--enable") {
    mkdirSync(STATE_DIR, { recursive: true });
    // 小标记直接用 writeFileSync 覆盖写，避免 tmp+rename→rm→rename 间隙内标记缺失的竞态。
    writeFileSync(FLAG, String(Date.now()), "utf8");
    console.log("enforcement ARMED: real executions must go through --run-windows (visible agent TUI).");
  } else if (mode === "--disable") {
    try { rmSync(FLAG, { force: true }); } catch { /* ignore */ }
    console.log("enforcement disarmed.");
  } else if (mode === "--status") {
    const wins = liveWindows();
    console.log("enforcement: " + (armed() ? "ARMED" : "disarmed"));
    console.log("alive execution windows: " + wins.length);
    for (const w of wins) console.log("  [" + w.title + "]");
  } else if (mode === "--assert") {
    const kind = String(process.argv[3] || "exec").toLowerCase();
    const realKinds = new Set(["exec", "write", "build", "install", "test", "restart", "start", "stop", "real", "all", "run"]);
    const readKinds = new Set(["read", "analyze", "plan", "view", "query", "search", "status", "list", "preview", "ls", "show", "check", "validate", "dry-run", "help"]);
    if (!armed()) { console.log("ok: orchestrator not armed."); process.exit(0); }
    if (process.env.ORCH_WINDOW === "1") {
      const wins = liveWindows();
      const current = sanctionedWindow(wins);
      if (current) {
        console.log("ok: sanctioned orchestration window [" + (current.title || "?") + "].");
        process.exit(0);
      }
      console.log(
        "REFUSED: ORCH_WINDOW=1 but no live registered orchestration window matches ORCH_WINDOW_TOKEN (the env var alone is not accepted; it may be forged). " +
          "Route through  node orchestrate-sdk.mjs --run-windows \"<request>\"  (a real, visible agent TUI window)."
      );
      process.exit(1);
    }
    if (realKinds.has(kind)) {
      console.log(
        "REFUSED: real execution ('" + kind + "') from a NON-orchestrator context. " +
          "Route it through  node orchestrate-sdk.mjs --run-windows \"<request>\"  (a real, visible agent TUI window)."
      );
      process.exit(1);
    }
    // Unknown kind = fail-closed by default (a typo / future real kind must NOT silently pass).
    if (!readKinds.has(kind)) {
      console.log(
        "REFUSED: unknown execution kind ('" + kind + "'); refusing by default (fail-closed). " +
          "'read/analyze/plan/view/query/search/status/list/preview/ls/show/check/validate/dry-run/help' are read-only kinds."
      );
      process.exit(1);
    }
    console.log("ok: read-only kind.");
  } else if (mode === "--verify") {
    const file = process.argv[3];
    if (!file) { console.log("Usage: open-tui-orchestrator-force.mjs --verify <file>"); process.exit(2); }
    if (!armed()) { console.log("verify: orchestrator not armed; in-window verification not applicable."); process.exit(0); }
    if (!existsSync(file)) { console.log("verify: file not found: " + file); process.exit(2); }
    // 归因精化：不再「任一活窗+文件在工作区内=放行」，而是按 conflictKeys 确定归因——
    //   仅 1 个活窗且其 conflictKeys 命中该文件 → PASS；
    //   多个活窗 → INDETERMINATE（无法唯一归因到某个窗）；
    //   无活窗 / 无命中 → VIOLATION（不能确认是窗内受权写入）。
    let realFile, ws;
    try {
      realFile = realpathSync(file);
      ws = realpathSync(WORKSPACE);
    } catch (e) {
      // fail-closed：路径解析失败无法确认归属，不得放行。
      console.log("VIOLATION: could not resolve the file/workspace path for in-window attribution (" + (e && e.message ? e.message : "unknown") + ").");
      process.exit(1);
    }
    if (realFile !== ws && !realFile.startsWith(ws + path.sep)) {
      console.log("VIOLATION: file is outside the orchestration workspace (" + WORKSPACE + "); cannot attribute to a sanctioned in-window write.");
      process.exit(1);
    }
    const wins = liveWindows();
    const lower = realFile.toLowerCase().replace(/\\/g, "/");
    // 键匹配分级：路径键（含分隔符）能把命中唯一归因到该文件（strong）；裸文件名/裸段键可命中
    // 任意目录的同名对象（weak）——weak 命中不足以支撑 PASS（证据不支持），只能记 INDETERMINATE。
    const matchLevel = (kk) => {
      let raw = String(kk).trim().replace(/^__\s*/, "");
      if (!raw) return false;
      // 去掉 SDK 归约键的资源前缀（file:/dir:/port:/service:），再做路径感知匹配，不做裸子串匹配。
      raw = raw.replace(/^(file|dir|port|service):/i, "").trim();
      if (!raw) return false;
      const norm = raw.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
      if (!norm) return false;
      if (norm === lower) return "strong";
      if (lower.startsWith(norm + "/")) return "strong";
      if (norm === lower.split("/").pop()) return "weak";
      if (!norm.includes("/") && lower.includes("/" + norm + "/")) return "weak";
      return false;
    };
    const keysOf = (w) => {
      const rawKeys = Array.isArray(w.keys) ? w.keys.map(String) : [];
      return rawKeys.length ? rawKeys : ["__" + (w.title || "block")];
    };
    if (wins.length === 0) {
      console.log("VIOLATION: no live registered orchestration window exists; this change cannot be confirmed as an in-window write. Verify/re-run inside a window (node orchestrate-sdk.mjs --run-windows \"<request>\").");
      process.exit(1);
    }
    // A conflict key describes a task, not authorship. Only the current process's
    // proven launcher ancestor can turn a strong path match into PASS. A caller
    // outside the window must remain INDETERMINATE rather than becoming a false green.
    const current = sanctionedWindow(wins);
    if (!current) {
      console.log("INDETERMINATE: live orchestration window(s) exist, but this process is not a verified descendant of the matching launcher; conflictKeys alone cannot prove file authorship.");
      process.exit(2);
    }
    const levels = keysOf(current).map(matchLevel);
    if (levels.includes("strong")) {
      console.log("PASS: change attributed to live sanctioned orchestration window [" + (current.title || "?") + "] (verified launcher ancestry + conflictKeys hit).");
      process.exit(0);
    }
    if (levels.includes("weak")) {
      console.log(
        "INDETERMINATE: the current sanctioned window carries only a non-path conflictKey that can match same-named objects in other directories; " +
          "the evidence does not support attribution. Confirm the write location or use a path-scoped conflictKey (e.g. dir:<sub/path>)."
      );
      process.exit(2);
    }
    console.log("VIOLATION: the current sanctioned orchestration window [" + (current.title || "?") + "] does not cover this file's conflictKeys; cannot attribute to a sanctioned in-window write.");
    process.exit(1);
  } else {
    console.log("Usage: open-tui-orchestrator-force.mjs --enable | --disable | --status | --assert <kind> | --verify <file>");
  }
}

// Only run the CLI when this module is the main entrypoint, so open-tui-orchestrator-preflight.mjs can reuse armed()/liveWindows().
// junction/符号链接入口下两侧路径形态不同，纯词法比较会把主入口误判为 import（CLI 静默不执行）。
let entryIdentityError = null;
const isMain = (() => {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const entry = process.argv[1] ? realpathSync(path.resolve(process.argv[1])) : '';
    return !!entry && (process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self);
  } catch (error) { entryIdentityError = error; return false; }
})();
if (entryIdentityError) {
  console.error('[orchestrator] FATAL: ENTRY_IDENTITY_UNAVAILABLE: ' + (entryIdentityError?.message || String(entryIdentityError)));
  process.exit(1);
}
if (isMain) runCli();

export { armed, liveWindows, sanctionedWindow, pidAlive, pidOf, WINDOWS_REG, TMP, FLAG, STATE_DIR };
