import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// 2026-09-22 第 3 轮：公开入口的**全表面**判据（离线、零模型调用、零弹窗）。
// 逐条钉住每个入口的对外契约：退出码、单行诊断（`[orchestrator] FATAL: …`）、无 Node 栈帧、
// 该只读的必须只读。坏参数/坏平台/缺 CLI 一律 fail-closed —— 机器调用方据此才能把「没做」
// 与「做了」分开。坏平台（Windows-only）由 test/windows-only.test.mjs 用注入平台的纯函数判据覆盖。

const root = fileURLToPath(new URL('..', import.meta.url));
const family = path.join(root, 'temp');
const cli = path.join(root, 'cli.mjs');
const REQUEST = '修复登录页；优化购物车';

function workDir(tag) {
  fs.mkdirSync(family, {recursive: true});
  return fs.mkdtempSync(path.join(family, 'cli-' + tag + '-'));
}

// 与套件其余用例同构的环境：钉 headless（绝不弹窗）、协调器随工作区、机器级维护锁不参与。
function cliEnv(ws, extra = {}) {
  const env = {...process.env};
  for (const key of ['ORCH_UNIT_CMD', 'ORCH_UNIT_CMD_FILE', 'ORCH_PLAN_FILE', 'ORCH_CLI', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'NODE_TEST_CONTEXT']) delete env[key];
  env.ORCH_AGENT = 'codex';
  env.ORCH_SPAWN_MODE = 'headless';
  env.WORKSPACE_DIR = ws;
  env.ORCH_STATE_DIR = path.join(ws, 'temp', 'orchestrator');
  env.ORCH_COORDINATOR_DIR = path.join('temp', 'orchestrator', 'coordinator');
  env.ORCH_MAINTENANCE_LOCK = path.join(ws, 'no-maintenance-lock.json');
  env.ORCH_UNIT_MEM_DEFAULT_MB = '64';
  env.ORCH_MIN_FREE_MEM_MB = '64';
  env.ORCH_UNIT_MEM_STORE = path.join(ws, 'unit-memory.json');
  return Object.assign(env, extra);
}

function run(ws, argv, extra = {}, timeout = 120000) {
  const r = spawnSync(process.execPath, [cli, ...argv], {cwd: ws, env: cliEnv(ws, extra), encoding: 'utf8', windowsHide: true, timeout});
  return {...r, all: String(r.stdout || '') + String(r.stderr || ''), frames: (String(r.stdout || '') + String(r.stderr || '')).match(/^\s+at /gm) || []};
}

function cleanup(dir) {
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(dir, {recursive: true, force: true}); return; } catch { /* retry */ }
  }
}

// 每次用例一个独立工作区，跑完即收（家族目录写在仓库 temp 下，与套件其余临时工作区同处一家）。
function withWorkspace(tag, fn) {
  const ws = workDir(tag);
  try { return fn(ws); } finally { cleanup(ws); }
}

test('--version is pure metadata: correct shape, exit 0, and it touches nothing', () => {
  withWorkspace('version', (ws) => {
    const r = run(ws, ['--version']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /^open-tui-orchestrator \d+\.\d+\.\d+(?:-\d+)? \(core \d+\.\d+\.\d+(?:-\d+)?\)$/m, r.stdout);
    assert.equal(r.frames.length, 0, r.all);
    assert.ok(!fs.existsSync(path.join(ws, 'temp')), '--version must not create state: ' + r.all);
  });
});

test('--help / no args print the entry list and exit 0', () => {
  withWorkspace('help', (ws) => {
    for (const argv of [['--help'], []]) {
      const r = run(ws, argv);
      assert.equal(r.status, 0, r.all);
      for (const entry of ['--install-deps', '--doctor', '--plan', '--tasks', '--run-windows', '--resume-run', '--verify-run', '--spawn', '--status', '--watch', '--version', '--mode']) {
        assert.ok(r.stdout.includes(entry), `usage must name ${entry}: ` + r.stdout.slice(0, 400));
      }
    }
  });
});

test('an unrecognised entry fails closed instead of printing usage and exiting 0', () => {
  withWorkspace('unknown-entry', (ws) => {
    const r = run(ws, ['--frobnicate', REQUEST]);
    assert.equal(r.status, 1, 'a typo must not read as a successful run: ' + r.all);
    assert.match(r.all, /\[orchestrator\] FATAL: Unknown entry: --frobnicate/, r.all);
    assert.equal(r.frames.length, 0, r.all);
    assert.ok(!/Usage:/.test(r.stdout), 'a refusal must not also print the usage banner: ' + r.stdout);
  });
});

