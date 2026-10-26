import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {normalizeUnitProfile, expandUnitArgs, loadUnitProfile} from '../scripts/core/unit-command.mjs';
import {buildBlocksFromTasks} from '../scripts/core/orchestrate-sdk.mjs';
import {bindClassifiedTasks} from '../scripts/core/contracts.mjs';
import {CODEX_CLI_SKIP} from './helpers/external.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const family = path.join(root, 'temp');
const CLI = path.join(root, 'cli.mjs');
const REQUEST = '修复登录页；优化购物车';

// 伪"调用方单元"CLI：① 若收到分类提示词（说明走了 LLM 规划，应永不发生）→ 写 planner-invoked.marker；
// ② FAKE_UNIT_FAIL=1 → 直接非零退出（fail-closed 反例）；③ 否则执行 checkpoint 协议 + 写回执 + 完成标记。
// FAKE_UNIT_SKIP_CHECKPOINTS=1 → 只写回执不写检查点（必须判不出 verified）。
const FAKE_UNIT = `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const i = args.indexOf('--prompt-file');
const pf = i >= 0 ? args[i + 1] : args[args.length - 1];
const prompt = fs.readFileSync(pf, 'utf8');
if (/任务定性分析器/.test(prompt)) { try { fs.writeFileSync('planner-invoked.marker', '1'); } catch {} process.exit(0); }
if (process.env.FAKE_UNIT_FAIL === '1') { process.exit(3); }
const token = /【本块唯一标识】\\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(prompt)?.[1] || 'tok';
const ids = [...new Set([...prompt.matchAll(/任务 (T\\d+)/g)].map((m) => m[1]))];
const cp = (carrier, id, state) => spawnSync(carrier, [id, state], { windowsHide: true, shell: true });
const noCheckpoints = process.env.FAKE_UNIT_NO_CHECKPOINTS === '1';
if (!noCheckpoints) for (const m of prompt.matchAll(/开始前："([^" ]+checkpoint[.]cmd)" ([^ ]+) started/g)) cp(m[1], m[2], 'started');
for (const id of ids) fs.writeFileSync('receipt-' + id + '.json', JSON.stringify({ ok: true, token, id }));
if (!noCheckpoints) for (const m of prompt.matchAll(/完成自验后："([^" ]+checkpoint[.]cmd)" ([^ ]+) completed/g)) cp(m[1], m[2], 'completed');
console.log('done __ORCH_DONE__ ' + token);
`;

function setup() {
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, 'caller-'));
  const unit = path.join(dir, 'fakeunit.mjs');
  fs.writeFileSync(unit, FAKE_UNIT);
  return {dir, unit};
}

function unitProfile(unitFile, extra = {}) {
  return {schema: 1, id: 'fakeunit', label: 'FakeUnit', bin: process.execPath, args: [unitFile, '--prompt-file', '{promptFile}'], promptDelivery: 'file', ...extra};
}

function taskLevelPlan() {
  return {schema: 1, kind: 'tasks', tasks: [
    {id: 'T001', summary: '修复登录页', kind: 'project', project: '07', conflict_hints: ['file:src/login.js'], depends_on: []},
    {id: 'T002', summary: '优化购物车', kind: 'project', project: '08', conflict_hints: ['file:src/cart.js'], depends_on: []},
  ]};
}

