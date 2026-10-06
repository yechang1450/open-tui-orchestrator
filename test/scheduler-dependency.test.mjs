// 依赖调度回归：上游任务延迟完成时，下游必须自动放行，不得永久 blocked。
//
// 背景（exam-v4 实测）：T002 depends_on T001；T001 已 verified，但 T002 所在块被标
// blocked("Predecessors not verified: B1") 且 attempts=0 —— 从未启动。
// 源码定位：recovery.mjs:49 scheduleReady 是一轮 Promise.all + 单次前驱状态判定，
// runner.mjs:498 又把 blocked 当终态 ⇒ 误判后无任何重评路径。
//
// 本用例只验证【依赖图调度】本身，不涉及任何 agent。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {runWindows} from '../scripts/core/runner.mjs';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';
import {scheduleReady} from '../scripts/core/recovery.mjs';

// 用最小 recs 直测 scheduleReady 的语义：它必须等待前驱并按其最终状态决定。
test('downstream waits for a slow predecessor and runs when it verifies', async () => {
  const recs = [
    {key: 'B1', dependsOn: []},
    {key: 'B2', dependsOn: ['B1']},
  ];
  const status = {};
  const ran = [];
  const blocked = [];

  await scheduleReady(
    recs,
    async r => {                       // execute
      if (r.key === 'B1') {
        await new Promise(res => setTimeout(res, 120));   // 上游慢
        status['B1'] = 'verified';
      } else {
        ran.push(r.key);
        status[r.key] = 'verified';
      }
    },
    key => status[key],                // status 查询
    (r, failed) => { blocked.push({key: r.key, failed}); status[r.key] = 'blocked'; },
  );

  assert.deepEqual(blocked, [], 'slow-but-successful predecessor must not block the downstream');
  assert.deepEqual(ran, ['B2'], 'downstream must actually run after the predecessor verifies');
  assert.equal(status['B2'], 'verified');
});

test('downstream runs when predecessors were verified by an earlier generation', async () => {
  // 复现 exam-v4 的形态：块依赖引用了别名的 id（任务 id vs 块 id 混用）。
  // 这里保持 recs 合法（levelWaves 会校验未知依赖），只验证"前驱早已 verified"这一路径。
  const recs = [
    {key: 'B1', dependsOn: []},
    {key: 'B17', dependsOn: ['B1']},
  ];
  const status = {'B1': 'verified'};      // 上游在本代之前就已完成
  const ran = [];
  const blocked = [];

  await scheduleReady(
    recs,
    async r => { ran.push(r.key); status[r.key] = 'verified'; },
    key => status[key],
    (r, failed) => { blocked.push(r.key); status[r.key] = 'blocked'; },
  );

  assert.deepEqual(blocked, [], 'pre-verified predecessor must let the downstream run');
  assert.ok(ran.includes('B17'), 'downstream must run');
});

test('blocked is not a silently-accepted terminal for a runnable block', async () => {
  // 上游真失败时，下游被 blocked 是合理的；但本用例锁定"上游 verified 而下游仍 blocked"这一
  // exam-v4 的真实形态必须被排除。
  const recs = [
    {key: 'B1', dependsOn: []},
    {key: 'B2', dependsOn: ['B1']},
  ];
  const status = {'B1': 'verified'};
  let b2Blocked = false;

  await scheduleReady(
    recs,
    async r => { status[r.key] = 'verified'; },
    key => status[key],
    (r) => { if (r.key === 'B2') b2Blocked = true; status[r.key] = 'blocked'; },
  );

  assert.equal(b2Blocked, false, 'B2 must not be blocked when B1 is verified');
});

