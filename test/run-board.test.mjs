import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {boardSignature, boardSummaryLine, boardCounts, readBoard, taskCheckpointStates, watchRun} from '../scripts/core/run-board.mjs';

const family = path.join(fileURLToPath(new URL('..', import.meta.url)), 'temp');

function fixtureRun({ finished = false, success = null, blockStatus = 'running', taskStatus = 'pending', checkpoint = null } = {}) {
  fs.mkdirSync(family, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(family, 'board-'));
  const runDir = path.join(workspace, 'temp', 'orchestrator', 'runs', 'boardrun');
  fs.mkdirSync(path.join(runDir, 'attempts', 'B1', '1', 'checkpoints'), { recursive: true });
  const attemptFile = path.join(runDir, 'attempts', 'B1', '1', 'attempt.json');
  fs.writeFileSync(attemptFile, JSON.stringify({ file: attemptFile, runId: 'boardrun', token: 't', number: 1, taskIds: ['T001'], createdAt: Date.now() }));
  if (checkpoint) fs.writeFileSync(path.join(runDir, 'attempts', 'B1', '1', 'checkpoints', 'T001.json'), JSON.stringify({ id: 'T001', runId: 'boardrun', token: 't', state: checkpoint }));
  const sum = {
    protocol: 2, version: 'test', agent: 'codex', runId: 'boardrun', workspace, request: '一件事', capacity: 8,
    coordinator: path.join(workspace, 'temp', 'coordinator'), generation: 1, history: [], startedAt: Date.now(),
    spawnMode: 'headless', taskId: undefined, tasks: [{ id: 'T001', prompt: '执行甲' }],
    plan: [{ key: 'B1', b: { tasks: [{ sourceIds: ['T001'] }] } }],
    blocks: [{ key: 'B1', title: 'proj-a', taskIds: ['T001'] }],
    results: { B1: { status: blockStatus, attempts: [{ file: attemptFile, runId: 'boardrun', token: 't', number: 1, taskIds: ['T001'], createdAt: Date.now() }] } },
    taskResults: { T001: { status: taskStatus } },
  };
  if (finished) { sum.finishedAt = Date.now(); sum.success = success; }
  delete sum.taskId;
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(sum, null, 2));
  return { workspace, runDir, cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }) };
}

test('board signature tracks block and task state changes', () => {
  const f = fixtureRun({});
  try {
    const b1 = readBoard(f.workspace, 'boardrun');
    const s1 = boardSignature(b1.sum, b1.taskStates);
    assert.equal(s1, boardSignature(b1.sum, b1.taskStates));
    const b2 = readBoard(f.workspace, 'boardrun');
    b2.sum.results.B1.status = 'verified';
    assert.notEqual(s1, boardSignature(b2.sum, b2.taskStates));
  } finally { f.cleanup(); }
});

test('board summary and counts reflect verified/waiting/failed blocks', () => {
  const f = fixtureRun({ blockStatus: 'verified', taskStatus: 'verified' });
  try {
    const b = readBoard(f.workspace, 'boardrun');
    const counts = boardCounts(b.sum);
    assert.deepEqual(counts, { total: 1, verified: 1, running: 0, waiting: 0, failed: 0 });
    const line = boardSummaryLine(b.sum, b.taskStates);
    assert.match(line, /\[board\] run=boardrun/);
    assert.match(line, /1\/1 verified/);
    assert.match(line, /mode=headless/);
  } finally { f.cleanup(); }
});

test('task checkpoint states surface the true per-task progress while running', () => {
  const f = fixtureRun({ checkpoint: 'started' });
  try {
    const b = readBoard(f.workspace, 'boardrun');
    assert.equal(b.taskStates.T001, 'started');
    assert.match(boardSummaryLine(b.sum, b.taskStates), /active=T001:started/);
  } finally { f.cleanup(); }
});

