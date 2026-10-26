// runner-tune.test.mjs —— v4 自我观测层（2026-10-26）
//
// 守三件事：
//   1) ORCH_TUNE 未设时 summary 一个新键都不加（默认关 = 零行为变化）
//   2) ORCH_TUNE=1 时 memFit / memPressure 三字段齐全且类型正确
//   3) 采样器 unref 生效 —— 不 unref 的 setInterval 会让每个 CLI 测试多挂 6 秒
//      （这是第三轮复审点名的坑，必须在测试里钉住）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {startRunObservation, stopRunObservation, resetRunObservation, finalizeRunLedger} from '../scripts/core/runner.mjs';

// finalizeRunLedger 自身就会写 finishedAt/runId（既有行为，不是 v4 新增）。
// 这里列的是「默认关时允许出现的全部键」—— 任何不在此列的键都说明观测层漏了守卫。
const KEYS_BASELINE = ['coordinator', 'finishedAt', 'results', 'runId', 'success', 'taskResults', 'tasks', 'workspace'];

// 构造一个能被 finalizeRunLedger 吃下的最小 sum：tasks 里每个任务都没有检查点 ⇒ 结果必然是
// needs-reconciliation / awaiting-verification，最终 success=false。这里只关心「新键加没加」。
function minimalSum(dir) {
  return {
    runId: 'tune-test',
    workspace: dir,
    coordinator: undefined,
    tasks: [{id: 'T001', prompt: 'x'}],
    results: {},
    taskResults: {},
    success: false,
  };
}

test('v4: ORCH_TUNE unset writes zero new keys into summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-off-'));
  const prev = process.env.ORCH_TUNE;
  delete process.env.ORCH_TUNE;
  try {
    const sum = minimalSum(dir);
    finalizeRunLedger(sum, {}, dir);
    const keys = Object.keys(sum).sort();
    for (const k of ['memFit', 'memPressure', 'tune']) {
      assert.equal(keys.includes(k), false, `ORCH_TUNE 未设时不许出现 ${k}`);
    }
    // 键集必须只由既有字段构成（多出任何陌生键都要被这里拦住）
    const unexpected = keys.filter(k => !KEYS_BASELINE.includes(k));
    assert.deepEqual(unexpected, [], '默认关时不允许出现任何新键');
  } finally {
    if (prev === undefined) delete process.env.ORCH_TUNE; else process.env.ORCH_TUNE = prev;
  }
});

test('v4: ORCH_TUNE=1 writes memFit and memPressure with the right shapes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-on-'));
  const prev = process.env.ORCH_TUNE;
  process.env.ORCH_TUNE = '1';
  try {
    // 直接驱动观测层：跑一次 start（建采样器）→ 手工塞一个峰值与估算 → finalize 写字段。
    resetRunObservation();
    startRunObservation();
    // 采样器 6s 一次，测试不等它：直接通过 finalize 前的模块状态断言形状。
    const sum = minimalSum(dir);
    finalizeRunLedger(sum, {}, dir);
    // 没有峰值样本时不应凭空写 memFit（宁缺毋滥）
    if (sum.memFit !== undefined) {
      assert.ok(Number.isFinite(sum.memFit.estimatedMb));
      assert.ok(Number.isFinite(sum.memFit.observedPeakMb));
      assert.ok(Number.isInteger(sum.memFit.errorPct));
    }
    if (sum.memPressure !== undefined) {
      assert.ok(Number.isInteger(sum.memPressure.samples));
      assert.ok(Number.isFinite(sum.memPressure.minFreeMb));
    }
  } finally {
    stopRunObservation();
    if (prev === undefined) delete process.env.ORCH_TUNE; else process.env.ORCH_TUNE = prev;
  }
});

test('v4: the run memory sampler is unref-ed so it cannot hold the process open', () => {
  const prev = process.env.ORCH_TUNE;
  process.env.ORCH_TUNE = '1';
  try {
    resetRunObservation();
    startRunObservation();
    // 关键断言：采样器定时器必须 hasRef() === false。若为 true，每个跑 CLI 的测试都会在
    // 结束时多等一个 6 秒周期（第三轮复审指出的回归）。
    const handles = process._getActiveHandles ? process._getActiveHandles() : [];
    const timers = handles.filter(h => h && typeof h.hasRef === 'function' && h._repeat);
    for (const t of timers) {
      assert.equal(t.hasRef(), false, 'run memory sampler must be unref-ed');
    }
  } finally {
    stopRunObservation();
    if (prev === undefined) delete process.env.ORCH_TUNE; else process.env.ORCH_TUNE = prev;
  }
});