// exam-v4 的真凶形态：上游先进入中间态（popup-failed / needs-reconciliation），
// 之后靠重试恢复为 verified。这里显式建模两次调度波次：第一波允许下游看到
// 中间态并被阻塞，第二波必须重新检查前驱并放行下游；不能把前驱的重试和
// 状态读取塞进同一次 execute，否则测试无法观察真实回归。
test('a predecessor recovering between scheduling waves must release the downstream', async () => {
  const recs = [
    {key: 'B1', dependsOn: []},
    {key: 'B17', dependsOn: ['B1']},
  ];
  const status = {};
  const observed = [];
  const blocked = [];
  let b1Attempts = 0;
  const execute = async r => {
    if (r.key === 'B1') {
      b1Attempts += 1;
      if (b1Attempts === 1) {
        status.B1 = 'popup-failed';
        observed.push('B1-popup-failed');
      } else {
        status.B1 = 'verified';
        observed.push('B1-verified');
      }
    } else {
      status.B17 = 'verified';
      observed.push('B17-ran');
    }
  };
  const onBlocked = (r, failed) => {
    status[r.key] = 'blocked';
    blocked.push(`${r.key}(${failed.join(',')})`);
  };

  await scheduleReady(recs, execute, key => status[key], onBlocked);
  assert.deepEqual(blocked, ['B17(B1)'], 'the first wave must record the intermediate predecessor state');
  assert.ok(!observed.includes('B17-ran'), 'the dependent cannot run before recovery');

  await scheduleReady(recs, execute, key => status[key], onBlocked);
  const recovered = observed.indexOf('B1-verified');
  const downstream = observed.indexOf('B17-ran');
  assert.ok(recovered >= 0 && downstream > recovered,
    'the second wave must observe recovery before starting the dependent: ' + observed.join(','));
  assert.equal(b1Attempts, 2, 'the predecessor must have one failed and one recovery attempt');
});

test('runner orders dependent blocks through its own terminal path', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), 'temp', 'scheduler-runner-'));
  const acceptanceFile = path.join(root, 'acceptance.json');
  const launches = [];
  const attemptsByLauncher = new Map();
  fs.writeFileSync(acceptanceFile, JSON.stringify({
    T001: [{type: 'file', path: 'upstream.txt'}],
    T002: [{type: 'file', path: 'downstream.txt'}],
  }));
  const hooks = {
    compact: plan => plan,
    infer: () => [],
    prompt: prompt => prompt,
    launcher: (key, prompt, suffix) => {
      const checkpoint = /开始前："([^"]+checkpoint[.]cmd)"/.exec(prompt)?.[1];
      assert.ok(checkpoint, 'runner must deliver its checkpoint carrier to the launcher');
      const attempt = path.join(path.dirname(checkpoint), 'attempt.json');
      const pidf = path.join(root, `${suffix}.pid`);
      const lp = path.join(root, `${suffix}.ps1`);
      const rf = path.join(root, `${suffix}.result.json`);
      attemptsByLauncher.set(lp, {attempt, rf});
      launches.push(key);
      return {pidf, lp, rf, sanctionToken: 'test'};
    },
    spawn: async (lp) => {
      const entry = attemptsByLauncher.get(lp);
      assert.ok(entry, 'runner must spawn the launcher it just created');
      const attempt = JSON.parse(fs.readFileSync(entry.attempt, 'utf8'));
      for (const id of attempt.taskIds) recordCheckpoint(entry.attempt, id, 'started');
      const output = attempt.taskIds[0] === 'T001' ? 'upstream.txt' : 'downstream.txt';
      fs.writeFileSync(path.join(root, output), 'verified');
      for (const id of attempt.taskIds) recordCheckpoint(entry.attempt, id, 'completed');
      fs.writeFileSync(entry.rf, JSON.stringify({exitCode: 0}));
      return true;
    },
    readPid: () => 0,
    exitCode: file => JSON.parse(fs.readFileSync(file, 'utf8')).exitCode,
    session: async () => null,
    wait: async () => ({done: true, exitCode: 0}),
    register: () => {},
    commit: () => {},
    unregister: () => {},
    cleanup: () => {},
    close: async () => {},
    sweep: async () => {},
    guardian: () => {},
  };
  try {
    const sum = await runWindows('执行甲；执行乙', hooks, {
      workspace: root,
      capacity: 2,
      runId: 'scheduler-runner',
      acceptanceFile,
      coordinator: path.join(root, 'temp', 'coordinator'),
      auth: 'test',
      plan: [
        {title: 'upstream', type: 'independent', dependsOn: [], conflictKeys: [], tasks: [{prompt: '执行甲'}]},
        {title: 'downstream', type: 'independent', dependsOn: ['B1'], conflictKeys: [], tasks: [{prompt: '执行乙'}]},
      ],
    });
    assert.equal(sum.success, true, JSON.stringify(sum.results));
    assert.deepEqual(launches, ['B1', 'B2'], 'runner must launch the dependent block only after the predecessor is terminal');
    assert.equal(sum.results.B1.status, 'verified');
    assert.equal(sum.results.B2.status, 'verified');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