function callEnv({ws, unitFile, planFile, acceptance, extra = {}}) {
  const env = {...process.env};
  delete env.ORCH_AGENT; delete env.ORCH_UNIT_CMD; delete env.ORCH_UNIT_CMD_FILE; delete env.ORCH_PLAN_FILE;
  delete env.ORCH_CLI; delete env.CODEX_THREAD_ID; delete env.CODEX_SESSION_ID;
  delete env.NODE_TEST_CONTEXT;
  // 非交互自动化显式钉 headless：本机用户级 ORCH_SPAWN_MODE 不得让套件弹窗或变色。
  env.ORCH_SPAWN_MODE = 'headless';
  env.WORKSPACE_DIR = ws;
  env.ORCH_STATE_DIR = path.join(ws, 'temp', 'orchestrator');
  // 协调器（窗口槽位租约 + 内核互斥）必须跟着测试工作区走。本用例刻意删掉 NODE_TEST_CONTEXT 去走真实
  // 入口，若不显式钉住就会落到机器级 HKCU 定位器：并发跑的几个测试文件共用同一个槽位池，互相抢容量
  // 直到把本 run 的 120s 预算耗光（2026-09-22 实测：两条任务都 timeout，reason 指向 capacity）。
  env.ORCH_COORDINATOR_DIR = path.join('temp', 'orchestrator', 'coordinator');
  env.ORCH_MAINTENANCE_LOCK = path.join(ws, 'no-maintenance-lock.json');
  env.ORCH_MAX_POLL_MS = '600000';
  // 0.9.17 内存拟合：测试要确定性 ⇒ 钉住单元估算与硬底（否则分块形状随机器当时内存漂移），
  // 并把学习表隔离到工作区里（否则同机其它运行的实测样本会改变判据）。
  env.ORCH_UNIT_MEM_DEFAULT_MB = '64';
  env.ORCH_MIN_FREE_MEM_MB = '64';
  env.ORCH_UNIT_MEM_STORE = path.join(ws, 'unit-memory.json');
  if (unitFile) env.ORCH_UNIT_CMD_FILE = unitFile;
  if (planFile) env.ORCH_PLAN_FILE = planFile;
  if (acceptance) env.ORCH_ACCEPTANCE_FILE = acceptance;
  return Object.assign(env, extra);
}

function jsonFrom(stdout) {
  const text = String(stdout);
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  return JSON.parse(text.slice(start, end + 1));
}

function readSummary(ws, runId) {
  return JSON.parse(fs.readFileSync(path.join(ws, 'temp', 'orchestrator', 'runs', runId, 'summary.json'), 'utf8'));
}

function cleanup(...dirs) {
  return (async () => { for (let i = 0; i < 5; i++) { for (const d of dirs) { try { fs.rmSync(d, {recursive: true, force: true}); } catch { /* retry */ } } await new Promise((r) => setTimeout(r, 300)); } })();
}

test('--tasks prints the authoritative ledger and needs no host identity', () => {
  const r = spawnSync(process.execPath, [CLI, '--tasks', REQUEST], {env: callEnv({ws: process.cwd()}), encoding: 'utf8', windowsHide: true, timeout: 180000});
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const doc = jsonFrom(r.stdout);
  assert.equal(doc.kind, 'tasks');
  assert.deepEqual(doc.tasks.map((t) => t.id), ['T001', 'T002']);
  assert.equal(doc.tasks[0].prompt, '修复登录页');
});

