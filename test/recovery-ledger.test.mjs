import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateRecoverySummary} from '../scripts/core/recovery.mjs';
import {runWindows, verifyRun} from '../scripts/core/runner.mjs';

function fixture(workspace) {
  return {protocol: 2, runId: 'ledger', workspace, request: 'first;second', generation: 1, history: [],
    tasks: [{id: 'T001', prompt: 'first'}, {id: 'T002', prompt: 'second'}],
    plan: [{key: 'B1', title: 'both', keys: [], dependsOn: [], b: {tasks: [{sourceIds: ['T001', 'T002']}]}}],
    blocks: [{key: 'B1', taskIds: ['T001', 'T002']}], results: {B1: {status: 'pending', attempts: []}},
    taskResults: {T001: {status: 'pending'}, T002: {status: 'pending'}}};
}

test('saved recovery ledger rejects inconsistent inventories without mutating input', () => {
  const valid = fixture(process.cwd());
  validateRecoverySummary(valid);
  const changes = [
    state => state.tasks.pop(),
    state => { state.tasks[0].prompt = 'changed'; },
    state => state.blocks[0].taskIds.pop(),
    state => state.blocks[0].taskIds.push('T001'),
    state => { state.plan = []; },
    state => { state.results.B1.attempts = [{runId: 'foreign', token: 't', file: 'x', taskIds: ['T001']}]; },
    state => { state.generation = 0; },
    state => { state.history = null; },
    state => { state.plan[0].dependsOn = ['B1']; },
    state => { state.acceptanceSha256 = 'not-a-sha256-hex'; },
    state => { state.results.B1.attempts = [{runId: 'ledger', token: 't', file: 'f', taskIds: ['T001']}];
               state.results.B1.launcherFiles = {lp: path.join(path.dirname(process.cwd()), 'win-launch-evil.ps1'), pidf: 'p', rf: 'r'}; },
    state => { state.results.B1.attempts = [{runId: 'ledger', token: 't', file: path.join(path.dirname(process.cwd()), 'attempt.json'), taskIds: ['T001']}]; },
  ];
  for (const change of changes) {
    const value = structuredClone(valid);
    change(value);
    const saved = JSON.stringify(value);
    assert.throws(() => validateRecoverySummary(value), /Invalid recovery ledger/);
    assert.equal(JSON.stringify(value), saved);
  }
  // launcherFiles 解析到工作区之内（含相对路径形式）是合法的，不得误伤。
  const legit = structuredClone(valid);
  legit.results.B1.attempts = [{runId: 'ledger', token: 't', file: path.join(process.cwd(), 'temp', 'orchestrator', 'runs', 'ledger', 'attempts', 'B1', '1', 'attempt.json'), taskIds: ['T001']}];
  legit.results.B1.launcherFiles = {lp: 'temp/win-launch-x.ps1', pidf: path.join(process.cwd(), 'temp', 'window-x.pid'), rf: path.join(process.cwd(), 'temp', 'win-x.result.json')};
  legit.acceptanceSha256 = 'a'.repeat(64);
  validateRecoverySummary(legit);
});

test('launcher containment accepts drive-root workspaces', () => {
  // path.resolve 后的盘符根自带尾分隔符；拼sep变双分隔符会把根工作区的合法账本全误判逃逸。
  const root = path.parse(process.cwd()).root;
  const state = fixture(root);
  state.results.B1.attempts = [{runId: 'ledger', token: 't', file: path.join(root, 'temp', 'orchestrator', 'runs', 'ledger', 'attempts', 'B1', '1', 'attempt.json'), taskIds: ['T001']}];
  state.results.B1.launcherFiles = {lp: path.join(root, 'temp', 'win-launch-x.ps1'), pidf: path.join(root, 'temp', 'window-x.pid'), rf: path.join(root, 'temp', 'win-x.result.json')};
  validateRecoverySummary(state);
  const escaped = structuredClone(state);
  const otherDrive = /^c:/i.test(root) ? 'D:\\' : 'C:\\';
  escaped.results.B1.launcherFiles = {lp: path.join(otherDrive, 'win-launch-evil.ps1'), pidf: 'p', rf: 'r'};
  assert.throws(() => validateRecoverySummary(escaped), /Invalid recovery ledger/);
});

test('resume rejects a damaged ledger before invoking execution hooks', async () => {
  const family = fileURLToPath(new URL('../temp/', import.meta.url));
  fs.mkdirSync(family, {recursive: true});
  const root = fs.mkdtempSync(path.join(family, 'ledger-corruption-'));
  try {
    const dir = path.join(root, 'temp/orchestrator/runs/ledger');
    fs.mkdirSync(dir, {recursive: true});
    const saved = fixture(root);
    saved.blocks[0].taskIds.pop();
    saved.finishedAt = 1;
    const file = path.join(dir, 'summary.json');
    const raw = JSON.stringify(saved);
    fs.writeFileSync(file, raw);
    fs.writeFileSync(path.join(dir, 'acceptance.json'), '{}');
    let calls = 0;
    const hooks = new Proxy({}, {get() { calls++; throw new Error('Unexpected execution hook'); }});
    await assert.rejects(runWindows('', hooks, {workspace: root, capacity: 8, runId: 'ledger', resume: true}), /Invalid recovery ledger/);
    assert.throws(() => verifyRun(root, 'ledger'), /Invalid recovery ledger/);
    assert.equal(calls, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
