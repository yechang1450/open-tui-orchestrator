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

// 2026-09-18（codex 现场）：单元活着、会话在动，但整轮只顾分析没动手——连第一个检查点都不写。
// 判据：会话文件持续前进（stall 通道不允许触发）而尝试文件 mtime 从未越过启动时刻 ⇒
// 首检查点期限命中 ⇒ 提前收口重跑（而不是等满 stall 期限），账本落 unproductive 理由。
test('a unit that stays alive but never writes a first checkpoint trips the first-checkpoint deadline', async () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'first-cp-'));
  const ps = powershellExe();
  const kids = [];
  let spawned = 0, closed = 0;
  const sessionFile = path.join(workspace, 'ticking-session.jsonl');
  fs.writeFileSync(sessionFile, 'start\n', 'utf8');
  const tick = setInterval(() => { try { fs.appendFileSync(sessionFile, 'tick\n'); } catch { /* ignore */ } }, 150);
  const launcherFor = key => {
    const lp = path.join(workspace, 'win-launch-' + key + '-cp.ps1');
    fs.writeFileSync(lp, 'Start-Sleep -Seconds 600\n', 'utf8');
    const pidf = path.join(workspace, 'window-' + key + '-cp.pid');
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', lp], {windowsHide: true, stdio: 'ignore'});
    kids.push(child);
    fs.writeFileSync(pidf, String(child.pid), 'utf8');
    return {lp, pidf, rf: path.join(workspace, 'win-' + key + '-cp.result.json')};
  };
  const hooks = {
    plan: async () => [{title: 'A', tasks: [{prompt: '执行甲'}]}],
    compact: p => p, infer: () => [], prompt: p => p,
    launcher: launcherFor,
    spawn: async () => { spawned++; return true; },
    session: async () => sessionFile,
    wait: async () => new Promise(() => {}),
    readPid: pidf => Number(fs.readFileSync(pidf, 'utf8').trim()),
    exitCode: () => null,
    register: () => {}, unregister: () => {}, cleanup: () => {}, commit: () => {}, guardian: () => {},
    close: async pid => { closed++; spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {windowsHide: true, timeout: 15000}); },
  };
  const prevStall = process.env.ORCH_UNIT_STALL_MS, prevFirst = process.env.ORCH_UNIT_FIRST_CHECKPOINT_MS, prevUnprod = process.env.ORCH_UNPRODUCTIVE_RETRIES;
  process.env.ORCH_UNIT_STALL_MS = '4000';            // 会话在前进：stall 通道必须不触发
  process.env.ORCH_UNIT_FIRST_CHECKPOINT_MS = '1000'; // 1 秒内没有首检查点 ⇒ 命中
  process.env.ORCH_UNPRODUCTIVE_RETRIES = '0';        // 本判据只测期限本身，关掉额外补试
  try {
    const sum = await runWindows('执行甲', hooks, {workspace, capacity: 8, runId: 'firstcp', auth: 'test', coordinator: path.join(workspace, 'temp', 'coordinator'), maxAttempts: 2, timeoutMs: 300000});
    assert.equal(sum.success, false, 'a unit that never starts its first task must not fake success');
    assert.ok(closed >= 2, 'each unproductive attempt must be closed out');
    assert.ok(spawned >= 2, 'the block must be retried inside its attempt budget');
    const reason = String(sum.taskResults.T001?.reason || '');
    assert.match(reason, /unproductive/i, 'the ledger must carry the unproductive-deadline reason: ' + reason);
  } finally {
    clearInterval(tick);
    if (prevStall === undefined) delete process.env.ORCH_UNIT_STALL_MS; else process.env.ORCH_UNIT_STALL_MS = prevStall;
    if (prevFirst === undefined) delete process.env.ORCH_UNIT_FIRST_CHECKPOINT_MS; else process.env.ORCH_UNIT_FIRST_CHECKPOINT_MS = prevFirst;
    if (prevUnprod === undefined) delete process.env.ORCH_UNPRODUCTIVE_RETRIES; else process.env.ORCH_UNPRODUCTIVE_RETRIES = prevUnprod;
    for (const kid of kids) { try { spawnSync('taskkill', ['/PID', String(kid.pid), '/T', '/F'], {windowsHide: true, timeout: 10000}); } catch { /* best effort */ } }
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

// 2026-09-22 第 3 轮（S2 真机实测抓到）：**没有会话文件的宿主路径**（codex 在未受信任工作区里停在
// "是否信任本目录"的提示上 ⇒ 宿主 rollout 永不出现 ⇒ session=null）走的是一条独立分支：只按盘上验收
// 每 10s 轮询，**没有**首检查点期限，于是账本会一直停在 running 直到运行上限（默认 45 分钟），
// 既不说真因也不重试。判据：session=null 时，首检查点期限同样生效 ⇒ 单元被收口重跑、账本落
// unproductive 理由；红例 = 去掉那个期限（本用例会一路等到 timeoutMs 才收场，且 reason 不带 unproductive）。
test('without a host session file the first-checkpoint deadline still fires (a hidden TUI stuck on a prompt)', async () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'no-session-cp-'));
  const ps = powershellExe();
  const kids = [];
  let spawned = 0, closed = 0;
  const launcherFor = key => {
    const lp = path.join(workspace, 'win-launch-' + key + '-ncp.ps1');
    fs.writeFileSync(lp, 'Start-Sleep -Seconds 600\n', 'utf8');
    const pidf = path.join(workspace, 'window-' + key + '-ncp.pid');
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', lp], {windowsHide: true, stdio: 'ignore'});
    kids.push(child);
    fs.writeFileSync(pidf, String(child.pid), 'utf8');
    return {lp, pidf, rf: path.join(workspace, 'win-' + key + '-ncp.result.json')};
  };
  const hooks = {
    plan: async () => [{title: 'A', tasks: [{prompt: '执行甲'}]}],
    compact: p => p, infer: () => [], prompt: p => p,
    launcher: launcherFor,
    spawn: async () => { spawned++; return true; },
    session: async () => null,                        // 宿主 rollout 永不出现（信任提示挡在前面）
    wait: async () => new Promise(() => {}),
    readPid: pidf => Number(fs.readFileSync(pidf, 'utf8').trim()),
    exitCode: () => null,
    register: () => {}, unregister: () => {}, cleanup: () => {}, commit: () => {}, guardian: () => {},
    close: async pid => { closed++; spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {windowsHide: true, timeout: 15000}); },
  };
  const prevFirst = process.env.ORCH_UNIT_FIRST_CHECKPOINT_MS, prevUnprod = process.env.ORCH_UNPRODUCTIVE_RETRIES;
  process.env.ORCH_UNIT_FIRST_CHECKPOINT_MS = '1000';
  process.env.ORCH_UNPRODUCTIVE_RETRIES = '0';
  try {
    const sum = await runWindows('执行甲', hooks, {workspace, capacity: 8, runId: 'nosessioncp', auth: 'test', coordinator: path.join(workspace, 'temp', 'coordinator'), maxAttempts: 2, timeoutMs: 120000});
    assert.equal(sum.success, false, 'a unit stuck before its first task must not fake success');
    assert.ok(closed >= 2, 'each unproductive attempt must be closed out');
    assert.ok(spawned >= 2, 'the block must be retried inside its attempt budget');
    const reason = String(sum.taskResults.T001?.reason || '');
    assert.match(reason, /unproductive/i, 'the ledger must carry the unproductive-deadline reason: ' + reason);
  } finally {
    if (prevFirst === undefined) delete process.env.ORCH_UNIT_FIRST_CHECKPOINT_MS; else process.env.ORCH_UNIT_FIRST_CHECKPOINT_MS = prevFirst;
    if (prevUnprod === undefined) delete process.env.ORCH_UNPRODUCTIVE_RETRIES; else process.env.ORCH_UNPRODUCTIVE_RETRIES = prevUnprod;
    for (const kid of kids) { try { spawnSync('taskkill', ['/PID', String(kid.pid), '/T', '/F'], {windowsHide: true, timeout: 10000}); } catch { /* best effort */ } }
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});
