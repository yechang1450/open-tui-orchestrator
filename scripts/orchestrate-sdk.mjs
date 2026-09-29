#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyRelease} from './release-integrity.mjs';
import {formatFailureLines} from './core/failure-report.mjs';
import {enforceWindowsOnly} from './platform-guard.mjs';

// 机器可调用契约：**作为主入口时，任何失败只回一行** `[orchestrator] FATAL: <原因>`
// （完整栈帧仅 ORCH_DEBUG=1 时才打）——调用方的管道里永远不该出现裸 Node 栈帧。
// 作为模块被 import 时保持原语义：封印/自适配失败照旧抛出（fail-closed 不受影响），
// 只是不再把栈帧甩到调用者脸上。
const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
function fatal(error) {
  // 首行仍是机器判据 `[orchestrator] FATAL: <原因>`；其后是给人看的 cause/tried/fix/docs。
  for (const line of formatFailureLines(error)) console.error(line);
  if (process.env.ORCH_DEBUG === '1' && error && error.stack) console.error(error.stack);
}
// 引导入口（--install-deps）必须先于一切依赖存在：本包自己的 SDK 依赖（node-pty / codex-sdk）正是
// 它要装的东西，而引擎在 ORCH_AGENT=codex 时会顶层 import SDK——先要求「依赖已装/引擎可加载」
// 会让缺依赖的用户永远够不着这个入口（2026-09-14 真机回归抓到的鸡生蛋问题）。
const bootstrapInstallDeps = IS_MAIN && process.argv.slice(2).includes('--install-deps');
// Windows-only 是首页承诺，就要在入口强制（共享实现见 scripts/platform-guard.mjs；cli.mjs / orch.mjs
// 也在入口调用同一份）。这里覆盖直接跑 scripts/orchestrate-sdk.mjs 的调用方。
if (IS_MAIN && enforceWindowsOnly(process.argv.slice(2))) process.exit(1);
try {
  if (!bootstrapInstallDeps) {
    verifyRelease();
    // 自动适配钩子（显式开关）：检测到未适配的 agent 且仓库未上锁时，先自动完成适配
    // （探测→画像→活验→重封→提交）再继续本轮调用；适配失败则 fail-closed 报错退出。
    // 注意：adapt 会写入 scripts/core/agent-profiles/<id>.json 并重封提交——这是显式要求
    // 的自修改通道，只有 ORCH_AUTO_ADAPT=1 时才启用。
    if (process.env.ORCH_AUTO_ADAPT === '1') {
      const { autoAdaptIfNeeded } = await import('./core/adapt-lib.mjs');
      await autoAdaptIfNeeded();
    }
    const requestedAgent = String(process.env.ORCH_AGENT || '').trim().toLowerCase();
    if (requestedAgent === 'codex' || (!requestedAgent && (process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID))) await import('./sdk-dependency-check.mjs');
  }
} catch (error) {
  if (IS_MAIN) { fatal(error); process.exit(1); }
  throw error;
}
// 引导路径不进引擎：缺依赖时引擎根本加载不起来。装完依赖后，再走正常入口。
const engine = bootstrapInstallDeps ? null : await import('./core/orchestrate-sdk.mjs');
export const {
  main, reportFatal, buildPsArrayLit, capPlanBlocks, buildWindowWaves, applyAuthPromptPolicy, readTail,
  classifyBlockComplexity, classifyExecutionMode, appendModelEffortArgs, genericProjectSplit, plannerPrompt, plannerBlockCeiling,
  trySingleBlock, conflictByKeys, loadCachedDecompose, buildBlocksFromTasks, resolveHints,
  extractTasks, classifyPrompt, buildBlockPrompt, levelWaves, decomposeHash, checkDiskSpace,
  readPidFile, pidAliveCheck, closeWindowByPid, windowGenuinelyPopped, windowVerdictOk, leftoverWindowHandles, runWindowEntries, inlineEnvJson, extractResult, extractUsage,
  readReportFromResult, sessionDir, writeInteractiveLauncher, staleTransientFiles,
  pidFileOfTransient, tryReserveWindow, commitReservation, cancelReservation, computeMaxWindows,
  blockKeys, keysOverlap, scanTaskComplete, windowExecutionPolicy, __setOrchHooks, isOrchestratorSelfMod, resolveCodexHome,
  withRegistryLock, REGISTRY_LOCK_FILE,
} = engine ?? {};
if (bootstrapInstallDeps) {
  const { installDepsCli } = await import('./install-deps.mjs');
  process.exitCode = installDepsCli();
} else if (IS_MAIN) {
  // 异常收口：引擎抛异常时，除了按契约打一行 FATAL，还必须收掉本 run 自己录下的残留窗口。
  // 否则一次异常退出就会留下孤儿单元进程 + 尸体窗，违背"不留残窗/不让人手动关窗"的承诺
  // （2026-09-28 现场实测：--mode window 下 guardian 提前退出 + 引擎异常 ⇒ 残窗与孤儿都留下）。
  // 收口复用既有判据（只关本 run 句柄、属 WindowsTerminal、无活进程引用该 stem），此处不新增判据。
  engine.main().catch(async (e) => {
    fatal(e);
    process.exitCode = 1;
    try {
      const { sweep } = engine.__residualCleanup || {};
      if (typeof sweep === 'function') await sweep();
    } catch { /* cleanup must never mask the original failure */ }
  });
}