test('taskCheckpointStates ignores attempt paths outside the run directory', () => {
  const f = fixtureRun({ checkpoint: 'started' });
  try {
    const outside = path.join(f.workspace, 'outside', 'attempt.json');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, '{}');
    const sum = JSON.parse(fs.readFileSync(path.join(f.runDir, 'summary.json'), 'utf8'));
    sum.results.B1.attempts[0].file = outside;
    assert.deepEqual(taskCheckpointStates(f.runDir, sum), {});
  } finally { f.cleanup(); }
});

test('taskCheckpointStates ignores attempt paths routed through a junction', () => {
  const f = fixtureRun({ checkpoint: 'started' });
  const outside = path.join(f.workspace, 'outside-junction');
  const linkedDir = path.join(f.runDir, 'attempts', 'B1', 'linked');
  try {
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, linkedDir, 'junction');
    const outsideAttempt = path.join(outside, 'attempt.json');
    fs.writeFileSync(outsideAttempt, '{}');
    fs.mkdirSync(path.join(outside, 'checkpoints'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'checkpoints', 'T001.json'), JSON.stringify({state: 'started'}));
    const sum = JSON.parse(fs.readFileSync(path.join(f.runDir, 'summary.json'), 'utf8'));
    sum.results.B1.attempts[0].file = path.join(linkedDir, 'attempt.json');
    assert.deepEqual(taskCheckpointStates(f.runDir, sum), {});
  } finally { f.cleanup(); }
});

test('watchRun streams board lines and exits with the run outcome', async () => {
  const f = fixtureRun({});
  try {
    const chunks = [];
    const out = { isTTY: false, write: s => chunks.push(s) };
    const p = watchRun({ workspace: f.workspace, runId: 'boardrun', intervalMs: 50, jsonl: false, out });
    await new Promise(r => setTimeout(r, 200));
    const sum = JSON.parse(fs.readFileSync(path.join(f.runDir, 'summary.json'), 'utf8'));
    sum.finishedAt = Date.now(); sum.success = true;
    fs.writeFileSync(path.join(f.runDir, 'summary.json'), JSON.stringify(sum));
    const code = await p;
    assert.equal(code, 0);
    const text = chunks.join('');
    assert.match(text, /\[board\] run=boardrun/);
    assert.match(text, /finalized success=true/);
  } finally { f.cleanup(); }
});

test('watchRun reports failure outcomes through its exit code', async () => {
  const f = fixtureRun({ finished: true, success: false, blockStatus: 'failed' });
  try {
    const chunks = [];
    const code = await watchRun({ workspace: f.workspace, runId: 'boardrun', intervalMs: 30, jsonl: true, out: { isTTY: false, write: s => chunks.push(s) } });
    assert.equal(code, 1);
    assert.match(chunks.join(''), /"runId":"boardrun"/);
  } finally { f.cleanup(); }
});

test('taskCheckpointStates tolerates runs without attempt inventories', () => {
  const f = fixtureRun({});
  try {
    assert.deepEqual(taskCheckpointStates(f.runDir, { blocks: [], results: {} }), {});
  } finally { f.cleanup(); }
});

// 机器可调用契约：--watch 不许无限挂起。未知 run 在上界（graceMs）内 fail-closed，
// 已读到的运行中途丢 summary.json 也立刻报错；两条诊断都不许带栈帧（改回裸轮询即红）。
test('watchRun fails closed instead of hanging when the run never materializes', async () => {
  const f = fixtureRun({});
  try {
    const error = await watchRun({ workspace: f.workspace, runId: 'ghost-run', intervalMs: 10, jsonl: true, out: { isTTY: false, write: () => {} }, graceMs: 60 }).then(() => null, e => e);
    assert.ok(error, 'watchRun must refuse an unknown run instead of polling forever');
    assert.match(error.message, /Run not found: ghost-run/);
    assert.match(error.message, /no run directory/);
    assert.doesNotMatch(error.message, /\s+at\s/);
  } finally { f.cleanup(); }
});

