#!/usr/bin/env node
// adapt — open-tui-orchestrator 的 print-class 自动适配入口。
// 探测被调用的 agent CLI（或 --agent 指定）表面 → 生成画像（scripts/core/agent-profiles/<id>.json）
// → 解析自检 → 活体验证（真实调用取回探活令牌）→ 重封 → 自动提交。
// 任何一步失败都回滚画像，仓库保持原状；维护锁持有期间拒绝写入（--force 例外）。
//
//   node adapt.mjs [--agent <id>] [--cli <path>] [--profiles-dir <dir>]
//                  [--no-live] [--no-commit] [--suite] [--smoke] [--force] [--json]
import { adaptAgent } from './core/adapt-lib.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] || '') : undefined; };
const has = (name) => args.includes(name);

const report = await adaptAgent({
  id: flag('--agent') || undefined,
  cli: flag('--cli') || undefined,
  env: flag('--profiles-dir') ? { ...process.env, ORCH_AGENT_PROFILES_DIR: flag('--profiles-dir') } : process.env,
  live: !has('--no-live'),
  commit: !has('--no-commit'),
  suite: has('--suite'),
  smoke: has('--smoke'),
  force: has('--force'),
});

if (has('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log('[adapt] agent=' + (report.id || '?') + ' cli=' + (report.cli || '?') + ' version=' + (report.version || '?'));
  if (report.profile) console.log('[adapt] profile: prompt=' + report.profile.args.prompt.join(' ') + ' approve=[' + report.profile.args.approve.join(' ') + '] model=' + (report.profile.args.model ? report.profile.args.model.join(' ') : '-') + ' effort=' + (report.profile.args.effort ? report.profile.args.effort.join(' ') : '-'));
  if (report.live) console.log('[adapt] live: ' + JSON.stringify(report.live).slice(0, 300));
  if (report.smoke) console.log('[adapt] block smoke: ' + JSON.stringify(report.smoke).slice(0, 200));
  if (report.suite) console.log('[adapt] suite: exit=' + report.suite.exit);
  console.log('[adapt] committed=' + report.committed + ' passed=' + report.passed + (report.reason ? ' reason=' + report.reason : ''));
}
process.exitCode = report.passed ? 0 : 1;
