import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const family = path.join(root, 'temp');
const RUN_TIMEOUT_MS = 180000; // ORCH_MAX_POLL_MS 120000 + 60s cleanup/serialization headroom

// 假 kimi CLI：--help/--version 过 kimi-host 探测；其余调用按提示词里的 checkpoint 指令
// 先记 started、写回执、再记 completed，最后输出完成标记（行为对齐守规矩的真实块代理）。
const FAKE = `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--prompt --output-format --auto'); process.exit(0); }
if (args.includes('--version')) { console.log('9.9.9'); process.exit(0); }
const prompt = args[args.length - 1] || '';
const token = /【本块唯一标识】\\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(prompt)?.[1] || 'tok';
const cp = (carrier, id, state) => spawnSync(carrier, [id, state], { windowsHide: true, shell: true });
for (const m of prompt.matchAll(/开始前："([^" ]+checkpoint[.]cmd)" ([^ ]+) started/g)) cp(m[1], m[2], 'started');
fs.writeFileSync('receipt.json', JSON.stringify({ok: true, token}));
for (const m of prompt.matchAll(/完成自验后："([^" ]+checkpoint[.]cmd)" ([^ ]+) completed/g)) cp(m[1], m[2], 'completed');
console.log('done __ORCH_DONE__ ' + token);
`;

function setup() {
  fs.mkdirSync(family, { recursive: true });
  const ws = fs.mkdtempSync(path.join(family, 'orch-force-'));
  const fake = path.join(ws, 'fake-kimi.mjs');
  fs.writeFileSync(fake, FAKE);
  const acceptance = path.join(ws, 'acceptance.json');
  fs.writeFileSync(acceptance, JSON.stringify({ T001: [{ type: 'json', path: 'receipt.json', equals: { ok: true } }] }));
  const lockFile = path.join(ws, 'no-lock.json');
  const base = { ...process.env, ORCH_AGENT: 'kimi', ORCH_CLI: fake, ORCH_ACCEPTANCE_FILE: acceptance, ORCH_MAINTENANCE_LOCK: lockFile, ORCH_MAX_POLL_MS: '120000',
    // 协调器（槽位租约/内核互斥）钉在本工作区：本用例删掉 NODE_TEST_CONTEXT 走真实入口，
    // 不钉住就与并发测试文件共用机器级槽位池，谁先占满谁的窗口就排队（2026-09-22 起统一如此）。
    ORCH_COORDINATOR_DIR: path.join('temp', 'orchestrator', 'coordinator'),
    // 非交互自动化显式钉 headless：本机用户级 ORCH_SPAWN_MODE 不得让套件弹窗或变色。
    ORCH_SPAWN_MODE: 'headless' };
  delete base.WORKSPACE_DIR; delete base.ORCH_STATE_DIR; delete base.NODE_TEST_CONTEXT;
  return { ws, acceptance, lockFile, env: base };
}

const run = (env, extra = []) => {
  const result = spawnSync(process.execPath, [path.join(root, 'cli.mjs'), ...extra, '--run-windows', '修复登录页'], { cwd: env.__ws, env: (() => { const e = { ...env, WORKSPACE_DIR: env.__ws, ORCH_STATE_DIR: path.join(env.__ws, 'temp', 'orchestrator') }; delete e.__ws; return e; })(), encoding: 'utf8', windowsHide: true, timeout: RUN_TIMEOUT_MS });
  if (result.error?.code === 'ETIMEDOUT' || result.signal || result.status === null) {
    if (Number.isInteger(result.pid) && result.pid > 0) {
      try { spawnSync('taskkill', ['/PID', String(result.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* best-effort cleanup */ }
    }
  }
  return result;
};
const assertRunStarted = (result) => {
  assert.equal(result.error, undefined, result.error?.message || result.stderr || 'orchestrator spawn failed');
  assert.equal(result.signal, null, result.stderr || 'orchestrator terminated by signal');
  assert.notEqual(result.status, null, result.stderr || 'orchestrator returned no exit status');
};

test('a single-block request returns inline by default', () => {
  const s = setup();
  const env = { ...s.env, __ws: s.ws };
  try {
    const r = run(env);
    assertRunStarted(r);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"mode":"inline"/);
    assert.doesNotMatch(r.stdout, /spawned headless/);
  } finally { for (let i = 0; i < 5; i++) { try { fs.rmSync(s.ws, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); } } }
});

test('ORCH_FORCE_EXECUTE bypasses the inline gate and actually spawns a unit', () => {
  const s = setup();
  const env = { ...s.env, __ws: s.ws, ORCH_FORCE_EXECUTE: '1' };
  try {
    const r = run(env);
    assertRunStarted(r);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /"mode":"inline"/);
    assert.match(r.stdout, /force-execute: inline gate bypassed/);
    assert.match(r.stdout, /spawned headless kimi unit/);
    assert.match(fs.readFileSync(path.join(s.ws, 'receipt.json'), 'utf8'), /"ok":true/);
    const m = /runId=([A-Za-z0-9_-]+)/.exec(r.stdout);
    assert.ok(m, 'engine must report its runId');
    const sum = JSON.parse(fs.readFileSync(path.join(s.ws, 'temp', 'orchestrator', 'runs', m[1], 'summary.json'), 'utf8'));
    assert.equal(sum.success, true);
  } finally { for (let i = 0; i < 5; i++) { try { fs.rmSync(s.ws, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); } } }
});

test('the maintenance lock still blocks a forced invocation', () => {
  const s = setup();
  fs.writeFileSync(s.lockFile, JSON.stringify({ version: 1, reason: 'test', startedAt: Date.now(), expiresAt: Date.now() + 3600000 }));
  const env = { ...s.env, __ws: s.ws, ORCH_FORCE_EXECUTE: '1' };
  try {
    const r = run(env);
    assertRunStarted(r);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /open-tui-orchestrator正在维护更新，本轮跳过orchestrator直接开始执行/);
    assert.doesNotMatch(r.stdout, /spawned headless/);
  } finally { for (let i = 0; i < 5; i++) { try { fs.rmSync(s.ws, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); } } }
});