test('flags that need a value refuse with exit 2 and a one-line reason', () => {
  withWorkspace('bad-values', (ws) => {
    for (const flag of ['--agent', '--cli', '--workspace']) {
      const r = run(ws, [flag]);
      assert.equal(r.status, 2, `${flag}: ` + r.all);
      assert.match(r.stderr, new RegExp(flag.replace(/--/, '--') + ' needs a value'), r.all);
    }
  });
});

test('--doctor always reports a clean JSON document (hostError null only for a usable host)', () => {
  withWorkspace('doctor', (ws) => {
    const ok = run(ws, ['--agent', 'codex', '--doctor']);
    assert.equal(ok.status, 0, ok.all);
    // 机器可读入口的 stdout 必须是纯数据（进度/诊断走 stderr）：调用方直接 JSON.parse 即可。
    assert.doesNotMatch(ok.stdout, /^\[orchestrator\]/m, 'stdout must stay pure data: ' + ok.stdout.slice(0, 300));
    const good = JSON.parse(ok.stdout);
    assert.equal(good.hostError, null, ok.stdout);
    assert.equal(ok.frames.length, 0, ok.all);
    // 缺 CLI：诊断（hostError 有话说）而不是崩溃；这条路径不得静默成功
    const bad = run(ws, ['--agent', 'codex', '--cli', path.join(ws, 'nope', 'nope.exe'), '--doctor']);
    assert.equal(bad.status, 0, bad.all);
    const report = JSON.parse(bad.stdout);
    assert.match(String(report.hostError), /CLI_MISSING/, bad.stdout);
    assert.equal(bad.frames.length, 0, bad.all);
    // 未知 agent：两条出路必须原样给出（调用方自助通道 / adapt 建档）
    const unknown = run(ws, ['--agent', 'no-such-agent', '--doctor']);
    const paths = JSON.parse(unknown.stdout);
    assert.match(String(paths.hostError), /ADAPTER_UNSUPPORTED/, unknown.stdout);
    assert.match(String(paths.hostError), /--unit-cmd/, unknown.stdout);
    assert.match(String(paths.hostError), /adapt\.mjs/, unknown.stdout);
  });
});

test('--tasks is read-only and needs no host CLI at all', () => {
  withWorkspace('tasks', (ws) => {
    const r = run(ws, ['--cli', path.join(ws, 'nope', 'nope.exe'), '--tasks', REQUEST]);
    assert.equal(r.status, 0, r.all);
    assert.doesNotMatch(r.stdout, /^\[orchestrator\]/m, 'stdout must stay pure data: ' + r.stdout.slice(0, 300));
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.kind, 'tasks');
    assert.deepEqual(doc.tasks.map((t) => t.id), ['T001', 'T002']);
    assert.ok(!fs.existsSync(path.join(ws, 'temp', 'orchestrator', 'runs')), 'the ledger helper must not create runs');
  });
});

test('unreadable inputs and unknown runs fail closed with one diagnostic line', () => {
  withWorkspace('fail-closed', (ws) => {
    const cases = [
      {argv: ['--plan', '--plan-file', path.join(ws, 'nope', 'plan.json'), REQUEST], re: /FATAL: PLAN_FILE_UNREADABLE/},
      {argv: ['--run-windows', '--plan-file', path.join(ws, 'nope', 'plan.json'), REQUEST], re: /FATAL: PLAN_FILE_UNREADABLE/},
      {argv: ['--run-windows', '--unit-cmd-file', path.join(ws, 'nope', 'unit.json'), REQUEST], re: /FATAL: UNIT_CMD_UNREADABLE/},
      {argv: ['--plan', '--unit-cmd-file', path.join(ws, 'nope', 'unit.json'), REQUEST], re: /FATAL: UNIT_CMD_UNREADABLE/},
      {argv: ['--verify-run', 'nosuch-run-cli-surface'], re: /FATAL: Run not found: nosuch-run-cli-surface/},
      {argv: ['--resume-run', 'nosuch-run-cli-surface'], re: /FATAL: Run not found: nosuch-run-cli-surface/},
      {argv: ['--watch', 'nosuch-run-cli-surface'], re: /FATAL: Run not found: nosuch-run-cli-surface/, extra: {ORCH_WATCH_GRACE_MS: '300'}},
      {argv: ['--run-windows'], re: /FATAL: --run-windows needs a request/},
      {argv: ['--run', REQUEST], re: /REFUSED: headless --run\/--exec is disabled/},
      {argv: ['--exec', REQUEST], re: /REFUSED: headless --run\/--exec is disabled/},
      {argv: ['--acceptance'], re: /FATAL: --acceptance needs a value/},
    ];
    for (const c of cases) {
      const r = run(ws, c.argv, c.extra || {}, 60000);
      assert.equal(r.status, 1, `${c.argv[0]} must exit 1: ` + r.all);
      assert.match(r.all, c.re, `${c.argv[0]}: ` + r.all.slice(0, 400));
      assert.equal(r.frames.length, 0, `${c.argv[0]} leaked a Node stack: ` + r.all);
    }
  });
});

