import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {normalizeSpawnMode, spawnHeadlessWithRetry} from '../scripts/core/orchestrate-sdk.mjs';
import {runWindows} from '../scripts/core/runner.mjs';
import {CODEX_CLI_SKIP} from './helpers/external.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const family = path.join(root, 'temp');

test('spawn mode normalization: headless is default-capable, exec aliases it, window opts in', () => {
  assert.equal(normalizeSpawnMode('headless'), 'headless');
  assert.equal(normalizeSpawnMode('exec'), 'headless');
  assert.equal(normalizeSpawnMode('WINDOW'), 'window');
  assert.equal(normalizeSpawnMode(''), null);
  assert.throws(() => normalizeSpawnMode('popup'), /UNSUPPORTED_SPAWN_MODE/);
});

test('runWindows persists the chosen spawn mode into the ledger', async () => {
  fs.mkdirSync(family, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(family, 'spawnmode-'));
  const hooks = {
    plan: async () => [{ title: 'A', tasks: [{ prompt: '执行甲' }] }],
    compact: p => p, infer: () => [], prompt: p => p,
    launcher: key => ({ pidf: path.join(workspace, 'window-' + key + '.pid') }),
    register: () => {}, unregister: () => {}, cleanup: () => {}, spawn: async () => false, readPid: () => 0,
  };
  try {
    const sum = await runWindows('执行甲', hooks, { workspace, capacity: 8, runId: 'smode', auth: 'test', coordinator: path.join(workspace, 'temp', 'coordinator'), spawnMode: 'headless' });
    assert.equal(sum.spawnMode, 'headless');
  } finally { await new Promise(r => setTimeout(r, 300)); fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('run-windows reports its spawn mode and rejects unknown modes', { skip: CODEX_CLI_SKIP }, () => {
  const cli = path.join(root, 'cli.mjs');
  const run = args => {
    const env = { ...process.env, ORCH_AGENT: 'codex', ORCH_MAINTENANCE_LOCK: path.join(root, 'temp', 'spawn-mode-lock-none.json') };
    // 默认断言必须测「没有变量时的默认」：本机导出用户级 ORCH_SPAWN_MODE 时判据不得随壳变色。
    delete env.ORCH_SPAWN_MODE;
    return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
  };
  const def = run(['--run-windows', '修复登录页']);
  assert.equal(def.status, 0, def.stderr);
  assert.match(def.stdout, /\[orchestrator\] spawn mode: headless/);
  const win = run(['--mode', 'window', '--run-windows', '修复登录页']);
  assert.equal(win.status, 0, win.stderr);
  assert.match(win.stdout, /\[orchestrator\] spawn mode: window/);
  const bad = run(['--mode', 'popup', '--run-windows', '修复登录页']);
  assert.notEqual(bad.status, 0);
  assert.match(String(bad.stderr || bad.stdout), /UNSUPPORTED_SPAWN_MODE/);
});

test('headless spawn confirms a hidden launcher via pidf and leaves no waiting window', async () => {
  fs.mkdirSync(family, { recursive: true });
  const dir = fs.mkdtempSync(path.join(family, 'headless-spawn-'));
  const lp = path.join(dir, 'win-launch-probe.ps1');
  const pidf = path.join(dir, 'window-probe.pid');
  const lit = s => "'" + String(s).replaceAll("'", "''") + "'";
  // A node child makes the generic warmup probe exit fast; the sleep keeps the launcher alive until cleanup.
  fs.writeFileSync(lp, "$PID | Set-Content -LiteralPath " + lit(pidf) + " -Encoding UTF8\nStart-Process -FilePath 'node' -ArgumentList '-e','setTimeout(()=>{},20000)' | Out-Null\nStart-Sleep -Seconds 20\n");
  try {
    // 0.9.17：辅助窗内存准入参与直连 spawn ⇒ 钉住内存参数，让本判据不随机器剩余内存漂移。
    process.env.ORCH_UNIT_MEM_DEFAULT_MB = '1';
    process.env.ORCH_MIN_FREE_MEM_MB = '1';
    const ok = await spawnHeadlessWithRetry(lp, 'probe', pidf, 1, 'tok-headless-probe', false);
    assert.equal(ok, true);
    let pid = 0;
    for (let i = 0; i < 50 && !pid; i++) {
      try { pid = Number(fs.readFileSync(pidf, 'utf8').replace(/^\uFEFF/, '').trim()); } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(pid > 0, 'pidf must be readable');
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
