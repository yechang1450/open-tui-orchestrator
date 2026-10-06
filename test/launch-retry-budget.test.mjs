// A2 修复判据：起窗重试预算必须是 spawnHeadlessWithRetry 的有效默认（≥2），
// 而不是被调用方写死的 1。
//
// 背景（opencode 轮实测）：run.log 出现
//   "[headless] launch NOT confirmed (attempt 1/1) for [fit-merged-12]"
//   "!! [headless] launch FAILED after 1 attempts for [fit-merged-12]"
// ⇒ runner.mjs:422 显式传 1，spawnHeadlessWithRetry(lp,title,pidf,maxRetry=3,…) 的默认 3 从未生效，
//   35s 确认窗一次不过即抛 'Visible window did not start'，整块（≤12 题）判死。
//
// 本用例只做源码锁 + 契约断言，不启动任何 agent。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'scripts', 'core', 'runner.mjs');
const SDK = path.join(HERE, '..', 'scripts', 'core', 'orchestrate-sdk.mjs');

test('runner 调用 hooks.spawn 时不得把起窗重试预算写死为 1', () => {
  const src = fs.readFileSync(RUNNER, 'utf8');
  const m = /hooks\.spawn\(([^)]*)\)/.exec(src);
  assert.ok(m, 'runner.mjs 应当调用 hooks.spawn(...)');
  const args = m[1].split(',').map((s) => s.trim());
  // 形态：hooks.spawn(la.lp, r.title, la.pidf, <budget>, token)
  const budget = args[3];
  assert.ok(budget !== undefined, 'hooks.spawn 应显式或隐式给出预算位');
  assert.notEqual(budget, '1', '起窗重试预算不得写死为 1（会浪费 spawnHeadlessWithRetry 的默认重试）');
});

test('spawnHeadlessWithRetry 的默认重试预算与调用方一致（≥2）', () => {
  const src = fs.readFileSync(SDK, 'utf8');
  const m = /async function spawnHeadlessWithRetry\(([^)]*)\)/.exec(src);
  assert.ok(m, 'orchestrate-sdk.mjs 应当定义 spawnHeadlessWithRetry');
  const params = m[1].split(',').map((s) => s.trim());
  const maxRetryParam = params.find((p) => p.startsWith('maxRetry'));
  assert.ok(maxRetryParam, 'spawnHeadlessWithRetry 应有 maxRetry 形参');
  // 形如 "maxRetry = 3"（允许等号两侧空格）
  const def = Number((/=\s*(\d+)/.exec(maxRetryParam) || [])[1]);
  assert.ok(Number.isFinite(def) && def >= 2,
    `spawnHeadlessWithRetry 的默认 maxRetry 应为 ≥2，实际 ${maxRetryParam}`);
});