test('a missing CLI fails closed for every host-needing entry (and never pops a window)', () => {
  withWorkspace('missing-cli', (ws) => {
    const badCli = path.join(ws, 'nope', 'nope.exe');
    for (const entry of ['--plan', '--run-windows', '--spawn', '--selftest-close']) {
      const argv = ['--agent', 'codex', '--cli', badCli, entry, '标题', REQUEST];
      const r = run(ws, argv, {}, 60000);
      assert.equal(r.status, 1, `${entry}: ` + r.all);
      assert.match(r.all, /\[orchestrator\] FATAL: CLI_MISSING: codex/, `${entry}: ` + r.all.slice(0, 300));
      assert.equal(r.frames.length, 0, `${entry}: ` + r.all);
    }
    assert.equal(fs.existsSync(path.join(ws, 'temp', 'orchestrator', 'orchestrator-windows.json')), false, 'a refused entry must not register a window');
  });
});

test('--status and --install-deps are repeatable, read-only, and offline', () => {
  withWorkspace('repeatable', (ws) => {
    const status = run(ws, ['--status']);
    assert.equal(status.status, 0, status.all);
    assert.match(status.stdout, /alive agent TUI windows/, status.stdout);
    assert.doesNotMatch(status.stdout, /network policy skipped/, 'the network note belongs on stderr: ' + status.stdout.slice(0, 300));
    const first = run(ws, ['--install-deps']);
    assert.equal(first.status, 0, first.all);
    assert.equal(JSON.parse(first.stdout).ok, true, first.stdout);
    const second = run(ws, ['--install-deps']);
    assert.equal(second.status, 0, second.all);
    assert.equal(JSON.parse(second.stdout).action, 'already-present', second.stdout);
    assert.equal(second.frames.length, 0, second.all);
  });
});

test('--clear-cache reports and exits 0 whether or not a cache exists', () => {
  withWorkspace('clear-cache', (ws) => {
    const r = run(ws, ['--clear-cache']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /decompose cache (cleared|nothing to clear)/, r.stdout);
  });
});

test('a caller-supplied plan file makes --plan fully deterministic — no host, no model call', () => {
  withWorkspace('plan-file', (ws) => {
    const plan = path.join(ws, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify({schema: 1, kind: 'tasks', tasks: [
      {id: 'T001', summary: '修复登录页', kind: 'project', project: '07', conflict_hints: ['file:src/login.js'], depends_on: []},
      {id: 'T002', summary: '优化购物车', kind: 'project', project: '08', conflict_hints: ['file:src/cart.js'], depends_on: []},
    ]}));
    // 刻意给一个不存在的宿主 CLI：带计划文件的 --plan 必须在解析宿主之前就做完（零模型调用的硬证据）。
    const r = run(ws, ['--cli', path.join(ws, 'nope', 'nope.exe'), '--plan', '--plan-file', plan, REQUEST]);
    assert.equal(r.status, 0, r.all);
    assert.doesNotMatch(r.stdout, /^\[orchestrator\]/m, 'stdout must stay pure data: ' + r.stdout.slice(0, 300));
    const {blocks} = JSON.parse(r.stdout);
    assert.deepEqual(blocks.map((b) => b.title), ['proj-07', 'proj-08'], r.stdout);
    assert.equal(r.frames.length, 0, r.all);
  });
});

