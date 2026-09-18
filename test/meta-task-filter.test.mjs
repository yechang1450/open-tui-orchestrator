import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isMetaOnlyTask, requestTasks} from '../scripts/core/contracts.mjs';

// 0.9.16（2026-09-18 验收实测）：提示词规则对真模型不总是生效——「必须按上述顺序执行：…」在 0.9.15
// 上仍被建成 T003。确定性兜底：元句在 requestTasks 阶段就被剔除（bind/classify/ledger 全从它派生，
// 一处修全链一致）。
test('meta-only sentences are recognised, real actions survive', () => {
  assert.equal(isMetaOnlyTask('必须按上述顺序执行：项目82的产物依赖项目81的产物。'), true);
  assert.equal(isMetaOnlyTask('以上任务请依次完成'), true);
  assert.equal(isMetaOnlyTask('注意执行先后依赖'), false, 'no 上述/以上 anchor => not touched (avoid false positives)');
  assert.equal(isMetaOnlyTask('请按上述顺序修复项目81的登录页'), false, 'a real action must survive the filter');
  assert.equal(isMetaOnlyTask('先完成项目81的任务：生成 proj-81/dep-src.txt'), false);
});

test('requestTasks drops the meta sentence but keeps every real task (and never empties the inventory)', () => {
  const req = '先完成项目81的任务：在工作目录生成 proj-81/dep-src.txt，内容严格为 DEP_SRC_OK；\n然后完成项目82的任务：读取 proj-81/dep-src.txt 的内容，把同样的内容写入 proj-82/dep-copy.txt。\n必须按上述顺序执行：项目82的产物依赖项目81的产物。';
  const tasks = requestTasks(req);
  assert.equal(tasks.length, 2, 'the meta sentence must not become its own task: ' + JSON.stringify(tasks.map((t) => t.id)));
  assert.ok(tasks.every((t) => !/必须按上述顺序/.test(t.prompt)), 'no task may carry the meta sentence');
  const only = requestTasks('必须按上述顺序执行');
  assert.equal(only.length, 1, 'an all-meta request must keep its single task (never empty the inventory)');
});
