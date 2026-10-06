import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {waitOpenClawResult} from '../scripts/core/openclaw-runtime.mjs';

test('OpenClaw preflight failure is terminal instead of consuming retry attempts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otui-openclaw-result-'));
  const rf = path.join(dir, 'result.json');
  const pidf = path.join(dir, 'missing.pid');
  try {
    fs.writeFileSync(rf, JSON.stringify({__EXIT__: 1, __DONE__: true, __REPORT__: 'OPENCLAW_CONFIG_INVALID: preflight failed before interactive startup'}), 'utf8');
    const result = await waitOpenClawResult(rf, 100, pidf);
    assert.equal(result.done, true);
    assert.equal(result.exitCode, 1);
    assert.equal(result.terminal, true);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
