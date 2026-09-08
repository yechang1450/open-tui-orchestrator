#!/usr/bin/env node
import {verifyRelease} from './release-integrity.mjs';
verifyRelease();
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
} = engine;
import path from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase())engine.main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