test('a task-level plan file feeds the same deterministic engine (dry run, no model)', () => {
  const s = setup();
  try {
    const plan = path.join(s.dir, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify(taskLevelPlan()));
    const r = spawnSync(process.execPath, [CLI, '--plan', '--plan-file', plan, REQUEST], {env: callEnv({ws: s.dir}), encoding: 'utf8', windowsHide: true, timeout: 60000});
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const {blocks} = jsonFrom(r.stdout);
    assert.deepEqual(blocks.map((b) => b.title), ['proj-07', 'proj-08']);
    assert.deepEqual(blocks.map((b) => b.tasks.flatMap((t) => t.sourceIds)), [['T001'], ['T002']]);
    // 与内置确定性引擎对同一分类输入的产出逐字一致
    const expected = buildBlocksFromTasks(bindClassifiedTasks(REQUEST, taskLevelPlan().tasks), {});
    assert.deepEqual(blocks.map((b) => b.tasks[0].prompt), expected.map((b) => b.tasks[0].prompt));
    assert.ok(!/failed coverage validation/.test(r.stderr), 'a well-formed plan file must not fall back');
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('plan-file coverage failures fail closed (missing id) or fall back to one serial block (paraphrased blocks)', () => {
  const s = setup();
  try {
    const bad = path.join(s.dir, 'bad-tasks.json');
    fs.writeFileSync(bad, JSON.stringify({schema: 1, kind: 'tasks', tasks: [taskLevelPlan().tasks[0]]}));
    const r1 = spawnSync(process.execPath, [CLI, '--plan', '--plan-file', bad, REQUEST], {env: callEnv({ws: s.dir}), encoding: 'utf8', windowsHide: true, timeout: 60000});
    assert.notEqual(r1.status, 0);
    assert.match(r1.stderr + r1.stdout, /Classified task inventory mismatch/);

    const paraphrase = path.join(s.dir, 'paraphrase.json');
    fs.writeFileSync(paraphrase, JSON.stringify({schema: 1, kind: 'blocks', blocks: [
      {type: 'independent', title: 'B1', dependsOn: [], conflictKeys: ['file:src/login.js'], tasks: [{id: 't1', title: 'login', prompt: '修一下登录页'}]},
      {type: 'independent', title: 'B2', dependsOn: [], conflictKeys: ['file:src/cart.js'], tasks: [{id: 't2', title: 'cart', prompt: '购物车优化'}]},
    ]}));
    const r2 = spawnSync(process.execPath, [CLI, '--plan', '--plan-file', paraphrase, REQUEST], {env: callEnv({ws: s.dir}), encoding: 'utf8', windowsHide: true, timeout: 60000});
    assert.equal(r2.status, 0, r2.stderr || r2.stdout);
    const {blocks} = jsonFrom(r2.stdout);
    assert.equal(blocks.length, 1, 'paraphrased prompts must collapse into one serial block, never drop tasks');
    assert.equal(blocks[0].title, 'complete-inventory');
    assert.deepEqual(blocks[0].tasks.flatMap((t) => t.sourceIds), ['T001', 'T002']);
    assert.match(r2.stderr, /failed coverage validation/);
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('unit profile validation and argv expansion', () => {
  assert.throws(() => normalizeUnitProfile({}), /UNIT_CMD_INVALID: bin/);
  assert.throws(() => normalizeUnitProfile({bin: 'x.exe', args: ['{promptFile}', '{prompt}']}), /both \{promptFile\} and \{prompt\}/);
  assert.throws(() => normalizeUnitProfile({bin: 'x.exe', promptDelivery: 'file'}), /promptDelivery=file requires \{promptFile\}/);
  assert.throws(() => normalizeUnitProfile({bin: 'x.exe', args: ['{prompt}'], promptDelivery: 'stdin'}), /stdin must not use prompt placeholders/);
  assert.throws(() => normalizeUnitProfile({bin: 'agent.cmd'}), /must be a real executable/);
  const file = normalizeUnitProfile({bin: 'x.exe', args: ['run', '{promptFile}', '{workspace}'], modelArgs: ['--model'], effortArgs: ['--effort']});
  assert.equal(file.promptDelivery, 'file');
  const env = {ORCH_MODEL: 'fake/model-x', ORCH_EFFORT: 'high'};
  const prev = {...process.env};
  Object.assign(process.env, env);
  try {
    assert.deepEqual(expandUnitArgs(file, {promptFile: 'P.md', workspace: 'C:/ws'}), ['run', 'P.md', 'C:/ws', '--model', 'fake/model-x', '--effort', 'high']);
    const arg = normalizeUnitProfile({bin: 'x.exe', args: ['ask', '{prompt}']});
    assert.equal(arg.promptDelivery, 'arg');
    const expanded = expandUnitArgs(arg, {prompt: '带 空格 的提示词', workspace: 'C:/ws'});
    assert.deepEqual(expanded.slice(0, 1), ['ask']);
    assert.equal(expanded[expanded.length - 1], '带 空格 的提示词');
  } finally { Object.assign(process.env, prev); }
  // 文件与 inline 二选一
  const tmp = fs.mkdtempSync(path.join(family, 'caller-prof-'));
  try {
    const f = path.join(tmp, 'u.json');
    fs.writeFileSync(f, JSON.stringify({bin: 'x.exe', args: ['{prompt}']}));
    assert.equal(loadUnitProfile({ORCH_UNIT_CMD_FILE: f}).id, 'custom');
    assert.equal(loadUnitProfile({ORCH_UNIT_CMD: JSON.stringify(unitProfile('y.mjs'))}).promptDelivery, 'file');
    assert.throws(() => loadUnitProfile({ORCH_UNIT_CMD_FILE: f, ORCH_UNIT_CMD: '{}'}), /not both/);
    assert.throws(() => loadUnitProfile({ORCH_UNIT_CMD_FILE: path.join(tmp, 'missing.json')}), /UNIT_CMD_UNREADABLE/);
    assert.throws(() => loadUnitProfile({ORCH_UNIT_CMD_FILE: f, ORCH_UNIT_CMD: '{oops'}), /UNIT_CMD_INVALID/);
  } finally { fs.rmSync(tmp, {recursive: true, force: true}); }
});

test('unit profile normalizes and returns the optional carrier field', () => {
  assert.equal(normalizeUnitProfile({bin: 'x.exe', args: ['{prompt}'], carrier: 'pty'}).carrier, 'pty');
  assert.equal(normalizeUnitProfile({bin: 'x.exe', args: ['{prompt}'], carrier: 'STDIO '}).carrier, 'stdio');
  assert.equal(normalizeUnitProfile({bin: 'x.exe', args: ['{prompt}']}).carrier, null);
  assert.throws(() => normalizeUnitProfile({bin: 'x.exe', args: ['{prompt}'], carrier: 'window'}), /UNSUPPORTED_UNIT_CARRIER/);
});

test('a caller unit runs end-to-end: plan file + unit command, two parallel blocks, zero model calls', async () => {
  const s = setup();
  const ws = fs.mkdtempSync(path.join(family, 'caller-run-'));
  try {
    const unitFile = path.join(s.dir, 'unit.json');
    fs.writeFileSync(unitFile, JSON.stringify(unitProfile(s.unit)));
    const plan = path.join(s.dir, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify(taskLevelPlan()));
    const acceptance = path.join(s.dir, 'acceptance.json');
    fs.writeFileSync(acceptance, JSON.stringify({T001: [{type: 'file', path: 'receipt-T001.json'}], T002: [{type: 'file', path: 'receipt-T002.json'}]}));
    const r = spawnSync(process.execPath, [CLI, '--run-id', 'caller-e2e', '--run-windows', REQUEST], {cwd: ws, env: callEnv({ws, unitFile, planFile: plan, acceptance}), encoding: 'utf8', windowsHide: true, timeout: 240000});
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /spawned headless fakeunit unit/);
    assert.ok(!fs.existsSync(path.join(ws, 'planner-invoked.marker')), 'the model planner must never run when a plan file is supplied');
    const sum = readSummary(ws, 'caller-e2e');
    assert.equal(sum.success, true, JSON.stringify(sum.taskResults).slice(0, 400));
    assert.equal(sum.agent, 'fakeunit');
    assert.equal(sum.unitProfile.id, 'fakeunit');
    assert.deepEqual(Object.values(sum.taskResults).map((t) => t.status), ['verified', 'verified']);
    assert.ok(fs.existsSync(path.join(ws, 'receipt-T001.json')) && fs.existsSync(path.join(ws, 'receipt-T002.json')));
    // 二次验收（只读重检）同样成立
    const v = spawnSync(process.execPath, [CLI, '--verify-run', 'caller-e2e'], {cwd: ws, env: callEnv({ws, unitFile, acceptance}), encoding: 'utf8', windowsHide: true, timeout: 60000});
    assert.equal(v.status, 0, v.stderr || v.stdout);
  } finally { await cleanup(s.dir, ws); }
});

test('custom ORCH_STATE_DIR carries the run ledger through execution and verification', async () => {
  const s = setup();
  const ws = fs.mkdtempSync(path.join(family, 'caller-custom-state-'));
  try {
    const unitFile = path.join(s.dir, 'unit.json');
    fs.writeFileSync(unitFile, JSON.stringify(unitProfile(s.unit)));
    const plan = path.join(s.dir, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify(taskLevelPlan()));
    const acceptance = path.join(s.dir, 'acceptance.json');
    fs.writeFileSync(acceptance, JSON.stringify({T001: [{type: 'file', path: 'receipt-T001.json'}], T002: [{type: 'file', path: 'receipt-T002.json'}]}));
    const stateDir = path.join(ws, 'temp', 'custom-state');
    const env = callEnv({ws, unitFile, planFile: plan, acceptance, extra: {ORCH_STATE_DIR: stateDir}});
    const run = spawnSync(process.execPath, [CLI, '--run-id', 'custom-state', '--run-windows', REQUEST], {cwd: ws, env, encoding: 'utf8', windowsHide: true, timeout: 240000});
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const summary = path.join(stateDir, 'runs', 'custom-state', 'summary.json');
    assert.ok(fs.existsSync(summary), 'the run ledger must follow ORCH_STATE_DIR');
    assert.equal(fs.existsSync(path.join(ws, 'temp', 'orchestrator', 'runs', 'custom-state', 'summary.json')), false, 'the default state path must stay unused');
    const verify = spawnSync(process.execPath, [CLI, '--verify-run', 'custom-state'], {cwd: ws, env, encoding: 'utf8', windowsHide: true, timeout: 60000});
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  } finally { await cleanup(s.dir, ws); }
});

test('resume requires the identical unit command and never redeploys finished work', async () => {
  const s = setup();
  const ws = fs.mkdtempSync(path.join(family, 'caller-resume-'));
  try {
    const unitFile = path.join(s.dir, 'unit.json');
    fs.writeFileSync(unitFile, JSON.stringify(unitProfile(s.unit)));
    const plan = path.join(s.dir, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify(taskLevelPlan()));
    const acceptance = path.join(s.dir, 'acceptance.json');
    fs.writeFileSync(acceptance, JSON.stringify({T001: [{type: 'file', path: 'receipt-T001.json'}], T002: [{type: 'file', path: 'receipt-T002.json'}]}));
    const first = spawnSync(process.execPath, [CLI, '--run-id', 'caller-resume', '--run-windows', REQUEST], {cwd: ws, env: callEnv({ws, unitFile, planFile: plan, acceptance}), encoding: 'utf8', windowsHide: true, timeout: 240000});
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const attemptsBefore = fs.readdirSync(path.join(ws, 'temp', 'orchestrator', 'runs', 'caller-resume', 'attempts', 'B1')).length;

    const again = spawnSync(process.execPath, [CLI, '--resume-run', 'caller-resume'], {cwd: ws, env: callEnv({ws, unitFile, acceptance}), encoding: 'utf8', windowsHide: true, timeout: 240000});
    assert.equal(again.status, 0, again.stderr || again.stdout);
    const sum = readSummary(ws, 'caller-resume');
    assert.equal(sum.success, true);
    assert.equal(fs.readdirSync(path.join(ws, 'temp', 'orchestrator', 'runs', 'caller-resume', 'attempts', 'B1')).length, attemptsBefore, 'a finalized run must not redeploy its units');

    const changed = path.join(s.dir, 'unit-changed.json');
    fs.writeFileSync(changed, JSON.stringify(unitProfile(s.unit, {label: 'FakeUnit-Changed'})));
    const mismatch = spawnSync(process.execPath, [CLI, '--resume-run', 'caller-resume'], {cwd: ws, env: callEnv({ws, unitFile: changed, acceptance}), encoding: 'utf8', windowsHide: true, timeout: 120000});
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr + mismatch.stdout, /unit command differs/);

    if (!CODEX_CLI_SKIP) {
      const env = callEnv({ws, acceptance});
      env.ORCH_AGENT = 'codex';
      const missing = spawnSync(process.execPath, [CLI, '--resume-run', 'caller-resume'], {cwd: ws, env, encoding: 'utf8', windowsHide: true, timeout: 120000});
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr + missing.stdout, /re-supply the identical --unit-cmd/);
    }
  } finally { await cleanup(s.dir, ws); }
});

test('a unit without checkpoints or a failing unit can never fake success', async () => {
  const s = setup();
  const ws = fs.mkdtempSync(path.join(family, 'caller-fake-'));
  try {
    const unitFile = path.join(s.dir, 'unit.json');
    fs.writeFileSync(unitFile, JSON.stringify(unitProfile(s.unit)));
    const plan = path.join(s.dir, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify(taskLevelPlan()));
    const acceptance = path.join(s.dir, 'acceptance.json');
    fs.writeFileSync(acceptance, JSON.stringify({T001: [{type: 'file', path: 'receipt-T001.json'}], T002: [{type: 'file', path: 'receipt-T002.json'}]}));

    // 没有检查点（连 started 都不写）：任务停在无凭证状态，绝不是 verified
    const envNoCp = callEnv({ws, unitFile, planFile: plan, acceptance, extra: {FAKE_UNIT_NO_CHECKPOINTS: '1'}});
    // 预算 360s：本用例的两个 run 是套件里最重的一对（每个块 3 次尝试 × 2 块，单跑实测 ~70-90s）。
    // 2026-09-22 实测：240s 在满载并发下被击穿——真因是采样器管道劫持了引擎退出（已治本，见
    // test/unit-memory-sampler.test.mjs），预算同时放宽到 ~4x 余量，避免把真实跑动读成挂起。
    // 2026-10-26 实测：run 级 deadline 就是 ORCH_MAX_POLL_MS（sdk:262 → runner:333），120s 时引擎在
    // 第 2 次尝试后即被砍断，reserve 循环一次都没进，判词退化成「capacity wait ~0min」而不是本用例
    // 要断言的 checkpoint 判词（单跑 142s 红）。deadline 放宽到 600s 后同一用例 440s 通过
    // （r1 无检查点 190s / r2 失败单元 ~245s）；两次尝试都是产品既定节奏（windowConfirmMs 默认 35s），
    // 不是容量争用，故此处只放宽预算、不动判据。
    const r1 = spawnSync(process.execPath, [CLI, '--run-id', 'caller-fake', '--run-windows', REQUEST], {cwd: ws, env: envNoCp, encoding: 'utf8', windowsHide: true, timeout: 660000});
    assert.equal(r1.status, 1, r1.stdout);
    const sum1 = readSummary(ws, 'caller-fake');
    assert.equal(sum1.success, false);
    assert.ok(Object.values(sum1.taskResults).every((t) => t.status !== 'verified'), JSON.stringify(sum1.taskResults));
    assert.match(JSON.stringify(sum1.taskResults), /No durable task checkpoint/);

    // 单元直接失败（非零退出、无产物、无完成标记）：验收即失败，零假成功
    const ws2 = fs.mkdtempSync(path.join(family, 'caller-fail-'));
    const envFail = callEnv({ws: ws2, unitFile, planFile: plan, acceptance, extra: {FAKE_UNIT_FAIL: '1'}});
    const r2 = spawnSync(process.execPath, [CLI, '--run-id', 'caller-fail', '--run-windows', REQUEST], {cwd: ws2, env: envFail, encoding: 'utf8', windowsHide: true, timeout: 660000});
    assert.equal(r2.status, 1, r2.stdout);
    const sum2 = readSummary(ws2, 'caller-fail');
    assert.equal(sum2.success, false);
    assert.ok(Object.values(sum2.taskResults).every((t) => t.status !== 'verified'), JSON.stringify(sum2.taskResults));
    await cleanup(ws2);
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('unknown agents get the two-path diagnostic; an explicit unit command bypasses host identity', () => {
  // 真正未知的 agent：两条出路诊断（--unit-cmd / adapt 建档）原样给出。
  const noHost = spawnSync(process.execPath, [CLI, '--agent', 'no-such-agent', '--doctor'], {env: callEnv({ws: process.cwd()}), encoding: 'utf8', windowsHide: true, timeout: 60000});
  assert.equal(noHost.status, 0, noHost.stderr);
  const doc = JSON.parse(noHost.stdout);
  assert.match(doc.hostError, /ADAPTER_UNSUPPORTED: no-such-agent/);
  assert.match(doc.hostError, /--unit-cmd/);
  assert.match(doc.hostError, /adapt\.mjs --agent no-such-agent/);
  // 有画像的 agent（hermes 自动挡）：doctor 解析为 profile 宿主（不再报不支持）。
  const profiled = spawnSync(process.execPath, [CLI, '--agent', 'hermes', '--doctor'], {env: callEnv({ws: process.cwd()}), encoding: 'utf8', windowsHide: true, timeout: 60000});
  assert.equal(profiled.status, 0, profiled.stderr || profiled.stdout);
  const pdoc = JSON.parse(profiled.stdout);
  assert.equal(pdoc.hostError, null);
  assert.equal(pdoc.unit, 'profile');
  assert.equal(pdoc.agent, 'hermes');

  const s = setup();
  try {
    const unitFile = path.join(s.dir, 'unit.json');
    fs.writeFileSync(unitFile, JSON.stringify(unitProfile(s.unit)));
    const r = spawnSync(process.execPath, [CLI, '--agent', 'hermes', '--unit-cmd-file', unitFile, '--doctor'], {env: callEnv({ws: s.dir}), encoding: 'utf8', windowsHide: true, timeout: 60000});
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const d = JSON.parse(r.stdout);
    assert.equal(d.agent, 'hermes');
    assert.equal(d.unit, 'caller');
    assert.equal(d.probe, 'none');
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('the maintenance lock still gates caller-driven action entries; --tasks stays read-only', () => {
  const s = setup();
  try {
    const lock = path.join(s.dir, 'lock.json');
    const lockTool = path.join(root, 'scripts', 'maintenance-lock.mjs');
    const locked = spawnSync(process.execPath, [lockTool, 'lock', '--reason', 'caller-driven test'], {env: {...process.env, ORCH_MAINTENANCE_LOCK: lock}, encoding: 'utf8', windowsHide: true, timeout: 60000});
    assert.equal(locked.status, 0, locked.stderr);
    const plan = path.join(s.dir, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify(taskLevelPlan()));
    const env = callEnv({ws: s.dir, planFile: plan});
    env.ORCH_MAINTENANCE_LOCK = lock;
    const r = spawnSync(process.execPath, [CLI, '--run-windows', REQUEST], {env, encoding: 'utf8', windowsHide: true, timeout: 60000});
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /open-tui-orchestrator正在维护更新/);
    const tasks = spawnSync(process.execPath, [CLI, '--tasks', REQUEST], {env, encoding: 'utf8', windowsHide: true, timeout: 60000});
    assert.equal(tasks.status, 0, tasks.stderr);
    assert.equal(jsonFrom(tasks.stdout).tasks.length, 2);
  } finally {
    fs.rmSync(s.dir, {recursive: true, force: true});
  }
});
