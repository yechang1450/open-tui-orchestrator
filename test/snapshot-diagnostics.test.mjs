import test from 'node:test';
import assert from 'node:assert/strict';
import {processSnapshot, processSnapshotTimeoutMs} from '../scripts/core/leases.mjs';

// 身份枚举的失败话术必须可操作（2026-09-15 的今日实坑：本机 WMI 一度单次枚举 79.8 秒，
// 引擎 15 秒预算被突破，入口只回一句裸话术「Cannot verify process identities」——
// 不说耗时、不说原因、不给出路，慢机上无法排障）。
// 红例方向：把话术改回裸串（或去掉耗时/预算/出路任一项），下面两条断言必须红。

test('process snapshot failure names the budget, the elapsed time and the way out', () => {
  const error = (() => { try { processSnapshot(1); return null; } catch (e) { return e; } })();
  assert.ok(error, 'a 1 ms budget must fail on any machine');
  assert.match(error.message, /Cannot verify process identities/);
  assert.match(error.message, /did not return within 1 ms|exited with status/, error.message);
  assert.match(error.message, /elapsed \d+ ms/, error.message);
  assert.match(error.message, /ORCH_PS_TIMEOUT_MS/, error.message);
});

test('the snapshot budget honours ORCH_PS_TIMEOUT_MS and stays bounded', () => {
  const previous = process.env.ORCH_PS_TIMEOUT_MS;
  try {
    process.env.ORCH_PS_TIMEOUT_MS = '1';
    const error = (() => { try { processSnapshot(); return null; } catch (e) { return e; } })();
    assert.ok(error, 'the env budget must be applied');
    assert.match(error.message, /did not return within 1 ms|exited with status/, error.message);
    delete process.env.ORCH_PS_TIMEOUT_MS;
    assert.equal(processSnapshotTimeoutMs(), 15000, 'default stays 15 s');
    assert.equal(processSnapshotTimeoutMs(0), 15000, 'a non-positive override falls back to the default');
    assert.equal(processSnapshotTimeoutMs(999999), 120000, 'the budget is capped at 120 s');
    assert.equal(processSnapshotTimeoutMs(30000), 30000, 'an explicit call-site budget wins');
  } finally {
    if (previous === undefined) delete process.env.ORCH_PS_TIMEOUT_MS; else process.env.ORCH_PS_TIMEOUT_MS = previous;
  }
});
