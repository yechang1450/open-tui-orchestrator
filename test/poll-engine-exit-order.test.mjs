import test from 'node:test';
import assert from 'node:assert/strict';
import {main} from '../scripts/core/poll-windows.mjs';

const complete={runId:'poll-test',finishedAt:1,blocks:[{key:'B1'}],tasks:[{id:'T1'}],results:{B1:{status:'verified'}},taskResults:{T1:{status:'verified'}}};

test('a finalized successful ledger wins over a later nonzero engine exit', async () => {
  let time = 0;
  const previous = process.exitCode;
  try {
    await main(['--run-id', 'poll-test', '--engine-exit', '7', '--timeoutMs', '2000', '--intervalMs', '500'], {
      now: () => time,
      load: () => complete,
      snapshot: () => new Map(),
      sleep: async ms => { time += ms; },
      log: () => {},
      error: () => {},
    });
    assert.equal(process.exitCode, 0);
  } finally {
    process.exitCode = previous;
  }
});
