import fs from 'node:fs';
import path from 'node:path';
import {runDirectory} from './runtime-context.mjs';
import {realpathWithMissing,containedBy} from './path-security.mjs';

export {runDirectory};

// 执行看板（run board）：把运行账本投影成"块状态 + 任务状态"的实时视图。
// 数据源：summary.json（block 级权威）+ attempts/**/checkpoints（task 级真实进度，
// 因为 running 期间 taskResults 会滞后）。纯函数 + 只读文件访问，供引擎事件流、
// --watch 和 --status 共用。

const BLOCK_MARKS = { verified: '✓', running: '▶', launching: '…', waiting: '⏳', pending: '·', failed: '✗', timeout: '✗', 'popup-failed': '✗', 'needs-reconciliation': '⚠', blocked: '⊘', 'awaiting-verification': '◐' };
const TERMINAL = new Set(['verified', 'failed', 'blocked', 'cancelled', 'awaiting-verification', 'preflight-failed', 'popup-failed', 'timeout', 'needs-reconciliation']);

export function boardSignature(sum, taskStates = {}) {
  return JSON.stringify([
    sum?.generation ?? null,
    sum?.finishedAt ?? null,
    (sum?.blocks || []).map(b => [b.key, sum?.results?.[b.key]?.status || 'pending', sum?.results?.[b.key]?.attempts?.length || 0]),
    Object.values(sum?.taskResults || {}).map(t => t?.status || 'pending'),
    Object.entries(taskStates).map(([id, st]) => id + ':' + st),
  ]);
}

export function boardCounts(sum) {
  const counts = { total: 0, verified: 0, running: 0, waiting: 0, failed: 0 };
  for (const b of sum?.blocks || []) {
    counts.total++;
    const st = sum?.results?.[b.key]?.status || 'pending';
    if (st === 'verified') counts.verified++;
    else if (st === 'running' || st === 'launching' || st === 'awaiting-verification') counts.running++;
    else if (st === 'pending' || st === 'waiting') counts.waiting++;
    else counts.failed++;
  }
  return counts;
}

export function boardSummaryLine(sum, taskStates = {}) {
  const c = boardCounts(sum);
  const parts = (sum?.blocks || []).map(b => b.key + (BLOCK_MARKS[sum?.results?.[b.key]?.status || 'pending'] || '?'));
  const active = [];
  for (const [id, st] of Object.entries(taskStates)) if (st && st !== 'completed') active.push(id + ':' + st);
  return `[board] run=${sum?.runId || '?'} gen=${sum?.generation ?? '?'} mode=${sum?.spawnMode || 'window'} ${c.verified}/${c.total} verified${c.waiting ? ' ' + c.waiting + ' waiting' : ''}${c.failed ? ' ' + c.failed + ' failed' : ''} [${parts.join(' ')}]${active.length ? ' active=' + active.join(',') : ''}${sum?.finishedAt ? ' finalized success=' + (sum?.success === true) : ''}`;
}

function boardFullText(sum, taskStates = {}) {
  const c = boardCounts(sum);
  const lines = [`── run ${sum?.runId || '?'} · mode=${sum?.spawnMode || 'window'} · gen=${sum?.generation ?? '?'} · ${c.verified}/${c.total} verified${sum?.finishedAt ? ' · finalized success=' + (sum?.success === true) : ''} ──`];
  for (const b of sum?.blocks || []) {
    const e = sum?.results?.[b.key] || {};
    const st = e.status || 'pending';
    const mark = BLOCK_MARKS[st] || '?';
    const tasks = (b.taskIds || []).map(id => {
      const t = sum?.taskResults?.[id] || {};
      const cp = taskStates[id] ? ' ' + taskStates[id] : '';
      const tm = t.status === 'verified' ? '✓' : t.status ? (t.status[0] || '?') : '·';
      return id + tm + cp;
    }).join(' ');
    const reason = e.reason ? '  (' + String(e.reason).slice(0, 80) + ')' : '';
    lines.push(' ' + b.key.padEnd(3) + (b.title || '').padEnd(22) + mark + ' ' + st.padEnd(20) + tasks + reason);
  }
  return lines.join('\n');
}

export function boardJson(sum, taskStates = {}) {
  return {
    ts: Date.now(),
    runId: sum?.runId ?? null,
    generation: sum?.generation ?? null,
    spawnMode: sum?.spawnMode || 'window',
    finished: !!sum?.finishedAt,
    success: sum?.success ?? null,
    blocks: (sum?.blocks || []).map(b => ({
      key: b.key,
      title: b.title,
      status: sum?.results?.[b.key]?.status || 'pending',
      attempts: sum?.results?.[b.key]?.attempts?.length || 0,
      reason: sum?.results?.[b.key]?.reason || null,
    })),
    tasks: Object.entries(sum?.taskResults || {}).map(([id, t]) => ({ id, status: t?.status || 'pending', checkpoint: taskStates[id] || null })),
  };
}

