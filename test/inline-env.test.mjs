import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inlineEnvJson} from '../scripts/orchestrate-sdk.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 2026-09-15/0.9.15：inline 路径（容量不足/只读分析/策略回退）也要带环境监测字段——否则「不给开窗」
// 的机器可读结论里只有一个 capacity 数字，看不出机器当时多紧（pi 电池现场：free 掉到 <1GB ⇒ capacity=1）。
test('inline outputs carry environment telemetry (platform/node/free/total + capacity)', () => {
  const env = inlineEnvJson({capacity: 1});
  assert.equal(env.capacity, 1);
  assert.equal(env.platform, process.platform);
  assert.equal(env.node, process.version);
  assert.ok(Number.isFinite(env.freeMB) && env.freeMB >= 0, 'freeMB must be a measured number: ' + env.freeMB);
  assert.ok(Number.isFinite(env.totalMB) && env.totalMB > 0, 'totalMB must be a measured number: ' + env.totalMB);
  const bare = inlineEnvJson();
  assert.equal('capacity' in bare, false, 'capacity must only be merged when known');
});

test('every capacity-gated inline JSON literal carries the env field (source wiring)', () => {
  const src = fs.readFileSync(path.join(root, 'scripts', 'core', 'orchestrate-sdk.mjs'), 'utf8');
  const hits = src.match(/env:inlineEnvJson\(/g) || [];
  assert.ok(hits.length >= 1, 'the policy-fallback inline JSON must carry env:inlineEnvJson — found ' + hits.length);
  // 0.9.17：容量公式退役 ⇒ 旧的 capacity-below-two-windows 门不得复活（复活即红）。
  assert.equal(src.includes("reason:'capacity-below-two-windows'"), false, 'the retired capacity gate must not reappear');
  assert.ok(src.includes('memFit:LAST_MEM_FIT'), 'inline JSON must surface the memory-fit result (memFit)');
});
