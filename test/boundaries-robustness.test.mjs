import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// 审计线 B（鲁棒性与边界）判据：入口失败契约、状态/账本损坏的诊断点名、plan-file 结构校验。
// 期望全部来自项目自己的契约，不是「我希望能扛住」：
//  ① docs/execution-contract.md + README「machine-caller failure contract」：每个公开入口 fail-closed
//     成一条 `[orchestrator] FATAL: <原因>`、无 Node 栈帧（除非 ORCH_DEBUG=1）——由 test/cli-surface.test.mjs 逐条钉住，
//     本文件补齐它没覆盖的三类入口条件（运行时上下文解析失败 / 状态文件不可读 / 调用方给的三个输入文件畸形）。
//  ② orchestrate-sdk.mjs loadJson 自己写的口径：malformed state 不许当成空注册表（fail closed 并点名文件）。
//  ③ docs/caller-driven.md：plan 文件与 unit 文件是调用方输入，畸形必须点名文件与项，不许静默降级。
const root = fileURLToPath(new URL('..', import.meta.url));
const family = path.join(root, 'temp');
const cli = path.join(root, 'cli.mjs');
const REQUEST = '修复登录页；优化购物车';

function workDir(tag) {
  fs.mkdirSync(family, {recursive: true});
  return fs.mkdtempSync(path.join(family, 'bounds-' + tag + '-'));
}

// 与套件其余用例同构：headless、协调器随工作区、机器级维护锁不参与、内存拟合钉死。
function env(ws, extra = {}) {
  const e = {...process.env};
  for (const key of ['ORCH_UNIT_CMD', 'ORCH_UNIT_CMD_FILE', 'ORCH_PLAN_FILE', 'ORCH_CLI', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'NODE_TEST_CONTEXT']) delete e[key];
  e.ORCH_AGENT = 'codex';
  e.ORCH_SPAWN_MODE = 'headless';
  e.WORKSPACE_DIR = ws;
  e.ORCH_STATE_DIR = path.join(ws, 'temp', 'orchestrator');
  e.ORCH_COORDINATOR_DIR = path.join('temp', 'orchestrator', 'coordinator');
  e.ORCH_MAINTENANCE_LOCK = path.join(ws, 'no-maintenance-lock.json');
  e.ORCH_UNIT_MEM_DEFAULT_MB = '64';
  e.ORCH_MIN_FREE_MEM_MB = '64';
  e.ORCH_UNIT_MEM_STORE = path.join(ws, 'unit-memory.json');
  e.ORCH_MAX_POLL_MS = '120000';
  return Object.assign(e, extra);
}

function run(ws, argv, extra = {}, timeout = 120000) {
  const r = spawnSync(process.execPath, [cli, ...argv], {cwd: ws, env: env(ws, extra), encoding: 'utf8', windowsHide: true, timeout});
  const all = String(r.stdout || '') + String(r.stderr || '');
  return {status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), all, frames: all.match(/^\s+at /gm) || []};
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, text);
}

// 调用方自助通道现场：一个假单元 + 计划文件 + 验收契约（判据与 test/caller-driven.test.mjs 同构）。
const FAKE_UNIT = `import fs from 'node:fs';
const args = process.argv.slice(2);
const i = args.indexOf('--prompt-file');
const prompt = fs.readFileSync(i >= 0 ? args[i + 1] : args[args.length - 1], 'utf8');
const token = /【本块唯一标识】\\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(prompt)?.[1] || 'tok';
for (const id of [...new Set([...prompt.matchAll(/任务 (T\\d+)/g)].map((m) => m[1]))]) fs.writeFileSync('receipt-' + id + '.json', JSON.stringify({ok: true, token, id}));
console.log('__ORCH_DONE__ ' + token);
`;

