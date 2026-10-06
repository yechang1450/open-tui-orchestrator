#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import {verifyRelease} from './release-integrity.mjs';
import {formatFailureLines} from './core/failure-report.mjs';
// junction/符号链接入口下两侧路径形态不同，纯词法比较会把主入口误判为 import。
const IS_MAIN = (() => {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const entry = process.argv[1] ? realpathSync(path.resolve(process.argv[1])) : '';
    return !!entry && (process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self);
  } catch { return false; }
})();
function fatal(error) {
  for (const line of formatFailureLines(error)) console.error(line);
  if (process.env.ORCH_DEBUG === '1' && error && error.stack) console.error(error.stack);
}
let releaseError = null;
try { verifyRelease(); } catch (error) { releaseError = error; }
if (releaseError && !IS_MAIN) throw releaseError;
if (releaseError) {
  fatal(releaseError);
  process.exitCode = 1;
}
const engine = releaseError ? {} : await import('./core/poll-windows.mjs');
export const {TERMINAL, SUCCESS, summaryComplete, summaryTerminal, failures, loadSummary, parsePollingOptions, main} = engine;
if (!releaseError && IS_MAIN) engine.main().catch(e=>{fatal(e);process.exitCode=1;});
