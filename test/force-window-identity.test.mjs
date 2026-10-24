import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {powershellExe, systemToolExe} from '../scripts/core/contracts.mjs';
import {launcherIdentity, processSnapshot} from '../scripts/core/leases.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const force = path.join(repo, 'scripts', 'open-tui-orchestrator-force.mjs');
const core = path.join(repo, 'scripts', 'core', 'orchestrate-sdk.mjs');
const family = path.resolve(repo, 'temp');
const ps7 = powershellExe();
const psq = value => "'" + String(value).replaceAll("'", "''") + "'";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs = 15000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return Boolean(predicate());
}

function runForce(args, env) {
  // A single --status/--verify costs 10-15 s here: processSnapshot() is one Get-CimInstance
  // Win32_Process spawn (measured 2-11 s on this box). Keep the budget well above that.
  const result = spawnSync(process.execPath, [force, ...args], {
    cwd: repo,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  });
  return {...result, all: String(result.stdout || '') + String(result.stderr || '')};
}

function baseEnv(root, state) {
  const env = {...process.env, WORKSPACE_DIR: root, ORCH_STATE_DIR: state, ORCH_MAINTENANCE_LOCK: path.join(root, 'no-maintenance-lock.json')};
  delete env.ORCH_WINDOW;
  delete env.ORCH_WINDOW_TOKEN;
  return env;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function killOwned(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill(); } catch {}
  if (process.platform === 'win32' && child.pid) {
    try { spawnSync(systemToolExe('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, timeout: 10000}); } catch {}
  }
}

test('codex launcher returns a private sanction token, wires it, and does not print it', {skip: process.platform !== 'win32'}, () => {
  const root = fs.mkdtempSync(path.join(family, 'force-token-'));
  const state = path.join(root, 'temp', 'state');
  fs.mkdirSync(state, {recursive: true});
  const returnFile = path.join(state, 'launcher-return.json');
  const childSource = `
    import fs from 'node:fs';
    import {writeInteractiveLauncher} from ${JSON.stringify(pathToFileURL(core).href)};
    const result = writeInteractiveLauncher('token-test', '任务\\n【本块唯一标识】B1-token-test 完成', 'rid');
    fs.writeFileSync(${JSON.stringify(returnFile)}, JSON.stringify(result));
    console.log('RETURNED');
  `;
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childSource], {
      cwd: repo,
      env: {...process.env, ORCH_AGENT: 'codex', WORKSPACE_DIR: root, ORCH_STATE_DIR: state, ORCH_MAINTENANCE_LOCK: path.join(root, 'no-maintenance-lock.json')},
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
    });
    const output = String(child.stdout || '') + String(child.stderr || '');
    assert.equal(child.status, 0, output);
    assert.match(String(child.stdout || ''), /RETURNED/);
    const result = JSON.parse(fs.readFileSync(returnFile, 'utf8'));
    assert.match(String(result.sanctionToken || ''), /^[a-f0-9]{36}$/);
    const body = fs.readFileSync(result.lp, 'utf8');
    assert.match(body, /\$env:ORCH_WINDOW = '1'/);
    assert.ok(body.includes("$env:ORCH_WINDOW_TOKEN = '" + result.sanctionToken + "'"));
    assert.doesNotMatch(output, new RegExp(result.sanctionToken));
    assert.ok(!output.includes('sanctionToken'), 'the private token must be returned to the caller, not printed');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('liveWindows rejects a command-only Start-Sleep process even with a copied token and identity record', {skip: process.platform !== 'win32'}, async () => {
  const root = fs.mkdtempSync(path.join(family, 'force-fake-window-'));
  const state = path.join(root, 'temp', 'state');
  fs.mkdirSync(state, {recursive: true});
  fs.writeFileSync(path.join(state, '.orchestrator-enabled'), String(Date.now()), 'utf8');
  const pidFile = path.join(state, 'window-fake.pid');
  const env = baseEnv(root, state);
  let fake = null;
  try {
    fake = spawn(ps7, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 60 # --run-windows'], {cwd: root, env, windowsHide: true, stdio: 'ignore'});
    fs.writeFileSync(pidFile, String(fake.pid), 'utf8');
    await waitUntil(() => {
      try { return processSnapshot().has(fake.pid); } catch { return false; }
    }, 60000, 200);
    const snapshot = processSnapshot();
    const identity = snapshot.get(fake.pid);
    assert.ok(identity, 'the fixture process must be observable before the registry is written');
    writeJson(path.join(state, 'orchestrator-windows.json'), [{
      id: 'fake-window',
      title: 'fake-window',
      keys: ['file:fake.txt'],
      pidFile,
      pid: fake.pid,
      identity,
      sanctionToken: 'f'.repeat(36),
    }]);
    const status = runForce(['--status'], env);
    assert.equal(status.status, 0, status.all);
    assert.match(status.all, /alive execution windows:\s*0/);
  } finally {
    killOwned(fake);
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('sanctionedWindow fails closed when process identity snapshot is unknown', {skip: process.platform !== 'win32'}, () => {
  const root = fs.mkdtempSync(path.join(family, 'force-unknown-snapshot-'));
  const state = path.join(root, 'temp', 'state');
  fs.mkdirSync(state, {recursive: true});
  const childSource = `
    import {sanctionedWindow} from ${JSON.stringify(pathToFileURL(force).href)};
    const window = {sanctionToken: 'x', identity: {ProcessId: 101, Started: '2026-10-04T00:00:00.000Z', Name: 'pwsh.exe', CommandLine: 'trusted'}};
    const result = sanctionedWindow([window], {ORCH_WINDOW: '1', ORCH_WINDOW_TOKEN: 'x'}, {snapshot() { throw new Error('unknown snapshot'); }});
    console.log(result === null ? 'FAIL_CLOSED' : 'OPEN');
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', childSource], {
      cwd: repo,
      env: {...baseEnv(root, state), ORCH_AGENT: 'codex'},
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
    });
    const output = String(result.stdout || '') + String(result.stderr || '');
    assert.equal(result.status, 0, output);
    assert.match(output, /FAIL_CLOSED/);
    assert.doesNotMatch(output, /OPEN/);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('only the real launcher ancestor may use its token; outside verify is indeterminate and in-window verify passes', {skip: process.platform !== 'win32', timeout: 300000}, async () => {
  const root = fs.mkdtempSync(path.join(family, 'force-window-chain-'));
  const state = path.join(root, 'temp', 'state');
  const artifactDir = path.join(root, 'artifact');
  const target = path.join(artifactDir, 'result.txt');
  const launcher = path.join(state, 'win-launch-real.ps1');
  const pidFile = path.join(state, 'window-real.pid');
  const ready = path.join(state, 'ready');
  const resultFile = path.join(state, 'chain-result.json');
  const token = 'a'.repeat(36);
  fs.mkdirSync(state, {recursive: true});
  fs.mkdirSync(artifactDir, {recursive: true});
  fs.writeFileSync(path.join(state, '.orchestrator-enabled'), String(Date.now()), 'utf8');
  fs.writeFileSync(target, 'fixture', 'utf8');
  const env = {...baseEnv(root, state), EXPECTED_TOKEN: token};
  const launcherBody = [
    "$ErrorActionPreference = 'Stop'",
    `$PID | Set-Content -LiteralPath ${psq(pidFile)} -Encoding UTF8`,
    `while (-not (Test-Path -LiteralPath ${psq(ready)})) { Start-Sleep -Milliseconds 50 }`,
    "$env:ORCH_WINDOW = '1'",
    "$env:ORCH_WINDOW_TOKEN = $env:EXPECTED_TOKEN",
    `$assertOutput = (& ${psq(process.execPath)} ${psq(force)} '--assert' 'exec' 2>&1 | Out-String)`,
    '$assertCode = $LASTEXITCODE',
    `$verifyOutput = (& ${psq(process.execPath)} ${psq(force)} '--verify' ${psq(target)} 2>&1 | Out-String)`,
    '$verifyCode = $LASTEXITCODE',
    `@{assertCode=$assertCode; verifyCode=$verifyCode; assertOutput=$assertOutput; verifyOutput=$verifyOutput} | ConvertTo-Json -Compress | Set-Content -LiteralPath ${psq(resultFile)} -Encoding UTF8`,
    'exit 0',
  ].join('\r\n');
  fs.writeFileSync(launcher, '\uFEFF' + launcherBody + '\r\n', 'utf8');
  let child = null;
  try {
    child = spawn(ps7, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher], {cwd: root, env, windowsHide: true, stdio: 'ignore'});
    const pidReady = await waitUntil(() => {
      try { return Number(fs.readFileSync(pidFile, 'utf8').trim()) === child.pid; } catch { return false; }
    }, 30000, 100);
    assert.equal(pidReady, true, 'the real launcher must publish its pid');
    let identity = null;
    // Each predicate call is a blocking processSnapshot() (2-11 s), so the deadline must
    // cover several rounds rather than one.
    const identityReady = await waitUntil(() => {
      try {
        identity = launcherIdentity(child.pid, pidFile, processSnapshot());
        return Boolean(identity);
      } catch { return false; }
    }, 90000, 200);
    assert.equal(identityReady, true, 'the launcher must have an exact trusted identity before registration');
    writeJson(path.join(state, 'orchestrator-windows.json'), [{
      id: 'real-window',
      title: 'real-window',
      keys: ['dir:' + artifactDir],
      pidFile,
      pid: child.pid,
      identity,
      sanctionToken: token,
    }]);

    const outside = runForce(['--verify', target], env);
    assert.equal(outside.status, 2, outside.all);
    assert.match(outside.all, /INDETERMINATE/);
    const copied = runForce(['--assert', 'exec'], {...env, ORCH_WINDOW: '1', ORCH_WINDOW_TOKEN: token});
    assert.equal(copied.status, 1, copied.all);
    assert.match(copied.all, /REFUSED/);

    fs.writeFileSync(ready, 'go', 'utf8');
    let result = null;
    let readError = null;
    // The writer is PowerShell `Set-Content`: the file appears (empty) before its bytes land,
    // so wait for a parseable payload instead of merely an existing path.
    const completed = await waitUntil(() => {
      try {
        const text = fs.readFileSync(resultFile, 'utf8');
        if (!text.trim()) return false;
        result = JSON.parse(text);
        return true;
      } catch (error) {
        readError = error;
        return false;
      }
    }, 120000, 100);
    assert.equal(completed, true, 'the real launcher child must finish both in-window checks' + (readError ? `: ${readError.message}` : ''));
    assert.equal(result.assertCode, 0, JSON.stringify(result));
    assert.equal(result.verifyCode, 0, JSON.stringify(result));
    assert.match(result.assertOutput, /sanctioned orchestration window/i);
    assert.match(result.verifyOutput, /PASS/);
    assert.doesNotMatch(result.assertOutput + result.verifyOutput, new RegExp(token));
  } finally {
    killOwned(child);
    fs.rmSync(root, {recursive: true, force: true});
  }
});
