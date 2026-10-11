import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runWindows} from '../scripts/core/runner.mjs';
import {powershellExe} from '../scripts/core/contracts.mjs';

// 2026-09-18 用户令：出现“偶发瞬时故障”必须自动检测 + 自动处理，而不是给调用方返回错误。
// 现场（窗口单元实跑）：单元写了 started 检查点后秒退（exit 1），无终态检查点 —— 旧行为直接
// needs-reconciliation（把瞬时故障当结论）。新行为：瞬时特征成立时自动重跑一轮，重跑成功后正常记账。
// 三个判据：①瞬时 → 自动重跑并 success=true ②retrySafe:false → 明确否决，不重跑 ③运行时长超过
// 瞬时窗口的失败 → 不算瞬时，不重跑（防把“真失败”当瞬时掩盖）。

const family = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../temp');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function harness({workspace, runId, checksValue, shortLive = true, attempt1Ms = 0, attempt1NoCheckpoint = false, failTimes = 1, allFail = false, slowFails = false}) {
  const ps = powershellExe();
  const kids = [];
  let spawned = 0, attempt = 0;
  const checkpointHelper = fileURLToPath(new URL('../scripts/core/checkpoint.mjs', import.meta.url));
  const attemptFile = n => path.join(workspace, 'temp', 'orchestrator', 'runs', runId, 'attempts', 'B1', String(n), 'attempt.json');
  const launcherFor = key => {
    // 假启动器：活 3 秒（足够引擎完成身份绑定）后自然退出 ⇒ 下一轮循环取不到身份 ⇒ 走 recovery 而不是 adopt。
    const lp = path.join(workspace, 'win-launch-' + key + '.ps1');
    fs.writeFileSync(lp, 'Start-Sleep -Seconds 30\n', 'utf8');
    const pidf = path.join(workspace, 'window-' + key + '.pid');
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', lp], {windowsHide: true, stdio: 'ignore'});
    kids.push(child);
    fs.writeFileSync(pidf, String(child.pid), 'utf8');
    return {lp, pidf, rf: path.join(workspace, 'win-' + key + '.result.json')};
  };
  const hooks = {
    plan: async () => [{title: 'A', tasks: [{prompt: '执行甲'}]}],
    compact: p => p, infer: () => [], prompt: p => p,
    launcher: launcherFor,
    spawn: async () => { spawned++; return true; },
    // 真宿主会话文件（存在但不更新）⇒ 走 waitWithStallWatchdog ⇒ 真正调用 wait（假单元的执行时点）。
    session: async () => sessionFile,
    wait: async (session, timeoutMs, rf, token) => {
      attempt++;
      if (allFail || attempt <= failTimes) {
        const failMs = attempt === 1 ? attempt1Ms : (slowFails ? attempt1Ms : 0);
        if (failMs) await sleep(failMs);
        if (!attempt1NoCheckpoint) spawnSync(process.execPath, [checkpointHelper, attemptFile(attempt), 'T001', 'started'], {windowsHide: true, timeout: 15000});
        return {done: false, exitCode: 1};                 // 启动即死：无终态检查点
      }
      fs.mkdirSync(path.join(workspace, 'proj-81'), {recursive: true});
      fs.writeFileSync(path.join(workspace, 'proj-81', 'alpha.txt'), 'ALPHA_OK', 'utf8');
      // 契约要求 started → completed 顺序（缺 started 时 completed 会被检查点工具拒绝）。
      spawnSync(process.execPath, [checkpointHelper, attemptFile(attempt), 'T001', 'started'], {windowsHide: true, timeout: 15000});
      spawnSync(process.execPath, [checkpointHelper, attemptFile(attempt), 'T001', 'completed'], {windowsHide: true, timeout: 15000});
      fs.writeFileSync(rf, JSON.stringify({done: true, exitCode: 0}), 'utf8');
      return {done: true, exitCode: 0};
    },
    readPid: pidf => Number(fs.readFileSync(pidf, 'utf8').trim()),
    exitCode: () => 0,
    register: () => {}, unregister: () => {}, cleanup: () => {}, commit: () => {}, guardian: () => {},
    close: async pid => {
      const child = kids.find(item => item.pid === pid);
      if (child) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {windowsHide: true, timeout: 10000}); } catch {} }
    },
  };
  const acceptanceFile = path.join(workspace, 'acceptance.json');
  const sessionFile = path.join(workspace, 'fake-session.jsonl');
  fs.writeFileSync(sessionFile, 'start\n', 'utf8');
  fs.writeFileSync(acceptanceFile, JSON.stringify({
    T001: {checks: [{type: 'file', path: 'proj-81/alpha.txt'}], ...(checksValue === undefined ? {} : {retrySafe: checksValue})},
  }), 'utf8');
  return {hooks, acceptanceFile, kids, spawned: () => spawned, attempts: () => attempt};
}

