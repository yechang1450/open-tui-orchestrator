import {test} from 'node:test';
import assert from 'node:assert/strict';
process.env.ORCH_AGENT='codex';
const {buildBlocksFromTasks, windowExecutionPolicy, levelWaves, capPlanBlocks, classifyPrompt, plannerPrompt, plannerBlockCeiling} = await import('../scripts/orchestrate-sdk.mjs');

const t = (id, summary, hints, extra = {}) => ({ id, summary, project: '80', kind: 'project', conflict_hints: hints, ...extra });

test('project split: 同项目任务资源两两不相交 -> 各自成块可并行', () => {
  const plan = buildBlocksFromTasks([
    t('T001', '修复80登录页', ['file:build/80/src/login.js']),
    t('T002', '优化80商品列表', ['file:build/80/src/goods.js']),
    t('T003', '修80订单导出', ['file:build/80/src/order.js']),
  ]);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map(b => b.title), ['proj-80-1', 'proj-80-2', 'proj-80-3']);
  for (const b of plan) {
    assert.equal(b.type, 'independent');
    assert.deepEqual(b.dependsOn, []);
    assert.ok(!b.conflictKeys.some(k => k.startsWith('dir:proj-')), 'split blocks must not carry the project dir key (siblings would re-serialize)');
    assert.equal(b.conflictKeys.length, 1);
    assert.equal(b.tasks.length, 1);
    assert.match(b.tasks[0].prompt, /只改动本块任务涉及的文件\/资源/);
  }
  // 开窗策略：同 wave 3 块 -> windows 模式
  const policy = windowExecutionPolicy(plan);
  assert.equal(policy.mode, 'windows');
  assert.equal(policy.windowCount, 3);
});

test('project split: hints 相同的同项目任务保持单块串行（dir 键兜底）', () => {
  const plan = buildBlocksFromTasks([
    t('T001', '修80登录校验', ['file:build/80/src/login.js']),
    t('T002', '改80登录样式', ['file:build/80/src/login.js']),
  ]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].title, 'proj-80');
  assert.ok(plan[0].conflictKeys.includes('dir:proj-80'));
  assert.match(plan[0].tasks[0].prompt, /修80登录校验；改80登录样式/);
  assert.equal(windowExecutionPolicy(plan).mode, 'inline');
});

test('project split: 任一任务 hints 为空 -> 全组串行（有一个说不清就不拆）', () => {
  const plan = buildBlocksFromTasks([
    t('T001', '修80登录页', ['file:build/80/src/login.js']),
    t('T002', '收拾一下80', []),
  ]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].title, 'proj-80');
  assert.ok(plan[0].conflictKeys.includes('dir:proj-80'));
});

test('project split: hints 全部纠缠成一簇 -> 单块（与拆分前一致）', () => {
  const plan = buildBlocksFromTasks([
    t('T001', '改80订单模型', ['file:build/80/src/order-model.js']),
    t('T002', '改80订单服务', ['file:build/80/src/order-model.js', 'file:build/80/src/order-service.js']),
    t('T003', '改80订单导出', ['file:build/80/src/order-service.js']),
  ]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].title, 'proj-80');
});

test('project split: 部分重叠 -> 重叠者同块、独立者另起块', () => {
  const plan = buildBlocksFromTasks([
    t('T001', '改80登录校验', ['file:build/80/src/login.js']),
    t('T002', '改80登录限流', ['file:build/80/src/login.js']),
    t('T003', '改80商品搜索', ['file:build/80/src/goods-search.js']),
  ]);
  assert.equal(plan.length, 2);
  const merged = plan.find(b => b.title === 'proj-80-1');
  assert.match(merged.tasks[0].prompt, /改80登录校验；改80登录限流/);
  assert.deepEqual(plan.find(b => b.title === 'proj-80-2').conflictKeys, ['file:build/80/src/goods-search.js']);
});

