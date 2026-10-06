import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateRecoverySummary} from '../scripts/core/recovery.mjs';

function fixture(workspace) {
  return {protocol: 2, runId: 'symlink', workspace, request: 'first;second', generation: 1, history: [],
    tasks: [{id: 'T001', prompt: 'first'}, {id: 'T002', prompt: 'second'}],
    plan: [{key: 'B1', title: 'both', keys: [], dependsOn: [], b: {tasks: [{sourceIds: ['T001', 'T002']}]}}],
    blocks: [{key: 'B1', taskIds: ['T001', 'T002']}], results: {B1: {status: 'pending', attempts: []}},
    taskResults: {T001: {status: 'pending'}, T002: {status: 'pending'}}};
}

test('recovery ledger rejects a state path that crosses a directory junction', () => {
  const family = fileURLToPath(new URL('../temp/', import.meta.url));
  fs.mkdirSync(family, {recursive: true});
  const root = fs.mkdtempSync(path.join(family, 'ledger-symlink-'));
  const outside = path.join(root, 'outside');
  const link = path.join(root, 'temp', 'link');
  fs.mkdirSync(outside, {recursive: true});
  fs.mkdirSync(path.dirname(link), {recursive: true});
  fs.symlinkSync(outside, link, 'junction');
  try {
    const state = fixture(root);
    state.results.B1.attempts = [{runId: 'symlink', token: 't', file: path.join(link, 'attempt.json'), taskIds: ['T001']}];
    assert.throws(() => validateRecoverySummary(state), /Invalid recovery ledger/);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