async function cleanup(workspace, kids) {
  for (const kid of kids) { try { spawnSync('taskkill', ['/PID', String(kid.pid), '/T', '/F'], {windowsHide: true, timeout: 10000}); } catch { /* best effort */ } }
  await sleep(200);
  fs.rmSync(workspace, {recursive: true, force: true});
}

test('a transient unit failure (started-only checkpoint, quick exit) is auto-retried and can reach success', {timeout: 240000}, async () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'transient-ok-'));
  const h = harness({workspace, runId: 'transient-ok'});
  const prev = process.env.ORCH_TRANSIENT_BACKOFF_MS;
  process.env.ORCH_TRANSIENT_BACKOFF_MS = '0';
  try {
    const sum = await runWindows('执行甲', h.hooks, {workspace, capacity: 4, runId: 'transient-ok', auth: 'test', coordinator: path.join(workspace, 'temp', 'coordinator'), acceptanceFile: h.acceptanceFile, maxAttempts: 2, timeoutMs: 180000});
    assert.equal(sum.success, true, 'a transient failure must be absorbed, not surfaced as an error');
    assert.ok(h.attempts() >= 2, 'the engine must auto-retry the transient failure');
    assert.ok(sum.results.B1.attempts.length >= 2, 'the retry must be recorded in the ledger');
    assert.ok((sum.results.B1.transientRetries || 0) >= 1, 'the ledger must show the transient auto-retry count');
    assert.match(String(sum.results.B1.transientReason || ''), /no terminal checkpoint/i);
  } finally {
    if (prev === undefined) delete process.env.ORCH_TRANSIENT_BACKOFF_MS; else process.env.ORCH_TRANSIENT_BACKOFF_MS = prev;
    await cleanup(workspace, h.kids);
  }
});

test('retrySafe:false vetoes the automatic transient retry (the escape hatch stays intact)', {timeout: 180000}, async () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'transient-veto-'));
  const h = harness({workspace, runId: 'transient-veto', checksValue: false});
  const prev = process.env.ORCH_TRANSIENT_BACKOFF_MS;
  process.env.ORCH_TRANSIENT_BACKOFF_MS = '0';
  try {
    const sum = await runWindows('执行甲', h.hooks, {workspace, capacity: 4, runId: 'transient-veto', auth: 'test', coordinator: path.join(workspace, 'temp', 'coordinator'), acceptanceFile: h.acceptanceFile, maxAttempts: 2, timeoutMs: 180000});
    assert.equal(sum.success, false, 'an explicit retrySafe:false must never be overridden by the transient path');
    assert.equal(h.attempts(), 1, 'no automatic retry may happen when the task vetoes it');
    assert.match(String(sum.results.B1.reason || ''), /Uncertain tasks/i);
  } finally {
    if (prev === undefined) delete process.env.ORCH_TRANSIENT_BACKOFF_MS; else process.env.ORCH_TRANSIENT_BACKOFF_MS = prev;
    await cleanup(workspace, h.kids);
  }
});

