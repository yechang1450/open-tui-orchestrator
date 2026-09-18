import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runWindows} from '../scripts/core/runner.mjs';
import {powershellExe} from '../scripts/core/contracts.mjs';

// 2026-09-18 用户令：出现“偶发瞬时故障”必须自动检测 + 自动处理，而不是给调用方返回错误。
// 现场（claude 窗口单元实跑）：单元写了 started 检查点后秒退（exit 1），无终态检查点 —— 旧行为直接
// needs-reconciliation（把瞬时故障当结论）。新行为：瞬时特征成立时自动重跑一轮，重跑成功后正常记账。
// 三个判据：①瞬时 → 自动重跑并 success=true ②retrySafe:false → 明确否决，不重跑 ③运行时长超过
// 瞬时窗口的失败 → 不算瞬时，不重跑（防把“真失败”当瞬时掩盖）。

const family = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../temp');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function harness({workspace, runId, checksValue, shortLive = true, attempt1Ms = 0}) {
  const ps = powershellExe();
  const kids = [];
  let spawned = 0, attempt = 0;
  const checkpointHelper = fileURLToPath(new URL('../scripts/core/checkpoint.mjs', import.meta.url));
  const attemptFile = n => path.join(workspace, 'temp', 'orchestrator', 'runs', runId, 'attempts', 'B1', String(n), 'attempt.json');
  const launcherFor = key => {
    // 假启动器：活 3 秒（足够引擎完成身份绑定）后自然退出 ⇒ 下一轮循环取不到身份 ⇒ 走 recovery 而不是 adopt。
    const lp = path.join(workspace, 'win-launch-' + key + '.ps1');
    fs.writeFileSync(lp, 'Start-Sleep -Seconds 3\n', 'utf8');
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
      if (attempt === 1) {
        if (attempt1Ms) await sleep(attempt1Ms);
        spawnSync(process.execPath, [checkpointHelper, attemptFile(1), 'T001', 'started'], {windowsHide: true, timeout: 15000});
        return {done: false, exitCode: 1};                 // 启动即死：无终态检查点
      }
      fs.mkdirSync(path.join(workspace, 'proj-81'), {recursive: true});
      fs.writeFileSync(path.join(workspace, 'proj-81', 'alpha.txt'), 'ALPHA_OK', 'utf8');
      spawnSync(process.execPath, [checkpointHelper, attemptFile(attempt), 'T001', 'completed'], {windowsHide: true, timeout: 15000});
      fs.writeFileSync(rf, JSON.stringify({done: true, exitCode: 0}), 'utf8');
      return {done: true, exitCode: 0};
    },
    readPid: pidf => Number(fs.readFileSync(pidf, 'utf8').trim()),
    exitCode: () => 0,
    register: () => {}, unregister: () => {}, cleanup: () => {}, commit: () => {}, guardian: () => {},
    close: async () => {},
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

test('a transient unit failure (started-only checkpoint, quick exit) is auto-retried and can reach success', async () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'transient-ok-'));
  const h = harness({workspace, runId: 'transient-ok'});
  const prev = process.env.ORCH_TRANSIENT_BACKOFF_MS;
  process.env.ORCH_TRANSIENT_BACKOFF_MS = '0';
  try {
    const sum = await runWindows('执行甲', h.hooks, {workspace, capacity: 4, runId: 'transient-ok', auth: 'test', coordinator: path.join(workspace, 'temp', 'coordinator'), acceptanceFile: h.acceptanceFile, maxAttempts: 2, timeoutMs: 60000});
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

test('retrySafe:false vetoes the automatic transient retry (the escape hatch stays intact)', async () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'transient-veto-'));
  const h = harness({workspace, runId: 'transient-veto', checksValue: false});
  const prev = process.env.ORCH_TRANSIENT_BACKOFF_MS;
  process.env.ORCH_TRANSIENT_BACKOFF_MS = '0';
  try {
    const sum = await runWindows('执行甲', h.hooks, {workspace, capacity: 4, runId: 'transient-veto', auth: 'test', coordinator: path.join(workspace, 'temp', 'coordinator'), acceptanceFile: h.acceptanceFile, maxAttempts: 2, timeoutMs: 60000});
    assert.equal(sum.success, false, 'an explicit retrySafe:false must never be overridden by the transient path');
    assert.equal(h.attempts(), 1, 'no automatic retry may happen when the task vetoes it');
    assert.match(String(sum.results.B1.reason || ''), /Uncertain tasks/i);
  } finally {
    if (prev === undefined) delete process.env.ORCH_TRANSIENT_BACKOFF_MS; else process.env.ORCH_TRANSIENT_BACKOFF_MS = prev;
    await cleanup(workspace, h.kids);
  }
});

test('a long-running failure is not treated as transient (real failures are never masked)', async () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'transient-slow-'));
  const h = harness({workspace, runId: 'transient-slow', attempt1Ms: 1600});
  const prevBackoff = process.env.ORCH_TRANSIENT_BACKOFF_MS, prevWindow = process.env.ORCH_TRANSIENT_WINDOW_MS;
  process.env.ORCH_TRANSIENT_BACKOFF_MS = '0';
  process.env.ORCH_TRANSIENT_WINDOW_MS = '1000';
  try {
    const sum = await runWindows('执行甲', h.hooks, {workspace, capacity: 4, runId: 'transient-slow', auth: 'test', coordinator: path.join(workspace, 'temp', 'coordinator'), acceptanceFile: h.acceptanceFile, maxAttempts: 2, timeoutMs: 60000});
    assert.equal(sum.success, false, 'a failure that ran well past the transient window must stay surfaced');
    assert.equal(h.attempts(), 1, 'no transient retry may be granted outside the window');
  } finally {
    if (prevBackoff === undefined) delete process.env.ORCH_TRANSIENT_BACKOFF_MS; else process.env.ORCH_TRANSIENT_BACKOFF_MS = prevBackoff;
    if (prevWindow === undefined) delete process.env.ORCH_TRANSIENT_WINDOW_MS; else process.env.ORCH_TRANSIENT_WINDOW_MS = prevWindow;
    await cleanup(workspace, h.kids);
  }
});