function scene(tag) {
  const ws = workDir(tag);
  const unit = path.join(ws, 'fakeunit.mjs');
  fs.writeFileSync(unit, FAKE_UNIT);
  const unitCmd = path.join(ws, 'unit.json');
  fs.writeFileSync(unitCmd, JSON.stringify({schema: 1, id: 'probeunit', bin: process.execPath, args: [unit, '--prompt-file', '{promptFile}'], promptDelivery: 'file'}));
  const plan = path.join(ws, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({schema: 1, tasks: [
    {id: 'T001', summary: '修复登录页', kind: 'project', project: '07', conflict_hints: ['file:src/login.js'], depends_on: []},
    {id: 'T002', summary: '优化购物车', kind: 'project', project: '08', conflict_hints: ['file:src/cart.js'], depends_on: []},
  ]}));
  const acceptance = path.join(ws, 'acceptance.json');
  fs.writeFileSync(acceptance, JSON.stringify({T001: [{type: 'file', path: 'receipt-T001.json'}], T002: [{type: 'file', path: 'receipt-T002.json'}]}));
  return {ws, unit, unitCmd, plan, acceptance, state: path.join(ws, 'temp', 'orchestrator')};
}

function cleanup(dir) {
  for (let i = 0; i < 3; i++) { try { fs.rmSync(dir, {recursive: true, force: true}); return; } catch { /* retry */ } }
}

// —— ① 入口失败契约：运行时上下文解析失败也必须是「一条 FATAL、无栈帧」。 ————————————————
test('an unusable ORCH_STATE_DIR still fails closed as one FATAL line (no Node stack)', () => {
  const ws = workDir('entry-contract');
  try {
    const escape = path.join(root, 'definitely-outside-the-workspace', 'temp', 'orchestrator');
    for (const argv of [['--status'], ['--tasks', REQUEST], ['--run-windows', REQUEST]]) {
      const r = run(ws, ['--workspace', ws, ...argv], {ORCH_STATE_DIR: escape}, 60000);
      assert.equal(r.status, 1, `${argv[0]} must exit 1: ` + r.all.slice(0, 300));
      assert.match(r.all, /\[orchestrator\] FATAL: ORCH_STATE_DIR must stay under the initiating workspace temp directory/, `${argv[0]}: ` + r.all.slice(0, 300));
      assert.equal(r.frames.length, 0, `${argv[0]} leaked a Node stack: ` + r.all.slice(0, 300));
      assert.doesNotMatch(r.all, /^\s*throw new Error/m);
    }
    // --help 是纯用法输出：不解析运行时上下文，坏 ORCH_STATE_DIR 也不该拦住它。
    const help = run(ws, ['--help'], {ORCH_STATE_DIR: escape}, 60000);
    assert.equal(help.status, 0, '--help must stay usable: ' + help.all.slice(0, 300));
    assert.match(help.stdout, /--run-windows/, help.stdout.slice(0, 300));
    assert.equal(help.frames.length, 0, help.all.slice(0, 300));
    // 启动子进程本身失败（--workspace 指向不存在的目录 ⇒ cwd 无效）同样是入口裁决：
    // 旧行为只甩一行 'spawn … node.exe ENOENT'，没有 FATAL 前缀和使用出路。
    const missingWorkspace = path.join(root, 'no-such-workspace-for-bounds');
    const spawnFail = spawnSync(process.execPath, [cli, '--workspace', missingWorkspace, '--status'], {
      // 状态目录跟着这个不存在的工作区走：上下文解析要通过，才能走到「以无效 cwd 启动引擎」那一步。
      cwd: root, env: env(ws, {ORCH_STATE_DIR: path.join(missingWorkspace, 'temp', 'orchestrator')}), encoding: 'utf8', windowsHide: true, timeout: 60000,
    });
    const spawnAll = String(spawnFail.stdout || '') + String(spawnFail.stderr || '');
    assert.equal(spawnFail.status, 1, spawnAll.slice(0, 300));
    // 两条线合并后此处的裁决点前移了：入口现在先做「工作区必须是真实目录」的前置检查，
    // 于是这里在 spawn 之前就以 `Workspace is not a directory: <path>` 拦下——比旧的一行
    // `spawn … node.exe ENOENT` 更可读，仍是同一失败契约（一行 FATAL、零栈帧）。若将来该前置
    // 被移除，则退回 spawn-ENOENT 形态；两种都接受，但都必须带 FATAL 前缀且不泄漏栈。
    assert.match(spawnAll, /\[orchestrator\] FATAL: (Workspace is not a directory: .*|.*ENOENT)/, spawnAll.slice(0, 300));
    assert.equal((spawnAll.match(/^\s+at /gm) || []).length, 0, spawnAll.slice(0, 300));
  } finally { cleanup(ws); }
});

