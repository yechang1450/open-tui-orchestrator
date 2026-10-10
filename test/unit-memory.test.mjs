// unit-memory.test.mjs —— 通用内存画像 + 合并适配的红能力判据。
// 泛化判据（对应用户硬约束「非某 agent 专项」）：两个不同宿主、不同学习值、同一请求 ⇒ 得到各自不同的分块。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MEM_DEFAULTS, memConfig, emptyStore, loadUnitMemory, saveUnitMemory, percentile,
  recordUnitPeak, unitEstimateMb, admitCount, fitBlocks, describeFit,
} from '../scripts/core/unit-memory.mjs';

const blk = (title, tasks = 1, dependsOn = [], hints = []) => ({
  title, type: 'parallel', dependsOn,
  tasks: Array.from({length: tasks}, (_, i) => ({id: `${title}-t${i}`, prompt: 'x', conflict_hints: hints})),
});

test('memConfig: generic defaults + env overrides', () => {
  const d = memConfig({});
  assert.equal(d.floorMb, 1000);
  assert.equal(d.defaultUnitMb, MEM_DEFAULTS.defaultUnitMb);
  assert.equal(d.safety, 1.3);
  const e = memConfig({ORCH_MIN_FREE_MEM_MB: '512', ORCH_UNIT_MEM_DEFAULT_MB: '800', ORCH_UNIT_MEM_SAFETY: '1.5', ORCH_UNIT_MEM_MIN_SAMPLES: '5'});
  assert.deepEqual(e, {floorMb: 512, defaultUnitMb: 800, safety: 1.5, minSamples: 5, blockGrowth: 0.15, maxTasksPerBlock: 0});
  const bad = memConfig({ORCH_MIN_FREE_MEM_MB: '-3', ORCH_UNIT_MEM_SAFETY: 'nope'});
  assert.equal(bad.floorMb, 1000);
  assert.equal(bad.safety, 1.3);
});

test('store: missing / garbage / wrong shape -> empty store (fail-open to defaults)', () => {
  assert.deepEqual(loadUnitMemory('Z:/definitely/missing.json'), emptyStore());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mem-'));
  const p1 = path.join(dir, 'bad.json');
  fs.writeFileSync(p1, '{not json');
  assert.deepEqual(loadUnitMemory(p1), emptyStore());
  const p2 = path.join(dir, 'shape.json');
  fs.writeFileSync(p2, JSON.stringify({schema: 1, agents: 'nope'}));
  assert.deepEqual(loadUnitMemory(p2), emptyStore());
});

test('store: record + persist round-trip + invalid peaks ignored + capped at 50', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mem-'));
  const file = path.join(dir, 'unit-memory.json');
  const store = emptyStore();
  recordUnitPeak(store, 'someagent', 321);
  recordUnitPeak(store, 'someagent', -5);       // 忽略
  recordUnitPeak(store, 'someagent', 'nope');   // 忽略
  assert.deepEqual(store.agents.someagent.peaks, [321]);
  for (let i = 0; i < 80; i += 1) recordUnitPeak(store, 'someagent', 100 + i);
  assert.equal(store.agents.someagent.peaks.length, 50);
  assert.equal(saveUnitMemory(file, store), true);
  assert.deepEqual(loadUnitMemory(file), store);
});

test('estimate: below minSamples -> generic default; at/above -> p90 * safety (host-agnostic)', () => {
  const cfg = memConfig({});
  const store = emptyStore();
  recordUnitPeak(store, 'a', 500);
  assert.equal(unitEstimateMb(store, 'a', cfg), MEM_DEFAULTS.defaultUnitMb);   // 样本不足 → 默认
  for (let i = 0; i < 19; i += 1) recordUnitPeak(store, 'a', 100);
  recordUnitPeak(store, 'a', 1000);                                             // 20 样本：19×100 + 1000 ⇒ p90=100 → 130
  assert.equal(percentile(store.agents.a.peaks, 0.9), 100);
  assert.equal(unitEstimateMb(store, 'a', cfg), 130);
  assert.equal(unitEstimateMb(store, 'unknown-agent', cfg), MEM_DEFAULTS.defaultUnitMb);
});