test('a long-running failure gets exactly one unproven retry, then stays surfaced (no infinite masking)', {timeout: 240000}, async () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'transient-slow-'));
  const h = harness({workspace, runId: 'transient-slow', attempt1Ms: 1600, allFail: true, slowFails: true});
  const prevBackoff = process.env.ORCH_TRANSIENT_BACKOFF_MS, prevWindow = process.env.ORCH_TRANSIENT_WINDOW_MS;
  process.env.ORCH_TRANSIENT_BACKOFF_MS = '0';
  process.env.ORCH_TRANSIENT_WINDOW_MS = '1000';
  try {
    const sum = await runWindows('执行甲', h.hooks, {workspace, capacity: 4, runId: 'transient-slow', auth: 'test', coordinator: path.join(workspace, 'temp', 'coordinator'), acceptanceFile: h.acceptanceFile, maxAttempts: 2, timeoutMs: 180000});
    assert.equal(sum.success, false, 'a failure that keeps failing must stay surfaced');
    assert.equal(h.attempts(), 2, 'exactly one unproven retry may be granted, never an infinite loop');
    assert.ok((sum.results.B1.unprovenRetries || 0) >= 1, 'the ledger must show the unproven auto-retry count');
  } finally {
    if (prevBackoff === undefined) delete process.env.ORCH_TRANSIENT_BACKOFF_MS; else process.env.ORCH_TRANSIENT_BACKOFF_MS = prevBackoff;
    if (prevWindow === undefined) delete process.env.ORCH_TRANSIENT_WINDOW_MS; else process.env.ORCH_TRANSIENT_WINDOW_MS = prevWindow;
    await cleanup(workspace, h.kids);
  }
});

// 2026-09-18（codex 现场）：单元整轮“只说不干”——连一个检查点都没写（T002 从未 started），
// 普通预算 1 次用尽就会把失败甩给调用方。新行为：无产出特征成立时自动补一次重试（可 env 关）。
test('a unit that never writes ANY checkpoint is auto-retried once beyond the plain attempt budget', {timeout: 240000}, async () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'unproductive-'));
  const h = harness({workspace, runId: 'unproductive', attempt1NoCheckpoint: true});
  const prevBackoff = process.env.ORCH_TRANSIENT_BACKOFF_MS;
  process.env.ORCH_TRANSIENT_BACKOFF_MS = '0';
  try {
    const sum = await runWindows('执行甲', h.hooks, {workspace, capacity: 4, runId: 'unproductive', auth: 'test', coordinator: path.join(workspace, 'temp', 'coordinator'), acceptanceFile: h.acceptanceFile, maxAttempts: 1, timeoutMs: 180000});
    assert.equal(sum.success, true, 'a no-checkpoint (talked-but-did-nothing) attempt must be auto-retried, not surfaced; B1=' + JSON.stringify(sum.results.B1).slice(0, 700) + ' T001=' + JSON.stringify(sum.taskResults.T001).slice(0, 300));
    assert.ok(h.attempts() >= 2, 'the unproductive attempt must be re-run beyond the plain attempt budget');
    assert.ok((sum.results.B1.unproductiveRetries || 0) >= 1, 'the ledger must show the unproductive auto-retry count');
  } finally {
    if (prevBackoff === undefined) delete process.env.ORCH_TRANSIENT_BACKOFF_MS; else process.env.ORCH_TRANSIENT_BACKOFF_MS = prevBackoff;
    await cleanup(workspace, h.kids);
  }
});

// 2026-10-11 用户口径（第三档·无成果重跑）：单元“跑了一阵、既没有已证成果、也没声明可重跑”时，
// 不再把“不确定”直接当结论 —— 自动补跑一次（走同一条窗口流水线；独立预算可关；veto 照旧）。
test('a slow failure with no proven result is auto-retried once (third recovery tier)', {timeout: 240000}, async () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'unproven-ok-'));
  const h = harness({workspace, runId: 'unproven-ok', attempt1Ms: 1600});
  const prevBackoff = process.env.ORCH_TRANSIENT_BACKOFF_MS, prevWindow = process.env.ORCH_TRANSIENT_WINDOW_MS;
  process.env.ORCH_TRANSIENT_BACKOFF_MS = '0';
  process.env.ORCH_TRANSIENT_WINDOW_MS = '1000';
  try {
    const sum = await runWindows('执行甲', h.hooks, {workspace, capacity: 4, runId: 'unproven-ok', auth: 'test', coordinator: path.join(workspace, 'temp', 'coordinator'), acceptanceFile: h.acceptanceFile, maxAttempts: 2, timeoutMs: 180000});
    assert.equal(sum.success, true, 'the unproven attempt must be re-run, not surfaced; B1=' + JSON.stringify(sum.results.B1).slice(0, 700));
    assert.ok(h.attempts() >= 2, 'the unproven attempt must be re-run beyond the plain attempt budget');
    assert.ok((sum.results.B1.unprovenRetries || 0) >= 1, 'the ledger must show the unproven auto-retry count');
  } finally {
    if (prevBackoff === undefined) delete process.env.ORCH_TRANSIENT_BACKOFF_MS; else process.env.ORCH_TRANSIENT_BACKOFF_MS = prevBackoff;
    if (prevWindow === undefined) delete process.env.ORCH_TRANSIENT_WINDOW_MS; else process.env.ORCH_TRANSIENT_WINDOW_MS = prevWindow;
    await cleanup(workspace, h.kids);
  }
});