// —— ② 状态文件不可读/被占位：不许静默当成「空注册表」 ————————————————————————————————
test('an unusable state path fails closed instead of reporting an empty board', () => {
  const ws = workDir('state-unusable');
  try {
    // 首次运行（状态目录不存在）仍然是一份正常的空看板。
    const fresh = run(ws, ['--status'], {}, 60000);
    assert.equal(fresh.status, 0, fresh.all.slice(0, 300));
    assert.match(fresh.stdout, /alive agent TUI windows/);

    // 状态目录位置被同名文件占住：读注册表在 Windows 上会报 ENOENT（不是 ENOTDIR），
    // 旧行为把它当「首次运行」⇒ 静默打印 (none)。必须 fail-closed 且点名文件。
    fs.mkdirSync(path.join(ws, 'temp'), {recursive: true});
    fs.writeFileSync(path.join(ws, 'temp', 'orchestrator'), 'not a directory');
    const blocked = run(ws, ['--status'], {}, 60000);
    assert.equal(blocked.status, 1, blocked.all.slice(0, 400));
    assert.match(blocked.all, /\[orchestrator\] FATAL: Invalid orchestration state: .*orchestrator-windows\.json/, blocked.all.slice(0, 400));
    assert.doesNotMatch(blocked.stdout, /\(none\)/, 'an unreadable state must not be reported as an empty board: ' + blocked.stdout);
  } finally { cleanup(ws); }
});

// —— ③ 状态/账本被截断：诊断必须点名文件 ————————————————————————————————————————
test('a truncated coordinator ledger names its file instead of leaking a bare JSON error', () => {
  const s = scene('ledger-truncated');
  try {
    for (const [file, marker] of [['leases.json', /Invalid orchestration state: .*leases\.json/], ['run-owners.json', /Invalid orchestration state: .*run-owners\.json/]]) {
      const target = path.join(s.state, 'coordinator', file);
      write(target, file === 'leases.json' ? '{"broken"' : '[bad json');
      const r = run(s.ws, ['--run-id', 'trunc-' + file.replace(/\W/g, ''), '--plan-file', s.plan, '--unit-cmd-file', s.unitCmd, '--run-windows', REQUEST], {}, 120000);
      assert.equal(r.status, 1, `${file}: ` + r.all.slice(0, 300));
      assert.match(r.all, marker, `${file}: ` + r.all.slice(0, 300));
      assert.equal(r.frames.length, 0, `${file}: ` + r.all.slice(0, 300));
      assert.ok(!fs.existsSync(path.join(s.ws, 'receipt-T001.json')), `${file}: no unit may run on corrupted state`);
      fs.rmSync(target, {force: true});
    }
  } finally { cleanup(s.ws); }
});

test('a truncated run ledger names its file on verify and resume', () => {
  const s = scene('run-ledger');
  try {
    const dir = path.join(s.state, 'runs', 'half-ledger');
    write(path.join(dir, 'summary.json'), '{"protocol":2,"runId":"half-ledger"');
    for (const argv of [['--verify-run', 'half-ledger'], ['--unit-cmd-file', s.unitCmd, '--resume-run', 'half-ledger']]) {
      const r = run(s.ws, argv, {}, 60000);
      assert.equal(r.status, 1, `${argv.join(' ')}: ` + r.all.slice(0, 300));
      assert.match(r.all, /Invalid run ledger: .*summary\.json/, `${argv.join(' ')}: ` + r.all.slice(0, 300));
      assert.equal(r.frames.length, 0, `${argv.join(' ')}: ` + r.all.slice(0, 300));
    }
    // 缺失（不是损坏）仍走原来的「找不到」口径，避免把两种情况混为一谈。
    const missing = run(s.ws, ['--verify-run', 'no-such-run-anywhere'], {}, 60000);
    assert.match(missing.all, /Run not found: no-such-run-anywhere/, missing.all.slice(0, 300));
  } finally { cleanup(s.ws); }
});

