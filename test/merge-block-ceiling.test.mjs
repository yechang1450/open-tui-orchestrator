// X4 修复判据：内存合并不得把单块题数并到超过给定上限。
//
// 背景（exam-v6 五轮实测的 [mem-fit] 行）：
//   kimi     unitMb= 546  merges=none
//   hermes   unitMb= 424  merges=none
//   pi       unitMb= 282  merges=none
//   opencode unitMb= 995  merges=1:largest(proj-01+proj-02) … ⇒ 19 题并成 8 块（B1 吞 12 题）
//   codex    unitMb=1528  merges=…                         ⇒ 19 题并成 4 块（B1 = fit-merged-16）
//
// 根因：unit-memory.mjs fitBlocks 的 while 只有「只剩1块 / 内存够」两个退出条件，
//      pickPair 第三优先级为 largest ⇒ 内存紧时一路并到 1 块，无题数上限。
// 规划层本有上限（orchestrate-sdk.mjs plannerBlockCeiling = auxAdmissionLimit(0)、capPlanBlocks 按 capacity 等分），
// 但 fitBlocks 在计划成型后还会再压一次，把它压回巨块 —— 两者目标冲突。
//
// 本用例用纯函数直测 fitBlocks，不启动任何 agent。
import test from 'node:test';
import assert from 'node:assert/strict';
import {fitBlocks} from '../scripts/core/unit-memory.mjs';

const mk = (title, n) => ({title, type: 'independent', dependsOn: [], tasks: Array.from({length: n}, (_, i) => ({id: `${title}-t${i + 1}`}))});

test('内存紧张时会合并（前置事实：不合并则本用例无意义）', () => {
  const blocks = [mk('proj-01', 10), mk('proj-02', 10), mk('proj-03', 10)];
  const res = fitBlocks(blocks, /*freeMb*/ 3000, /*unitMb*/ 600, {floorMb: 1000, blockGrowth: 0.15});
  assert.ok(res.merges.length > 0, '内存不够时应发生合并（否则说明前置条件不成立）');
});

test('给定 maxTasksPerBlock 时，合并不得越过该上限', () => {
  // 数据必须能产生**真实合并**：10/10/10@12 时 fitBlocks 只记 why:'ceiling' 的空转（sizes 不变），
  // 「cap>0 直接返回原块」的退化实现也能通过全部断言。7/7/5@12 实测 largest(p1+p3) → 12,7。
  const blocks = [mk('proj-01', 7), mk('proj-02', 7), mk('proj-03', 5)];
  const ceiling = 12;
  const res = fitBlocks(blocks, /*freeMb*/ 3000, /*unitMb*/ 600,
    {floorMb: 1000, blockGrowth: 0.15, maxTasksPerBlock: ceiling});
  assert.ok(res.merges.some((m) => m.why !== 'ceiling' && m.merged.length > 0),
    '必须发生真实合并，否则上限断言无意义: ' + JSON.stringify(res.merges));
  const biggest = Math.max(...res.blocks.map((b) => (b.tasks || []).length));
  assert.ok(biggest <= ceiling,
    `单块题数不得超过 ${ceiling}，实际最大 ${biggest}（块划分：${res.blocks.map((b) => (b.tasks || []).length).join(',')}）`);
});

test('未设上限（0/缺省）时保持原行为，向后兼容', () => {
  const blocks = [mk('proj-01', 10), mk('proj-02', 10), mk('proj-03', 10)];
  const a = fitBlocks(blocks, 3000, 600, {floorMb: 1000, blockGrowth: 0.15});
  const b = fitBlocks(blocks, 3000, 600, {floorMb: 1000, blockGrowth: 0.15, maxTasksPerBlock: 0});
  assert.deepEqual(a.blocks.map((x) => x.tasks.length), b.blocks.map((x) => x.tasks.length),
    '上限为 0 或缺省时行为必须与不传时一致（零回归）');
});
