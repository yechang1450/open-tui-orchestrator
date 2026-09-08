#!/usr/bin/env node
import {verifyRelease} from './release-integrity.mjs';
verifyRelease();
const engine = await import('./core/poll-windows.mjs');
export const {TERMINAL, SUCCESS, summaryComplete, summaryTerminal, failures, loadSummary, parsePollingOptions, main} = engine;
import path from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase())engine.main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
