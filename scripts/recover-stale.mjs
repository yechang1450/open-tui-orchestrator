#!/usr/bin/env node
// 开机恢复扫描入口（断电恢复 P0 的可用件）：
//   node scripts/recover-stale.mjs --workspace <dir>            # 默认只报告
//   node scripts/recover-stale.mjs --workspace <dir> --resume   # 对每个 stale run 依次跑同一条 --resume-run
//   node scripts/recover-stale.mjs --workspace <dir> --json     # 机读输出
// 建议：作为「登录时」计划任务运行（真断电后开机自动收敛），详见 docs/execution-contract.md 的断电姿态一节。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {scanStaleRuns} from './core/reboot-recovery.mjs';

const args = process.argv.slice(2);
const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const workspace = value('--workspace') || process.cwd();
const asJson = args.includes('--json');
const resume = args.includes('--resume');

if (!fs.existsSync(workspace)) {
  console.error('[recover-stale] workspace not found: ' + workspace);
  process.exit(2);
}
const stale = scanStaleRuns(workspace);
if (asJson) console.log(JSON.stringify({workspace, checkedAt: Date.now(), stale}, null, 2));
else if (!stale.length) console.log('[recover-stale] no interrupted runs from a previous boot');
else {
  console.log('[recover-stale] interrupted runs from a previous boot: ' + stale.length);
  for (const s of stale) {
    console.log(`  - ${s.runId} [${s.status}]` + (s.blocks ? ' blocks=' + s.blocks.map(b => b.key + ':' + b.status).join(',') : '') + (s.note ? ' note=' + s.note : ''));
    if (s.resumeCommand) console.log('    resume: ' + s.resumeCommand);
  }
}
if (!resume) process.exit(0);
const resumable = stale.filter(s => s.status === 'stale-after-reboot' && s.resumeCommand);
if (!resumable.length) { console.log('[recover-stale] nothing resumable (only manual review items)'); process.exit(0); }
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
let failed = 0;
for (const s of resumable) {
  console.log(`[recover-stale] resuming ${s.runId} ...`);
  const result = spawnSync(process.execPath, [cli, '--agent', s.agent, '--mode', s.spawnMode, '--workspace', s.workspace, '--resume-run', s.runId],
    {stdio: 'inherit', windowsHide: true, timeout: 6 * 3600 * 1000});
  if (result.status !== 0) { failed++; console.error(`[recover-stale] ${s.runId} resume exited ${result.status}`); }
  // 恢复本身可再断电：失败就留给下一次扫描，不做花式补救（幂等 + 验收兜底）。
}
process.exit(failed ? 1 : 0);
