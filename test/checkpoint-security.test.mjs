import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {recordCheckpoint, readCheckpoints} from '../scripts/core/checkpoint.mjs';

test('checkpoint task identifiers cannot escape the checkpoint directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otui-checkpoint-'));
  const attempt = path.join(dir, 'attempt.json');
  const maliciousId = `../../${path.basename(dir)}-escape`;
  const outside = path.join(path.dirname(dir), `${path.basename(dir)}-escape.json`);
  try {
    fs.writeFileSync(attempt, JSON.stringify({runId: 'r', token: 't', taskIds: [maliciousId]}), 'utf8');
    assert.throws(() => recordCheckpoint(attempt, maliciousId, 'started'), /Invalid|safe|identifier/i);
    assert.throws(() => readCheckpoints(attempt), /Invalid|safe|identifier/i);
    assert.equal(fs.existsSync(outside), false);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('checkpoint helpers reject attempt paths routed through a junction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otui-checkpoint-junction-'));
  const outside = path.join(root, 'outside');
  const linked = path.join(root, 'attempt-link');
  const attempt = path.join(linked, 'attempt.json');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, linked, 'junction');
  fs.writeFileSync(path.join(outside, 'attempt.json'), JSON.stringify({runId: 'r', token: 't', taskIds: ['T001']}), 'utf8');
  try {
    assert.throws(() => recordCheckpoint(attempt, 'T001', 'started'), /symlink|junction|safe|path/i);
    assert.throws(() => readCheckpoints(attempt), /symlink|junction|safe|path/i);
    assert.equal(fs.existsSync(path.join(outside, 'checkpoints', 'T001.json')), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