test('fit: ample memory -> zero merges (never merge what fits)', () => {
  const cfg = memConfig({});
  const plan = fitBlocks([blk('B1'), blk('B2'), blk('B3')], 10000, 100, cfg);
  assert.equal(plan.merges.length, 0);
  assert.equal(plan.blocks.length, 3);
  assert.equal(plan.fits, true);
});

test('fit: tight memory -> exactly the merges needed, floor respected (merged block costs 1+g)', () => {
  const cfg = memConfig({ORCH_MIN_FREE_MEM_MB: '256'});   // 本用例只验合并机制：显式钉余量，不受默认值漂移影响
  // free=500, unit=100: 3 块 est=300 > 244 ✗ → 并 1 对（成本 1.15）⇒ est=215 ≤ 285 ✓ 停
  const plan = fitBlocks([blk('B1'), blk('B2'), blk('B3')], 500, 100, cfg);
  assert.equal(plan.merges.length, 1);
  assert.equal(plan.blocks.length, 2);
  assert.equal(plan.estMb, 215);
  assert.equal(plan.blockGrowth, 0.15);
  assert.ok(plan.freeMb - plan.estMb >= cfg.floorMb);
});

test('fit: growth factor keeps merging profitable (g<1) and is clamped', () => {
  const g = memConfig({ORCH_UNIT_MEM_BLOCK_GROWTH: '5'}).blockGrowth;      // 超界 ⇒ 夹到 0.9
  assert.equal(g, 0.9);
  const off = memConfig({ORCH_UNIT_MEM_BLOCK_GROWTH: '0'}).blockGrowth;    // 允许显式关闭
  assert.equal(off, 0);
  const cfg = memConfig({ORCH_MIN_FREE_MEM_MB: '256'});   // 显式钉余量：本用例验的是增长系数
  // 4 块 ×1 任务 → 内存紧 ⇒ 并到 2 块：总账必须单调下降（400 → 315 → 230）
  const before = fitBlocks([blk('A'), blk('B'), blk('C'), blk('D')], 500, 100, cfg);
  assert.ok(before.estMb < 400, `merged estimate must drop below 400, got ${before.estMb}`);
  assert.equal(before.blocks.length, 2);
});

test('fit: idempotent — refitting a fitted plan changes nothing', () => {
  const cfg = memConfig({ORCH_MIN_FREE_MEM_MB: '256'});
  const once = fitBlocks([blk('A'), blk('B'), blk('C')], 500, 100, cfg);
  const twice = fitBlocks(once.blocks, 500, 100, cfg);
  assert.equal(twice.merges.length, 0);
  assert.deepEqual(twice.blocks, once.blocks);
  assert.equal(twice.estMb, once.estMb);
});

test('fit: extreme pressure -> collapses to one unit and honestly reports not fitting', () => {
  const cfg = memConfig({});
  const plan = fitBlocks([blk('B1'), blk('B2'), blk('B3')], 100, 100, cfg);
  assert.equal(plan.blocks.length, 1);
  assert.equal(plan.merges.length, 2);
  assert.equal(plan.fits, false);                  // 单块也贴不进去：不得假装能行
});

test('fit: merge order ①dependency -> ②conflict-hint -> ③largest', () => {
  const cfg = memConfig({});
  const dep = fitBlocks([blk('A'), blk('B', 1, ['A']), blk('C')], 500, 100, cfg);
  assert.equal(dep.merges[0].why, 'dependency');
  assert.deepEqual(dep.merges[0].merged, ['A', 'B']);
  const hint = fitBlocks([blk('A', 1, [], ['dir:x']), blk('B', 1, [], ['dir:x']), blk('C')], 500, 100, cfg);
  assert.equal(hint.merges[0].why, 'conflict-hint');
  const big = fitBlocks([blk('A', 3), blk('B', 1), blk('C', 1)], 500, 100, cfg);
  assert.equal(big.merges[0].why, 'largest');
  // 同权重 4 的对有两个（A+B、A+C）：取靠后者（尾部吸收溢出，与 capPlanBlocks 连续区段约定一致）。
  assert.deepEqual(big.merges[0].merged, ['A', 'C']);
});

