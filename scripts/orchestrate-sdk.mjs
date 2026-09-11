#!/usr/bin/env node
import {verifyRelease} from './release-integrity.mjs';
verifyRelease();
// 自动适配钩子（显式开关）：检测到未适配的 agent 且仓库未上锁时，先自动完成适配
// （探测→画像→活验→重封→提交）再继续本轮调用；适配失败则 fail-closed 报错退出。
// 注意：adapt 会写入 scripts/core/agent-profiles/<id>.json 并重封提交——这是显式要求
// 的自修改通道，只有 ORCH_AUTO_ADAPT=1 时才启用。
if (process.env.ORCH_AUTO_ADAPT === '1') {
  const { autoAdaptIfNeeded } = await import('./core/adapt-lib.mjs');
  await autoAdaptIfNeeded();
}
const requestedAgent=String(process.env.ORCH_AGENT||'').trim().toLowerCase();
if(requestedAgent==='codex'||(!requestedAgent&&(process.env.CODEX_SESSION_ID||process.env.CODEX_THREAD_ID)))await import('./sdk-dependency-check.mjs');
const engine = await import('./core/orchestrate-sdk.mjs');
export const {
  main, buildPsArrayLit, capPlanBlocks, buildWindowWaves, applyAuthPromptPolicy, readTail,
  classifyBlockComplexity, classifyExecutionMode, appendModelEffortArgs, genericProjectSplit,
  trySingleBlock, conflictByKeys, loadCachedDecompose, buildBlocksFromTasks, resolveHints,
  extractTasks, classifyPrompt, buildBlockPrompt, levelWaves, decomposeHash, checkDiskSpace,
  readPidFile, pidAliveCheck, closeWindowByPid, windowGenuinelyPopped, extractResult, extractUsage,
  readReportFromResult, sessionDir, writeInteractiveLauncher, staleTransientFiles,
  pidFileOfTransient, tryReserveWindow, commitReservation, cancelReservation, computeMaxWindows,
  blockKeys, keysOverlap, scanTaskComplete, windowExecutionPolicy, __setOrchHooks, isOrchestratorSelfMod, resolveCodexHome,
  withRegistryLock, REGISTRY_LOCK_FILE,
} = engine;
import path from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase())engine.main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