test('watchRun fails closed when the run directory exists but no summary is ever readable', async () => {
  const f = fixtureRun({});
  try {
    fs.rmSync(path.join(f.runDir, 'summary.json'));
    const error = await watchRun({ workspace: f.workspace, runId: 'boardrun', intervalMs: 10, out: { isTTY: false, write: () => {} }, graceMs: 60 }).then(() => null, e => e);
    assert.ok(error, 'an unreadable summary must not be watched forever');
    assert.match(error.message, /has no readable summary\.json/);
    assert.doesNotMatch(error.message, /\s+at\s/);
  } finally { f.cleanup(); }
});

test('watchRun reports a summary that stays missing mid-watch instead of stopping silently', async () => {
  const f = fixtureRun({});
  try {
    const chunks = [];
    // 瞬时重写窗口（atomicJson 的 rm+rename）有容忍；持续缺失超过容忍窗必须 surface。
    const watching = watchRun({ workspace: f.workspace, runId: 'boardrun', intervalMs: 20, out: { isTTY: false, write: s => chunks.push(s) }, graceMs: 5000, missToleranceMs: 150 });
    await new Promise(r => setTimeout(r, 80));
    fs.rmSync(path.join(f.runDir, 'summary.json'));
    const error = await watching.then(() => null, e => e);
    assert.ok(error, 'losing the summary mid-watch must surface, not stop silently');
    assert.match(error.message, /lost its summary\.json/);
    assert.match(chunks.join(''), /\[board\] run=boardrun/);
  } finally { f.cleanup(); }
});

test('watchRun tolerates a transient summary rewrite window instead of declaring the run lost', async () => {
  const f = fixtureRun({});
  try {
    const chunks = [];
    const watching = watchRun({ workspace: f.workspace, runId: 'boardrun', intervalMs: 20, out: { isTTY: false, write: s => chunks.push(s) }, graceMs: 5000 });
    await new Promise(r => setTimeout(r, 80));
    const summaryFile = path.join(f.runDir, 'summary.json');
    const body = fs.readFileSync(summaryFile, 'utf8');
    fs.rmSync(summaryFile);                              // atomicJson 重写的空窗
    await new Promise(r => setTimeout(r, 60));
    const sum = JSON.parse(body); sum.finishedAt = Date.now(); sum.success = true;
    fs.writeFileSync(summaryFile, JSON.stringify(sum));  // 重写完成
    const code = await watching;
    assert.equal(code, 0, 'a rewrite window must not be reported as a lost run');
  } finally { f.cleanup(); }
});

test('taskCheckpointStates resolves relative attempt paths from the run directory', () => {
  const f = fixtureRun({ checkpoint: 'started' });
  try {
    const sum = JSON.parse(fs.readFileSync(path.join(f.runDir, 'summary.json'), 'utf8'));
    sum.results.B1.attempts[0].file = path.join('attempts', 'B1', '1', 'attempt.json'); // 相对 runDir
    assert.equal(taskCheckpointStates(f.runDir, sum).T001, 'started', 'relative attempt paths must resolve against the run directory, not the process cwd');
  } finally { f.cleanup(); }
});

// 反向判据：宽限不是「立刻失败」——run 目录先出现、summary.json 稍后才落盘
// （--run-windows 规划期的真实竞态）必须照常等待并流式看完，不许提前 fail-closed。
test('watchRun waits out the grace window while the run directory has no summary yet', async () => {
  const f = fixtureRun({});
  try {
    const summaryFile = path.join(f.runDir, 'summary.json');
    const body = fs.readFileSync(summaryFile, 'utf8');
    fs.rmSync(summaryFile);
    const chunks = [];
    const out = { isTTY: false, write: s => chunks.push(s) };
    const watching = watchRun({ workspace: f.workspace, runId: 'boardrun', intervalMs: 20, out, graceMs: 5000 });
    await new Promise(r => setTimeout(r, 100));
    const sum = JSON.parse(body);
    sum.finishedAt = Date.now(); sum.success = true;
    fs.writeFileSync(summaryFile, JSON.stringify(sum));
    const code = await watching;
    assert.equal(code, 0, 'a summary landing inside the grace window must be watched normally');
    const text = chunks.join('');
    assert.match(text, /\[board\] run=boardrun/);
    assert.match(text, /finalized success=true/);
  } finally { f.cleanup(); }
});