// orch.mjs 自己的入口语义（2026-10-15）：强制发车只该加在执行类请求上；只读入口必须
// 原样透传给 cli.mjs。回归场景：`orch --tasks "<request>"` 曾把 --tasks 落到 argv[3]
// 被引擎当成请求文本（mode 取 argv[2]），只想核对账本却真的开了四个执行单元。
test('orch passes read-only entries through instead of force-launching them', () => {
  const orch = path.join(root, 'orch.mjs');
  const result = spawnSync(process.execPath, [orch, '--tasks', '甲任务；乙任务；丙任务'], {
    cwd: family, encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, ORCH_MAINTENANCE_LOCK: path.join(family, 'no-lock-ro.json') },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, null, 'orch --tasks must return, not hang');
  assert.equal(result.status, 0, result.stderr);
  // 账本真的打印了（JSON 可解析、三个 id 齐），且一个单元都没发车。
  const ledger = JSON.parse(result.stdout);
  assert.equal(ledger.kind, 'tasks');
  assert.deepEqual(ledger.tasks.map((t) => t.id), ['T001', 'T002', 'T003']);
  assert.doesNotMatch(result.stdout + (result.stderr || ''), /spawned headless/);
  // 没有留下任何 run 目录 = 确实没发车。目录可能压根没被创建（没发车就没有状态落盘），
  // 所以"不存在"与"存在但为空"都算通过 —— 直接 readdir 一个不存在的目录会抛 ENOENT。
  const runsDir = path.join(family, 'orchestrator', 'runs');
  const runsEntries = fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [];
  assert.deepEqual(runsEntries, [], 'orch --tasks must not leave a run directory');
});

test('orch --doctor stays read-only', () => {
  const orch = path.join(root, 'orch.mjs');
  const result = spawnSync(process.execPath, [orch, '--doctor'], {
    cwd: family, encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, ORCH_MAINTENANCE_LOCK: path.join(family, 'no-lock-doc.json') },
  });
  assert.equal(result.status, 0, result.stderr);
  const doctor = JSON.parse(result.stdout);
  assert.ok(doctor.agent, '--doctor must report the resolved agent');
  assert.doesNotMatch(result.stdout + (result.stderr || ''), /spawned headless/);
});

// orch 的主业（强制发车）也必须钉住（2026-10-15）：只读透传修只该影响只读入口；执行类请求
// 仍走 ORCH_FORCE_EXECUTE 强制发车（跳过 inline 门、真的派单元）。orch.mjs 此前没有任何测试
// ——这正是 --tasks 静默发车能藏那么久的原因；只读与发车两个分支从此各有判据。
// 红例：把判断改坏成「任何请求都透传」时，inline 门会拦下单块请求、本用例必红。
test('orch still force-launches an execution request', () => {
  const s = setup();
  const env = { ...s.env, __ws: s.ws };
  try {
    const r = spawnSync(process.execPath, [path.join(root, 'orch.mjs'), '修复登录页'], {
      cwd: s.ws, encoding: 'utf8', windowsHide: true, timeout: RUN_TIMEOUT_MS,
      env: (() => { const e = { ...env, WORKSPACE_DIR: s.ws, ORCH_STATE_DIR: path.join(s.ws, 'temp', 'orchestrator') }; delete e.__ws; return e; })(),
    });
    assertRunStarted(r);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /"mode":"inline"/, 'orch must bypass the inline gate');
    assert.match(r.stdout, /spawned headless kimi unit/);
    assert.match(fs.readFileSync(path.join(s.ws, 'receipt.json'), 'utf8'), /"ok":true/);
  } finally { for (let i = 0; i < 5; i++) { try { fs.rmSync(s.ws, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); } } }
});