test('project split: depends_on 不合并，拆成两块并以 dependsOn 保序', () => {
  const plan = buildBlocksFromTasks([
    t('T001', '先改80的order模型', ['file:build/80/src/order-model.js']),
    t('T002', '再改80的order导出', ['file:build/80/src/order-export.js'], { depends_on: ['T001'] }),
  ]);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[1].dependsOn, ['proj-80-1']);
  const waves = levelWaves(plan.map((b, i) => ({ key: 'B' + (i + 1), title: b.title, b, dependsOn: b.dependsOn })));
  assert.equal(waves.length, 2, 'dependency must serialize the two sub-blocks into two waves');
  assert.equal(windowExecutionPolicy(plan).mode, 'inline', 'pure serial chain stays inline');
});

test('project split: 单任务项目行为不变（title/keys 与拆分前一致）', () => {
  const plan = buildBlocksFromTasks([t('T001', '修80登录页', ['file:build/80/src/login.js'])]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].title, 'proj-80');
  assert.deepEqual(plan[0].conflictKeys, ['dir:proj-80', 'file:build/80/src/login.js']);
});

test('project split: 跨项目分组互不影响', () => {
  const plan = buildBlocksFromTasks([
    { id: 'T001', summary: '修80登录页', project: '80', kind: 'project', conflict_hints: ['file:build/80/src/login.js'] },
    { id: 'T002', summary: '修80商品页', project: '80', kind: 'project', conflict_hints: ['file:build/80/src/goods.js'] },
    { id: 'T003', summary: '修81登录页', project: '81', kind: 'project', conflict_hints: ['file:build/81/src/login.js'] },
  ]);
  assert.equal(plan.length, 3);
  const p81 = plan.find(b => b.title === 'proj-81');
  assert.ok(p81, 'single-task project keeps its unsplit title');
  assert.ok(p81.conflictKeys.includes('dir:proj-81'));
});

test('project split: 拆分计划过 capPlanBlocks 后任务账本不丢', () => {
  const plan = buildBlocksFromTasks([
    t('T001', '修80登录页', ['file:build/80/src/login.js']),
    t('T002', '修80商品页', ['file:build/80/src/goods.js']),
    t('T003', '修80订单页', ['file:build/80/src/order.js']),
  ]);
  const capped = capPlanBlocks(plan, 2);
  assert.equal(capped.length, 2);
  assert.equal(capped.flatMap(b => b.tasks).length, 3, 'capacity compaction must not drop tasks');
});

test('classifyPrompt: 要求 project 任务给出精确 conflict_hints（可并行拆分）', () => {
  const p = classifyPrompt('修80登录页；优化80商品列表', {});
  assert.match(p, /并行窗口/);
  assert.match(p, /不许偷懒留空/);
});

// 回归（2026-09-22 真机抓到）：0.9.17（1d79ea1）把固定容量公式换成内存拟合时删掉了 maxWindows 变量，
// 却把模板里的 ${maxWindows} 留在原地 —— 于是**每一次** LLM 拆块都在拼提示词时抛 ReferenceError，
// 又被 decomposeSafely 的 retry 循环吞成「模型失败」→ 静默退化成单串行块，并行能力整段失效。
// 判据可红：提示词里混进 undefined / 上限不是正整数，两种情况都会让这两条用例失败。
test('plannerPrompt: 块数上限是正整数，且提示词里绝不出现 undefined', () => {
  const ceiling = plannerBlockCeiling();
  assert.ok(Number.isInteger(ceiling) && ceiling >= 1, '块数上限必须是 ≥1 的整数，实测 ' + JSON.stringify(ceiling));
  const p = plannerPrompt('修80登录页；优化80商品列表', {});
  assert.match(p, /Maximum execution blocks: [1-9]\d*\./, '提示词必须带上具体的块数上限');
  assert.doesNotMatch(p, /undefined|NaN|null 块/, '拼提示词时混进了未定义值（悬空标识符回归）');
});

test('plannerPrompt: 仍是 classifyPrompt 的超集（不另起一份定性提示词）', () => {
  const hints = {moduleToProj: {登录: '82'}};
  const p = plannerPrompt('修82登录页', hints);
  assert.ok(p.startsWith(classifyPrompt('修82登录页', hints)), '必须在原定性提示词之后追加块数上限，不许分叉');
  assert.match(p, /Return ALL tasks; overflow tasks will be merged into serial blocks/);
});
