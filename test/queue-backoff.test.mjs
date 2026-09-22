import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {waitBackoffMs} from '../scripts/core/leases.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const family = path.join(root, 'temp');
const REQUEST = '修复项目81登录页；优化项目84购物车';

// 伪调用方单元：执行 checkpoint 协议 + 写回执 + 完成标记（同 caller-driven 夹具）。
const FAKE_UNIT = `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const i = args.indexOf('--prompt-file');
const pf = i >= 0 ? args[i + 1] : args[args.length - 1];
const prompt = fs.readFileSync(pf, 'utf8');
const token = /【本块唯一标识】\\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(prompt)?.[1] || 'tok';
const ids = [...new Set([...prompt.matchAll(/任务 (T\\d+)/g)].map((m) => m[1]))];
const cp = (helper, file, id, state) => spawnSync(process.execPath, [helper, file, id, state], { windowsHide: true });
for (const m of prompt.matchAll(/开始前：node "([^"]+)" "([^"]+)" (\\S+) started/g)) cp(m[1], m[2], m[3], 'started');
for (const id of ids) fs.writeFileSync('receipt-' + id + '.json', JSON.stringify({ ok: true, token, id }));
for (const m of prompt.matchAll(/完成自验后：node "([^"]+)" "([^"]+)" (\\S+) completed/g)) cp(m[1], m[2], m[3], 'completed');
console.log('done __ORCH_DONE__ ' + token);
`;

function setup() {
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, 'queue-'));
  const unit = path.join(dir, 'fakeunit.mjs');
  fs.writeFileSync(unit, FAKE_UNIT);
  return {dir, unit};
}

function taskLevelPlan() {
  return {schema: 1, kind: 'tasks', tasks: [
    {id: 'T001', summary: '修复项目81登录页', kind: 'project', project: '81', conflict_hints: ['file:src/login.js'], depends_on: []},
    {id: 'T002', summary: '优化项目84购物车', kind: 'project', project: '84', conflict_hints: ['file:src/cart.js'], depends_on: []},
  ]};
}

test('queue backoff: exponential growth, cap, jitter bounds (deterministic)', () => {
  const lo = {base: 100, max: 1000, random: () => 0};
  assert.equal(waitBackoffMs(0, lo), 80);
  assert.equal(waitBackoffMs(1, lo), Math.round(100 * 1.7 * 0.8));
  assert.equal(waitBackoffMs(2, lo), Math.round(100 * 1.7 * 1.7 * 0.8));
  const hi = {base: 100, max: 1000, random: () => 1};
  assert.equal(waitBackoffMs(0, hi), 120);
  // 封顶：target 不超 max，抖动上界为 max×1.2
  assert.equal(waitBackoffMs(50, hi), 1200);
  assert.ok(waitBackoffMs(50, lo) <= 1000);
  // 单调不减（同一抖动量下）
  let prev = 0;
  for (let i = 0; i < 12; i++) { const v = waitBackoffMs(i, lo); assert.ok(v >= prev); prev = v; }
  // 缺省与异常输入不炸
  assert.ok(waitBackoffMs(0) >= 1);
  assert.ok(waitBackoffMs(-5, {base: 60, max: 90}) <= 108);
});

test('capacity waiters back off: two blocks serialize through one window, run still succeeds', async () => {
  const s = setup();
  const ws = fs.mkdtempSync(path.join(family, 'queue-ws-'));
  try {
    const unitFile = path.join(s.dir, 'unit.json');
    fs.writeFileSync(unitFile, JSON.stringify({schema: 1, id: 'fakeunit', label: 'FakeUnit', bin: process.execPath, args: [s.unit, '--prompt-file', '{promptFile}'], promptDelivery: 'file'}));
    const plan = path.join(s.dir, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify(taskLevelPlan()));
    fs.writeFileSync(path.join(ws, 'acceptance.json'), JSON.stringify({
      T001: [{type: 'json', path: 'receipt-T001.json', equals: {ok: true}}],
      T002: [{type: 'json', path: 'receipt-T002.json', equals: {ok: true}}],
    }));
    const env = {...process.env};
    for (const k of ['ORCH_AGENT', 'ORCH_UNIT_CMD', 'ORCH_CLI', 'ORCH_MODEL', 'ORCH_EFFORT']) delete env[k];
    delete env.NODE_TEST_CONTEXT;
    // 非交互自动化显式钉 headless：本机用户级 ORCH_SPAWN_MODE 不得让套件弹窗或变色。
    env.ORCH_SPAWN_MODE = 'headless';
    env.WORKSPACE_DIR = ws;
    env.ORCH_STATE_DIR = path.join(ws, 'temp', 'orchestrator');
    // 协调器跟工作区走（理由同 caller-driven）：本用例删掉 NODE_TEST_CONTEXT 走真实入口，不钉住就会
    // 落到机器级 HKCU 定位器，与并发测试文件共用窗口槽位池，"第二块必须排队"的判据会被别人的槽位搅乱。
    env.ORCH_COORDINATOR_DIR = path.join('temp', 'orchestrator', 'coordinator');
    env.ORCH_MAINTENANCE_LOCK = path.join(ws, 'no-lock.json');
    env.ORCH_MAX_POLL_MS = '120000';
    env.ORCH_UNIT_CMD_FILE = unitFile;
    env.ORCH_PLAN_FILE = plan;
    env.ORCH_ACCEPTANCE_FILE = path.join(ws, 'acceptance.json');
    env.ORCH_MAX_WINDOWS = '1';                 // 强制单窗：第二块必须排队等容量
    env.ORCH_WAIT_BACKOFF_MS = '40';            // 测试提速（退避数学另有单测）
    env.ORCH_WAIT_BACKOFF_MAX_MS = '80';
    const r = spawnSync(process.execPath, [path.join(root, 'orch.mjs'), '--run-id', 'queue-e2e', REQUEST], {cwd: ws, env, encoding: 'utf8', windowsHide: true, timeout: 240000});
    // 失败时必须带出真相：块级 reason 只落在 summary.json 里，而 finally 会删掉工作区（2026-09-14 加）。
    const summaryPath = path.join(ws, 'temp', 'orchestrator', 'runs', 'queue-e2e', 'summary.json');
    const diagnosis = () => {
      try {
        const s = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        return Object.entries(s.results || {}).map(([k, v]) => k + '=' + v.status + (v.reason ? ' (' + v.reason + ')' : '')).join(' | ')
          + ' tasks=' + JSON.stringify(s.taskResults);
      } catch (e) { return '(summary unreadable: ' + e.message + ')'; }
    };
    assert.equal(r.status, 0, (r.stderr || r.stdout) + '\n--- block truth: ' + diagnosis());
    const sum = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    assert.equal(sum.success, true, JSON.stringify(sum.results));
    assert.ok(Object.values(sum.taskResults).every((t) => t.status === 'verified'), JSON.stringify(sum.taskResults));
    // 排队确实发生过：看板出现过 waiting（容量 1 下两个独立块必然有一个在等）
    assert.match(r.stdout, /waiting/i, 'the board must show the waiting block');
  } finally {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(s.dir, {recursive: true, force: true}); } catch { /* retry */ }
      try { fs.rmSync(ws, {recursive: true, force: true}); } catch { /* retry */ }
      await new Promise((res) => setTimeout(res, 300));
    }
  }
});