test('fit: dependsOn rewiring keeps the graph intact after a merge', () => {
  const cfg = memConfig({ORCH_MIN_FREE_MEM_MB: '256'});   // 显式钉余量：本用例验的是依赖重连
  // B 依赖 A（先并 A+B）；C 依赖 A ⇒ 合并后 C 的依赖要改指合并块
  const plan = fitBlocks([blk('A'), blk('B', 1, ['A']), blk('C', 1, ['A'])], 500, 100, cfg);
  assert.equal(plan.blocks.length, 2);
  const merged = plan.blocks.find((b) => b.title.startsWith('fit-merged-'));
  const c = plan.blocks.find((b) => b.title === 'C');
  assert.ok(merged && c);
  assert.deepEqual(c.dependsOn, [merged.title]);
  assert.equal(merged.tasks.length, 2);
});

test('genericity: same request, two hosts with different learned profiles -> different plans', () => {
  const cfg = memConfig({});
  const b = () => [blk('B1'), blk('B2'), blk('B3'), blk('B4')];
  const lean = emptyStore();  for (let i = 0; i < 5; i += 1) recordUnitPeak(lean, 'light-host', 100);   // est=130
  const heavy = emptyStore(); for (let i = 0; i < 5; i += 1) recordUnitPeak(heavy, 'heavy-host', 800);  // est=1040
  const free = 3000;
  const a1 = fitBlocks(b(), free, unitEstimateMb(lean, 'light-host', cfg), cfg);
  const a2 = fitBlocks(b(), free, unitEstimateMb(heavy, 'heavy-host', cfg), cfg);
  assert.equal(a1.blocks.length, 4);               // 轻宿主：全并发
  assert.ok(a2.blocks.length < 4);                 // 重宿主：自动并块
  assert.notEqual(a1.blocks.length, a2.blocks.length);
});

test('admitCount: honest generalization of the retired formula (learned unit size, floor respected)', () => {
  const cfg = memConfig({});                       // floor=1000（默认余量）
  assert.equal(admitCount(2000, 500, cfg), 2);     // (2000−1000)/500 = 2.0 ⇒ 2
  assert.equal(admitCount(300, 500, cfg), 0);      // 贴不进去 ⇒ 0（等待，而不是硬开）
  assert.equal(admitCount(NaN, 500, cfg), 1);      // 读不到内存 ⇒ 保守给 1
});

test('admitCount: an explicit smaller floor admits more units (the knob still works)', () => {
  const cfg = memConfig({ORCH_MIN_FREE_MEM_MB: '256'});
  assert.equal(admitCount(2000, 500, cfg), 3);     // (2000−256)/500 = 3.488 ⇒ 3
});

test('fit is deterministic and described for logs', () => {
  const cfg = memConfig({ORCH_MIN_FREE_MEM_MB: '256'});
  const one = fitBlocks([blk('A'), blk('B'), blk('C')], 500, 100, cfg);
  const two = fitBlocks([blk('A'), blk('B'), blk('C')], 500, 100, cfg);
  assert.deepEqual(one, two);
  assert.match(describeFit(one), /^\[mem-fit\] units=2 unitMb=100 growth=0.15 estMb=215 freeMb=500 floorMb=256 fits=true merges=1:/);
});

test('fit: the default floor of 1000MB is reported verbatim in the log line', () => {
  const cfg = memConfig({});
  const r = fitBlocks([blk('A'), blk('B'), blk('C')], 2000, 100, cfg);
  assert.match(describeFit(r), /floorMb=1000 /);
});