test('a malformed acceptance file names its file instead of a bare JSON error', () => {
  const s = scene('acceptance');
  try {
    const bad = path.join(s.ws, 'acceptance-broken.json');
    fs.writeFileSync(bad, '{"T001":[{"type":"file"');
    const r = run(s.ws, ['--run-id', 'acc-broken', '--plan-file', s.plan, '--unit-cmd-file', s.unitCmd, '--acceptance', bad, '--run-windows', REQUEST], {}, 120000);
    assert.equal(r.status, 1, r.all.slice(0, 300));
    assert.match(r.all, /ACCEPTANCE_INVALID: .*acceptance-broken\.json/, r.all.slice(0, 300));
    assert.equal(r.frames.length, 0, r.all.slice(0, 300));
  } finally { cleanup(s.ws); }
});

// —— ④ plan-file 的结构畸形：点名文件 + 项，而不是裸 TypeError 或静默接受 ————————————————
test('structural plan-file defects are refused by name (file + item), never silently accepted', () => {
  const ws = workDir('plan-structure');
  try {
    const covered = '修复登录页；优化购物车';
    const cases = [
      ['blocks 里出现 null', {blocks: [null]}, /blocks\[0\]/],
      ['block.tasks 里出现 null', {blocks: [{type: 'independent', title: 'A', tasks: [null]}]}, /blocks\[0\]\.tasks\[0\]/],
      ['conflictKeys 类型错', {blocks: [{type: 'independent', title: 'A', conflictKeys: 'file:x', tasks: [{id: 't1', prompt: covered}]}]}, /conflictKeys/],
      ['dependsOn 类型错', {blocks: [{type: 'independent', title: 'A', dependsOn: 'A', tasks: [{id: 't1', prompt: covered}]}]}, /dependsOn/],
      ['block.type 非法枚举', {blocks: [{type: 'weird', title: 'A', tasks: [{id: 't1', prompt: covered}]}]}, /type/],
      ['block.title 类型错', {blocks: [{type: 'independent', title: 7, tasks: [{id: 't1', prompt: covered}]}]}, /title/],
      ['task.prompt 类型错', {blocks: [{type: 'independent', title: 'A', tasks: [{id: 't1', prompt: 42}]}]}, /prompt/],
      ['tasks 里出现非对象', {tasks: [null]}, /tasks\[0\]/],
      ['tasks 元素缺 id', {tasks: [{summary: covered}]}, /tasks\[0\]/],
    ];
    for (const [label, doc, marker] of cases) {
      const file = path.join(ws, 'plan-' + label.replace(/\W+/g, '_') + '.json');
      fs.writeFileSync(file, JSON.stringify(doc));
      const r = run(ws, ['--plan', '--plan-file', file, covered], {}, 60000);
      assert.equal(r.status, 1, `${label}: ` + r.all.slice(0, 300));
      assert.match(r.all, /FATAL: PLAN_FILE_INVALID/, `${label}: ` + r.all.slice(0, 300));
      assert.match(r.all, marker, `${label} must name the offending item: ` + r.all.slice(0, 300));
      assert.ok(r.all.includes(file), `${label} must name the plan file: ` + r.all.slice(0, 300));
      assert.equal(r.frames.length, 0, `${label}: ` + r.all.slice(0, 300));
    }
    // 覆盖不足（同义改写的块）仍是**回退成一条串行块**，不是报错——既有契约不许被我这条判据改掉。
    const paraphrase = path.join(ws, 'plan-paraphrase.json');
    fs.writeFileSync(paraphrase, JSON.stringify({schema: 1, blocks: [
      {type: 'independent', title: 'B1', dependsOn: [], conflictKeys: ['file:src/login.js'], tasks: [{id: 't1', title: 'login', prompt: '修一下登录页'}]},
    ]}));
    const r = run(ws, ['--plan', '--plan-file', paraphrase, covered], {}, 60000);
    assert.equal(r.status, 0, r.all.slice(0, 300));
    assert.deepEqual(JSON.parse(r.stdout).blocks.map((b) => b.title), ['complete-inventory'], r.stdout.slice(0, 300));
  } finally { cleanup(ws); }
});
