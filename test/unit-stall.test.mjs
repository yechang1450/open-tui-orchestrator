import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runWindows} from '../scripts/core/runner.mjs';
import {powershellExe} from '../scripts/core/contracts.mjs';

const family = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../temp');

// 2026-09-17 用户令：僵死单元不许让调用方手动 Ctrl-D 退出——要自动检测、自动关窗、自动重跑。
// 现场（codex 额度耗尽）：agent 进程活着，但会话/检查点/结果文件都不再前进，旧代码会一直等到
// 运行上限（默认 6h）。本判据用一个真的 powershell 假启动器（睡 600s）+ 永不 resolve 的 wait 钩子
// 造出同一现场，要求：① 停滞被判定（账本 reason 带 stalled）② 单元树被强制收口 ③ 块在预算内自动重跑。
test('a live-but-silent unit stalls out, is force-closed and retried instead of hanging until the run deadline', async () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'unit-stall-'));
  const ps = powershellExe();
  const kids = [];
  let spawned = 0, closed = 0;
  const launcherFor = key => {
    const lp = path.join(workspace, 'win-launch-' + key + '-stall.ps1');
    fs.writeFileSync(lp, 'Start-Sleep -Seconds 600\n', 'utf8');
    const pidf = path.join(workspace, 'window-' + key + '-stall.pid');
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', lp], {windowsHide: true, stdio: 'ignore'});
    kids.push(child);
    fs.writeFileSync(pidf, String(child.pid), 'utf8');
    return {lp, pidf, rf: path.join(workspace, 'win-' + key + '-stall.result.json')};
  };
  const hooks = {
    plan: async () => [{title: 'A', tasks: [{prompt: '执行甲'}]}],
    compact: p => p, infer: () => [], prompt: p => p,
    launcher: launcherFor,
    spawn: async () => { spawned++; return true; },
    // 会话文件存在但永不更新 = 无任何"进展"信号。
    session: async () => path.join(workspace, 'fake-session.jsonl'),
    wait: async () => new Promise(() => {}),          // 僵死 agent：永远不出结果
    readPid: pidf => Number(fs.readFileSync(pidf, 'utf8').trim()),
    exitCode: () => null,
    register: () => {}, unregister: () => {}, cleanup: () => {}, commit: () => {}, guardian: () => {},
    // 真实收口 = 杀净 launcher 的后代、让 launcher 自己 exit 0（仓规：绝不强杀 launcher 本体，
    // 否则 WT 会留「[已退出进程，代码为 1]」的死窗格）。这里的假 launcher 是叶子进程，直接收掉它
    // 就等价于"单元树被收干净、窗口随之关闭"。
    close: async pid => { closed++; spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {windowsHide: true, timeout: 15000}); },
  };
  fs.writeFileSync(path.join(workspace, 'fake-session.jsonl'), 'start\n', 'utf8');
  const prevStall = process.env.ORCH_UNIT_STALL_MS;
  process.env.ORCH_UNIT_STALL_MS = '1200';
  try {
    const sum = await runWindows('执行甲', hooks, {workspace, capacity: 8, runId: 'stall', auth: 'test', coordinator: path.join(workspace, 'temp', 'coordinator'), maxAttempts: 2, timeoutMs: 120000});
    assert.equal(sum.success, false, 'a stalled unit must never fake success');
    assert.ok(closed >= 2, 'every stalled attempt must be closed out (never left for a manual Ctrl-D)');
    assert.ok(spawned >= 2, 'the block must be retried inside its attempt budget');
    const reason = String(sum.taskResults.T001?.reason || '');
    assert.match(reason, /stalled/i, 'the ledger must carry the stall reason so the caller can see why: ' + reason);
  } finally {
    if (prevStall === undefined) delete process.env.ORCH_UNIT_STALL_MS; else process.env.ORCH_UNIT_STALL_MS = prevStall;
    for (const kid of kids) { try { spawnSync('taskkill', ['/PID', String(kid.pid), '/T', '/F'], {windowsHide: true, timeout: 10000}); } catch { /* best effort */ } }
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});