// 2026-09-23 审计轮：入口自己（解析运行上下文 / 解析工作区）此前不在失败契约之内——
// resolveRuntimeContext 在 cli.mjs 顶层未捕获，坏 ORCH_STATE_DIR 会把 7 帧 Node 栈甩给机器调用方；
// 工作区不是目录时则只回 Node 的 `spawn <node.exe> ENOENT`。下面三条把这段入口面钉住。
// 红例：把 cli.mjs 的 try/catch 或工作区预检去掉 ⇒ 前两条必红（栈帧 = 7）。
test('a broken runtime context fails closed with one FATAL line and zero stack frames', () => {
  withWorkspace('context-refuse', (ws) => {
    // 越界状态目录：必须留在 workspace/temp 下（scripts/core/runtime-context.mjs 的既有契约）。
    const outside = path.join(ws, '..', 'orchestrator-outside-' + path.basename(ws));
    for (const argv of [['--status'], ['--doctor'], ['--tasks', REQUEST], ['--plan', REQUEST]]) {
      const r = run(ws, argv, {ORCH_STATE_DIR: outside}, 60000);
      assert.equal(r.status, 1, `${argv[0]} must fail closed: ` + r.all);
      assert.match(r.stderr, /^\[orchestrator\] FATAL: /m, `${argv[0]}: ` + r.all);
      assert.equal(r.frames.length, 0, `${argv[0]} leaked a Node stack: ` + r.all);
      assert.equal(r.stdout.trim(), '', `${argv[0]} must not print data when it refuses: ` + r.all);
    }
  });
});

test('--help and --install-deps stay reachable when the runtime context is broken', () => {
  withWorkspace('context-neutral', (ws) => {
    // 这三个入口是排障用的中立面（scripts/platform-guard.mjs 的 PLATFORM_NEUTRAL_ARGS 同义）：
    // 环境本身坏掉（越界状态目录）时它们仍必须可用，否则用户连自救入口都够不着。
    const outside = path.join(ws, '..', 'orchestrator-outside-' + path.basename(ws));
    const help = run(ws, ['--help'], {ORCH_STATE_DIR: outside}, 60000);
    assert.equal(help.status, 0, help.all);
    assert.ok(help.stdout.includes('--doctor') && help.stdout.includes('--install-deps'), help.stdout.slice(0, 200));
    const shortHelp = run(ws, ['-h'], {ORCH_STATE_DIR: outside}, 60000);
    assert.equal(shortHelp.status, 0, shortHelp.all);
    assert.ok(shortHelp.stdout.includes('--doctor') && shortHelp.stdout.includes('--install-deps'), shortHelp.stdout.slice(0, 200));
    const deps = run(ws, ['--install-deps'], {ORCH_STATE_DIR: outside}, 300000);
    assert.equal(deps.frames.length, 0, deps.all);
    assert.doesNotMatch(deps.all, /FATAL/, 'the bootstrap entry must not be gated by the runtime context: ' + deps.all);
    const shim = path.join(root, 'scripts', 'node_modules', '@openai', 'codex-sdk', 'package.json');
    if (fs.existsSync(shim)) {
      // 依赖已在位：幂等回报、stdout 纯数据、不联网。
      assert.equal(deps.status, 0, deps.all);
      assert.equal(JSON.parse(deps.stdout).action, 'already-present', deps.stdout);
    }
  });
});

test('a workspace that is not a directory refuses with one readable line (never a raw spawn ENOENT)', () => {
  const ws = workDir('not-a-directory');
  try {
    const file = path.join(ws, 'note.txt');
    fs.writeFileSync(file, 'this is a file, not a workspace\n');
    const missing = path.join(ws, 'does-not-exist');
    for (const target of [file, missing]) {
      // cwd 不存在时 Node 只回 `spawn <node.exe> ENOENT`：既不指出哪个路径错，也不符合 FATAL 契约。
      const r = run(ws, ['--agent', 'codex', '--doctor'], {WORKSPACE_DIR: target, ORCH_STATE_DIR: path.join(target, 'temp', 'orchestrator')}, 60000);
      assert.equal(r.status, 1, r.all);
      assert.match(r.stderr, /^\[orchestrator\] FATAL: Workspace is not a directory/m, r.all);
      assert.doesNotMatch(r.all, /ENOENT/, 'a raw spawn ENOENT must never reach the caller: ' + r.all);
      assert.equal(r.frames.length, 0, r.all);
    }
  } finally { cleanup(ws); }
});