export function taskCheckpointStates(runDir, sum) {
  const states = {};
  const attemptsRoot = path.resolve(runDir, 'attempts');
  const realRunDir = realpathWithMissing(runDir);
  const realAttemptsRoot = realpathWithMissing(attemptsRoot);
  if (!realRunDir || !realAttemptsRoot || !containedBy(realRunDir, realAttemptsRoot)) return states;
  const safeAttemptFile = value => {
    if (typeof value !== 'string' || !value) return null;
    // 相对路径按 runDir 起算（而不是 process.cwd()）：监视器可能从任意 cwd 调用，
    // 从 cwd 解析会让合法账本随调用点漂移、也给篡改账本留下 cwd 相关的接受面。
    const candidate = path.resolve(runDir, value);
    const real = realpathWithMissing(candidate);
    return real && containedBy(realAttemptsRoot, real) ? candidate : null;
  };
  for (const b of sum?.blocks || []) {
    for (const a of sum?.results?.[b.key]?.attempts || []) {
      const attemptFile = safeAttemptFile(a?.file);
      if (!attemptFile) continue;
      for (const id of a.taskIds || []) {
        try {
          if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) continue;
          const f = path.join(path.dirname(attemptFile), 'checkpoints', id + '.json');
          const cp = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
          if (cp?.state) states[id] = cp.state;
        } catch { /* not yet written */ }
      }
    }
  }
  return states;
}

function readBoardSummary(runDir) {
  try { return JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

export function readBoard(workspace, runId, stateDir) {
  const dir = runDirectory(workspace, runId, stateDir);
  const sum = readBoardSummary(dir);
  if (!sum) return null;
  return { dir, sum, taskStates: taskCheckpointStates(dir, sum) };
}


// --watch：只读流式看板。TTY 原地重绘完整看板；管道/--jsonl 输出机器可读行。
// 机器可调用契约：未知 run 不许无限挂起。首次读到看板前有一个上界（graceMs /
// ORCH_WATCH_GRACE_MS，默认 60s——覆盖「--run-windows 先规划、后建 run 目录」的竞态），
// 超时即 fail-closed 一行诊断；已读到的运行中途丢 summary.json（超过瞬时重写容忍窗）报错，不静默停摆。
export async function watchRun({ workspace, runId, stateDir, intervalMs = 800, jsonl = false, out = process.stdout, graceMs = Number(process.env.ORCH_WATCH_GRACE_MS ?? 60000), missToleranceMs = Number(process.env.ORCH_WATCH_MISS_TOLERANCE_MS ?? 6000) }) {
  const write = s => out.write(s);
  const tty = !!out.isTTY && !jsonl;
  const dir = runDirectory(workspace, runId, stateDir);
  const grace = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : 60000;
  const missTolerance = Number.isFinite(missToleranceMs) && missToleranceMs >= 0 ? missToleranceMs : 6000;
  const startedAt = Date.now();
  let lastSig = '', paintedLines = 0, announcedFinal = false, seen = false, lastSeenAt = 0;
  for (;;) {
    const b = readBoard(workspace, runId, stateDir);
    if (b) {
      seen = true; lastSeenAt = Date.now();
      const sig = boardSignature(b.sum, b.taskStates);
      if (sig !== lastSig) {
        lastSig = sig;
        if (jsonl) write(JSON.stringify(boardJson(b.sum, b.taskStates)) + '\n');
        else if (tty) {
          const text = boardFullText(b.sum, b.taskStates) + '\n';
          if (paintedLines) write('\x1b[' + paintedLines + 'A\x1b[J');
          write(text);
          paintedLines = text.split('\n').length - 1;
        } else write(boardSummaryLine(b.sum, b.taskStates) + '\n');
      }
      if (b.sum.finishedAt) {
        if (!jsonl && !tty && !announcedFinal) { announcedFinal = true; write('[board] run=' + runId + ' finalized success=' + (b.sum.success === true) + '\n'); }
        return b.sum.success === true ? 0 : 1;
      }
    } else if (seen) {
      // 瞬时重写窗口（atomicJson rm+rename）不该被误报成 lost：容忍 missTolerance 内的不可读，
      // 持续缺失才 fail-closed。
      if (Date.now() - lastSeenAt >= missTolerance) throw new Error('Run ' + runId + ' lost its summary.json while being watched (dir: ' + dir + ')');
    } else if (Date.now() - startedAt >= grace) {
      throw new Error(fs.existsSync(dir)
        ? 'Run ' + runId + ' has no readable summary.json (dir exists: ' + dir + ')'
        : 'Run not found: ' + runId + ' (no run directory ' + dir + ')');
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}