test('retrySafe:false still vetoes the unproven retry (the escape hatch stays intact)', {timeout: 180000}, async () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'unproven-veto-'));
  const h = harness({workspace, runId: 'unproven-veto', attempt1Ms: 1600, checksValue: false});
  const prevBackoff = process.env.ORCH_TRANSIENT_BACKOFF_MS, prevWindow = process.env.ORCH_TRANSIENT_WINDOW_MS;
  process.env.ORCH_TRANSIENT_BACKOFF_MS = '0';
  process.env.ORCH_TRANSIENT_WINDOW_MS = '1000';
  try {
    const sum = await runWindows('执行甲', h.hooks, {workspace, capacity: 4, runId: 'unproven-veto', auth: 'test', coordinator: path.join(workspace, 'temp', 'coordinator'), acceptanceFile: h.acceptanceFile, maxAttempts: 2, timeoutMs: 180000});
    assert.equal(sum.success, false, 'an explicit retrySafe:false must never be overridden by the unproven path');
    assert.equal(h.attempts(), 1, 'no automatic retry may happen when the task vetoes it');
    assert.match(String(sum.results.B1.reason || ''), /Uncertain tasks/i);
  } finally {
    if (prevBackoff === undefined) delete process.env.ORCH_TRANSIENT_BACKOFF_MS; else process.env.ORCH_TRANSIENT_BACKOFF_MS = prevBackoff;
    if (prevWindow === undefined) delete process.env.ORCH_TRANSIENT_WINDOW_MS; else process.env.ORCH_TRANSIENT_WINDOW_MS = prevWindow;
    await cleanup(workspace, h.kids);
  }
});

test('ORCH_UNPROVEN_RETRIES=0 disables the third tier (old behavior stays available)', {timeout: 180000}, async () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'unproven-off-'));
  const h = harness({workspace, runId: 'unproven-off', attempt1Ms: 1600});
  const prevBackoff = process.env.ORCH_TRANSIENT_BACKOFF_MS, prevWindow = process.env.ORCH_TRANSIENT_WINDOW_MS, prevUnproven = process.env.ORCH_UNPROVEN_RETRIES;
  process.env.ORCH_TRANSIENT_BACKOFF_MS = '0';
  process.env.ORCH_TRANSIENT_WINDOW_MS = '1000';
  process.env.ORCH_UNPROVEN_RETRIES = '0';
  try {
    const sum = await runWindows('执行甲', h.hooks, {workspace, capacity: 4, runId: 'unproven-off', auth: 'test', coordinator: path.join(workspace, 'temp', 'coordinator'), acceptanceFile: h.acceptanceFile, maxAttempts: 2, timeoutMs: 180000});
    assert.equal(sum.success, false, 'with the budget closed the failure must surface as before');
    assert.equal(h.attempts(), 1, 'no automatic retry may happen when ORCH_UNPROVEN_RETRIES=0');
  } finally {
    if (prevBackoff === undefined) delete process.env.ORCH_TRANSIENT_BACKOFF_MS; else process.env.ORCH_TRANSIENT_BACKOFF_MS = prevBackoff;
    if (prevWindow === undefined) delete process.env.ORCH_TRANSIENT_WINDOW_MS; else process.env.ORCH_TRANSIENT_WINDOW_MS = prevWindow;
    if (prevUnproven === undefined) delete process.env.ORCH_UNPROVEN_RETRIES; else process.env.ORCH_UNPROVEN_RETRIES = prevUnproven;
    await cleanup(workspace, h.kids);
  }
});
