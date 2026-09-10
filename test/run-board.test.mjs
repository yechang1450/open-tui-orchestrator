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
