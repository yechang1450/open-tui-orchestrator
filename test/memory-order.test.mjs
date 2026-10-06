import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {runWindows} from '../scripts/core/runner.mjs';
import {estimateBlockMemoryMb, memConfig} from '../scripts/core/unit-memory.mjs';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';

const tempRoot = path.resolve(process.cwd(), 'temp');

function makeAcceptance(ids) {
  return Object.fromEntries(ids.map((id) => [id, [{type: 'file', path: `${id}.txt`}]]));
}

// 这条用例真跑完整 runWindows（协调器进程快照 + 真 spawn + 真验收），单机耗时 ~27s。
// 套件以 --test-concurrency=3 并发跑，机器上另有负载（本机常见：Codex app-server 拉起的一批
// cua_node 沙箱）时会被拖到 4 倍以上；node:test 默认无超时，会以 'test failed' 收场而不是
// 报出真因。按仓库既有做法给一个 ~8x 单机成本的显式预算：这是预算，不是放宽断言。
const HEAVY_TEST_TIMEOUT_MS = 240000;

test('block memory estimate grows with the number of tasks in a block', () => {
  const cfg = memConfig({ORCH_UNIT_MEM_BLOCK_GROWTH: '0.15'});
  assert.equal(estimateBlockMemoryMb({tasks: [{}]}, 100, cfg), 100);
  assert.equal(estimateBlockMemoryMb({tasks: [{}, {}, {}]}, 100, cfg), 130);
});

test('runner launches higher estimated-memory blocks first while keeping the wave concurrent', {timeout: HEAVY_TEST_TIMEOUT_MS}, async () => {
  const workspace = fs.mkdtempSync(path.join(tempRoot, 'memory-order-'));
  // processSnapshot() 每次调用现读 ORCH_PS_TIMEOUT_MS（不是导入期缓存），所以这里设值有效。
  // 15s 默认是给正常桌面机器的；本用例在重载机器上会撞线，而 leases.mjs 的失败话术本身就
  // 指明出路是调大它（上限 120000）。这是预算，不是放宽断言。
  const previousPsTimeout = process.env.ORCH_PS_TIMEOUT_MS;
  process.env.ORCH_PS_TIMEOUT_MS = '120000';
  const acceptanceFile = path.join(workspace, 'acceptance.json');
  const launches = [];
  const attempts = new Map();
  let live = 0;
  let maxLive = 0;
  const request = 'low;high-a;high-b;high-c;mid-a;mid-b';
  const ids = ['T001', 'T002', 'T003', 'T004', 'T005', 'T006'];
  fs.writeFileSync(acceptanceFile, JSON.stringify(makeAcceptance(ids)));

  const hooks = {
    compact: plan => plan,
    infer: () => [],
    prompt: prompt => prompt,
    launcher: (key, prompt, suffix) => {
      const checkpoint = /开始前："([^"]+checkpoint[.]cmd)"/.exec(prompt)?.[1];
      assert.ok(checkpoint, 'runner must provide a checkpoint carrier');
      const attempt = path.join(path.dirname(checkpoint), 'attempt.json');
      const la = {
        pidf: path.join(workspace, `${key}-${suffix}.pid`),
        lp: path.join(workspace, `${key}-${suffix}.ps1`),
        rf: path.join(workspace, `${key}-${suffix}.result.json`),
      };
      attempts.set(la.lp, {attempt, rf: la.rf});
      return la;
    },
    register: () => { live += 1; maxLive = Math.max(maxLive, live); },
    commit: () => {},
    unregister: () => { live -= 1; },
    cleanup: () => {},
    close: async () => {},
    sweep: async () => {},
    readPid: () => 0,
    exitCode: file => JSON.parse(fs.readFileSync(file, 'utf8')).exitCode,
    session: async () => null,
    wait: async () => ({done: true, exitCode: 0}),
    spawn: async (lp) => {
      const entry = attempts.get(lp);
      assert.ok(entry, 'runner must spawn the launcher it just wrote');
      const attempt = JSON.parse(fs.readFileSync(entry.attempt, 'utf8'));
      launches.push(attempt.taskIds.join(','));
      for (const id of attempt.taskIds) recordCheckpoint(entry.attempt, id, 'started');
      for (const id of attempt.taskIds) {
        fs.writeFileSync(path.join(workspace, `${id}.txt`), 'verified');
        recordCheckpoint(entry.attempt, id, 'completed');
      }
      fs.writeFileSync(entry.rf, JSON.stringify({exitCode: 0}));
      await new Promise(resolve => setTimeout(resolve, 20));
      return true;
    },
  };

  try {
    const sum = await runWindows(request, hooks, {
      workspace,
      capacity: 3,
      runId: 'memory-order',
      acceptanceFile,
      coordinator: path.join(workspace, 'temp', 'coordinator'),
      auth: 'test',
      maxAttempts: 1,
      plan: [
        {title: 'low', type: 'independent', dependsOn: [], conflictKeys: [], tasks: [{prompt: 'low'}]},
        {title: 'high', type: 'independent', dependsOn: [], conflictKeys: [], tasks: [
          {prompt: 'high-a'}, {prompt: 'high-b'}, {prompt: 'high-c'},
        ]},
        {title: 'mid', type: 'independent', dependsOn: [], conflictKeys: [], tasks: [
          {prompt: 'mid-a'}, {prompt: 'mid-b'},
        ]},
      ],
    });
    assert.equal(sum.success, true, JSON.stringify(sum.results));
    assert.deepEqual(launches, ['T002,T003,T004', 'T005,T006', 'T001'],
      'same-wave blocks must launch from highest to lowest estimated memory');
    assert.equal(maxLive, 3, 'priority ordering must not serialize the ready wave');
  } finally {
    if (previousPsTimeout === undefined) delete process.env.ORCH_PS_TIMEOUT_MS;
    else process.env.ORCH_PS_TIMEOUT_MS = previousPsTimeout;
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});
