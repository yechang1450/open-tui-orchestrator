import fs from 'node:fs';
import path from 'node:path';
import {bootId} from './contracts.mjs';

// 断电恢复 P0（2026-09-18）：真断电 = 所有进程瞬间消失；稳的应对不在「断电那一刻」（那刻什么都做不了），
// 而在「下一次开机怎么自动收敛回真相」。本模块只做一件事：用**确定性判据**找出「上一次开机留下的、
// 未完成的 run」，给出可核对的状态与恢复命令。
//   判据：summary.bootId 存在且 ≠ 当前 bootId ⇒ 该 run 的控制器已随重启消失。
//         PID 跨重启会重用、时间戳可被改——只有 bootId 能确定「来自上一次开机」。
//   收敛：交给同一条 --resume-run 路径（不新造「断电模式」）。单元按验收三分（已过=直接记账 /
//         不过=重跑 / 不确定=重跑并如实标注）由既有 recovery 机制完成；恢复本身可再断电，下次扫描再来。
//   安全：默认只报告（report-only）；执行恢复是调用方显式动作（scripts/recover-stale.mjs --resume）。
export function scanStaleRuns(workspace, {nowBoot = bootId(), runsDir} = {}) {
  const dir = runsDir || path.join(workspace, 'temp', 'orchestrator', 'runs');
  const found = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const summaryFile = path.join(dir, entry.name, 'summary.json');
    let sum;
    try {
      sum = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    } catch (error) {
      // 没有账本（还没建账就断电）或账本读不出来（fsync+rename 之后不应再出现半截）。按「不可判定」入列，
      // 由人核对——绝不假装它已完成，也不擅自重放。
      found.push({
        runId: entry.name,
        status: fs.existsSync(summaryFile) ? 'unreadable' : 'no-ledger',
        note: String((error && error.message) || error).slice(0, 200),
        resumeCommand: null,
      });
      continue;
    }
    if (sum.success === true || sum.finishedAt !== undefined) continue;        // 已收口：不碰
    if (sum.bootId === undefined || sum.bootId === nowBoot) continue;          // 本次开机的 run：控制器可能还活着
    const results = sum.results || {};
    const agent = sum.agent || 'codex';
    const mode = sum.spawnMode || 'headless';
    found.push({
      runId: sum.runId || entry.name,
      status: 'stale-after-reboot',
      workspace: sum.workspace || workspace,
      agent,
      spawnMode: mode,
      generation: sum.generation || 1,
      startedAt: sum.startedAt || null,
      staleBootId: sum.bootId,
      blocks: Object.entries(results).map(([key, value]) => ({key, status: (value && value.status) || 'unknown'})),
      resumeCommand: `open-tui-orchestrator --agent ${agent} --mode ${mode} --workspace ${JSON.stringify(sum.workspace || workspace)} --resume-run ${sum.runId || entry.name}`,
    });
  }
  return found.sort((a, b) => String(a.runId).localeCompare(String(b.runId)));
}
