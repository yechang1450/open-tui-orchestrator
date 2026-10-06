import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {scanStaleRuns} from '../scripts/core/reboot-recovery.mjs';
import {bootId} from '../scripts/core/contracts.mjs';
import {reserve, processSnapshot} from '../scripts/core/leases.mjs';

// 2026-09-18 断电恢复 P0 判据：
// ① 扫描器必须用 bootId（而非 PID）断定「来自上一次开机」的未完成 run，并给出可执行的恢复命令；
// ② 本次开机的未完成 run 绝不误报（控制器可能还活着）；
// ③ 已收口的 run 不碰；
// ④ 租约层：带旧 bootId 的记录**即使 PID 撞上活进程**也必须被回收（PID 跨重启会重用）——这条是
//    「真断电后重启」与「同次开机内崩溃」的分水岭，修复前必然红。

const family = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../temp');
const nowBoot = bootId();

function fakeRun(workspace, runId, summary) {
  const dir = path.join(workspace, 'temp', 'orchestrator', 'runs', runId);
  fs.mkdirSync(dir, {recursive: true});
  if (summary !== null) fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary), 'utf8');
  return dir;
}

test('reboot scan finds the runs a power cut left behind, and only those', () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'reboot-scan-'));
  try {
    const base = {protocol: 2, agent: 'pi', spawnMode: 'window', workspace, generation: 1, history: [], tasks: [], plan: [], blocks: [], request: '执行甲'};
    fakeRun(workspace, 'stale-one', {...base, runId: 'stale-one', startedAt: Date.now() - 3600e3, bootId: nowBoot - 100000, success: false, results: {B1: {status: 'running', attempts: []}, B2: {status: 'verified', attempts: []}}});
    fakeRun(workspace, 'current-boot', {...base, runId: 'current-boot', startedAt: Date.now() - 600e3, bootId: nowBoot, success: false, results: {B1: {status: 'running', attempts: []}}});
    fakeRun(workspace, 'finished', {...base, runId: 'finished', startedAt: Date.now() - 7200e3, bootId: nowBoot - 100000, success: true, finishedAt: Date.now() - 7000e3, results: {B1: {status: 'verified', attempts: []}}});
    fakeRun(workspace, 'no-ledger-at-all', null);

    const stale = scanStaleRuns(workspace);
    const ids = stale.map(s => s.runId);
    assert.ok(ids.includes('stale-one'), 'the run from the previous boot must be reported: ' + JSON.stringify(ids));
    assert.ok(ids.includes('no-ledger-at-all'), 'an interrupted run without a ledger must be surfaced for manual review');
    assert.ok(!ids.includes('current-boot'), 'a run from the current boot must never be reported as stale');
    assert.ok(!ids.includes('finished'), 'a finished run must never be reported as stale');
    const one = stale.find(s => s.runId === 'stale-one');
    assert.equal(one.status, 'stale-after-reboot');
    assert.match(String(one.resumeCommand), /--resume-run '?stale-one'?/, 'the scan must hand out the standard resume command');
    assert.deepEqual(one.blocks.map(b => b.key + ':' + b.status), ['B1:running', 'B2:verified']);
    assert.equal(stale.find(s => s.runId === 'no-ledger-at-all').resumeCommand, null, 'no-ledger runs are manual review, never auto-replayed');
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('a summary that parses to a non-object never crashes the scan', () => {
  const workspace = fs.mkdtempSync(path.join(family, 'reboot-null-'));
  try {
    const dir = path.join(workspace, 'temp', 'orchestrator', 'runs', 'null-summary');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'summary.json'), 'null', 'utf8');
    const stale = scanStaleRuns(workspace);
    const row = stale.find(s => s.runId === 'null-summary');
    assert.ok(row, 'a literal null summary must be surfaced, not crash the scan: ' + JSON.stringify(stale));
    assert.equal(row.status, 'unreadable');
    assert.equal(row.resumeCommand, null);
  } finally { fs.rmSync(workspace, {recursive: true, force: true}); }
});

test('the resume command quotes every user-controlled argument', () => {
  const workspace = fs.mkdtempSync(path.join(family, 'reboot-quote-'));
  try {
    const weirdWs = "C:/tmp/weird dir's/ws";
    const dir = path.join(workspace, 'temp', 'orchestrator', 'runs', 'run id x');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({protocol: 2, runId: 'run id x', agent: 'pi', spawnMode: 'window', workspace: weirdWs, bootId: nowBoot - 100000, success: false, results: {}}), 'utf8');
    const stale = scanStaleRuns(workspace);
    const row = stale.find(s => s.runId === 'run id x');
    assert.ok(row, 'the stale run must be reported');
    assert.ok(row.resumeCommand.includes("--workspace 'C:/tmp/weird dir''s/ws'"), row.resumeCommand);
    assert.ok(row.resumeCommand.includes("--resume-run 'run id x'"), row.resumeCommand);
    assert.ok(row.resumeCommand.includes("--agent 'pi'"), row.resumeCommand);
    assert.ok(row.resumeCommand.includes("--mode 'window'"), row.resumeCommand);
  } finally { fs.rmSync(workspace, {recursive: true, force: true}); }
});

test('a lease carrying a previous bootId is reclaimed even when its PID matches a live process', async () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'reboot-lease-'));
  const coordinator = path.join(workspace, 'coordinator');
  try {
    // 现场 = 真断电后重启：进程身份（PID+Started）与「旧记录里的属主」恰好撞上活进程（PID 重用）。
    const live = processSnapshot().get(process.pid);
    assert.ok(live, 'the test needs the live identity of this process');
    fs.mkdirSync(coordinator, {recursive: true});
    fs.writeFileSync(path.join(coordinator, 'leases.json'), JSON.stringify([
      {id: 'old-boot', keys: ['dir:' + path.join(workspace, 'proj-1').toLowerCase()], owner: live, capacity: 4, reservedAt: Date.now(), bootId: nowBoot - 100000},
    ]), 'utf8');

    const result = reserve(coordinator, {id: 'fresh', keys: ['dir:' + path.join(workspace, 'proj-2').toLowerCase()]}, 4);
    assert.equal(result.ok, true, 'the reserve must succeed once the stale record is reclaimed');
    const leases = JSON.parse(fs.readFileSync(path.join(coordinator, 'leases.json'), 'utf8'));
    assert.ok(!leases.some(l => l.id === 'old-boot'), 'a previous-boot lease must be dropped (PID reuse must not keep it alive)');
    const fresh = leases.find(l => l.id === 'fresh');
    assert.ok(fresh, 'the new reservation must be recorded');
    assert.equal(fresh.bootId, bootId(), 'new records must carry the current bootId');
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});
