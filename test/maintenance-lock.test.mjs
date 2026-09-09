import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CODEX_CLI_SKIP} from './helpers/external.mjs';
import {
  MAINTENANCE_MESSAGE,
  DEFAULT_TTL_MINUTES,
  MAX_TTL_MINUTES,
  maintenanceLockPath,
  readMaintenanceLock,
  lockedForMaintenance,
  acquireMaintenanceLock,
  releaseMaintenanceLock,
} from '../scripts/core/maintenance-lock.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cliFile = path.join(root, 'scripts', 'maintenance-lock.mjs');
const preflightFile = path.join(root, 'scripts', 'open-tui-orchestrator-preflight.mjs');
const forceFile = path.join(root, 'scripts', 'open-tui-orchestrator-force.mjs');
const sdkFile = path.join(root, 'scripts', 'orchestrate-sdk.mjs');

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mlock-'));
  const env = { ORCH_MAINTENANCE_LOCK: path.join(dir, 'lock.json') };
  return { dir, env, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('maintenance lock acquire/read/release roundtrip', () => {
  const t = tempEnv();
  try {
    assert.equal(lockedForMaintenance(t.env), false);
    const data = acquireMaintenanceLock({ reason: '升级中', ttlMinutes: 30, env: t.env });
    assert.equal(data.reason, '升级中');
    assert.equal(data.expiresAt - data.startedAt, 30 * 60000);
    const st = readMaintenanceLock(t.env);
    assert.equal(st.locked, true);
    assert.equal(st.reason, '升级中');
    assert.equal(lockedForMaintenance(t.env), true);
    assert.equal(releaseMaintenanceLock(t.env), true);
    assert.equal(lockedForMaintenance(t.env), false);
  } finally { t.cleanup(); }
});

test('maintenance lock default TTL is 180min and capped at 24h', () => {
  const t = tempEnv();
  try {
    const d1 = acquireMaintenanceLock({ env: t.env });
    assert.equal(d1.expiresAt - d1.startedAt, DEFAULT_TTL_MINUTES * 60000);
    const d2 = acquireMaintenanceLock({ ttlMinutes: 999999, env: t.env });
    assert.equal(d2.expiresAt - d2.startedAt, MAX_TTL_MINUTES * 60000);
    const d3 = acquireMaintenanceLock({ ttlMinutes: Number('not-a-number'), env: t.env });
    assert.equal(d3.expiresAt - d3.startedAt, DEFAULT_TTL_MINUTES * 60000);
  } finally { t.cleanup(); }
});

test('expired lock is treated as unlocked and cleaned up (fail-open)', () => {
  const t = tempEnv();
  try {
    fs.mkdirSync(path.dirname(maintenanceLockPath(t.env)), { recursive: true });
    fs.writeFileSync(maintenanceLockPath(t.env), JSON.stringify({ version: 1, reason: 'stale', startedAt: 1000, expiresAt: 2000 }), 'utf8');
    const st = readMaintenanceLock(t.env, 5000);
    assert.equal(st.locked, false);
    assert.equal(st.expired, true);
    assert.equal(fs.existsSync(maintenanceLockPath(t.env)), false, 'expired lock file must be removed');
  } finally { t.cleanup(); }
});

test('corrupt or unreadable lock file is fail-open unlocked', () => {
  const t = tempEnv();
  try {
    fs.mkdirSync(path.dirname(maintenanceLockPath(t.env)), { recursive: true });
    fs.writeFileSync(maintenanceLockPath(t.env), '{not json', 'utf8');
    const st = readMaintenanceLock(t.env);
    assert.equal(st.locked, false);
    assert.equal(st.invalid, true);
    assert.equal(lockedForMaintenance(t.env), false);
    fs.writeFileSync(maintenanceLockPath(t.env), String.fromCharCode(0xFEFF) + JSON.stringify({ reason: 'bom', expiresAt: Date.now() + 60000 }), 'utf8');
    assert.equal(readMaintenanceLock(t.env).locked, true, 'BOM-prefixed JSON must still parse');
  } finally { t.cleanup(); }
});

test('lock without a valid expiresAt is corrupt and fails open', () => {
  const t = tempEnv();
  try {
    fs.mkdirSync(path.dirname(maintenanceLockPath(t.env)), { recursive: true });
    const file = maintenanceLockPath(t.env);
    fs.writeFileSync(file, JSON.stringify({ version: 1, reason: 'manual' }), 'utf8');
    const st = readMaintenanceLock(t.env, Date.now() + 365 * 24 * 3600 * 1000);
    assert.equal(st.locked, false);
    assert.equal(st.invalid, true);
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, JSON.stringify({ version: 1, reason: 'bad', expiresAt: 'never' }), 'utf8');
    const st2 = readMaintenanceLock(t.env);
    assert.equal(st2.locked, false);
    assert.equal(st2.invalid, true);
    assert.equal(fs.existsSync(file), false);
  } finally { t.cleanup(); }
});

test('maintenance-lock CLI lock/status/unlock', () => {
  const t = tempEnv();
  try {
    const env = { ...process.env, ...t.env };
    const lock = spawnSync(process.execPath, [cliFile, 'lock', '--reason', '维护', '--ttl-minutes', '5'], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(lock.status, 0, lock.stderr);
    assert.match(lock.stdout, new RegExp('LOCKED: ' + MAINTENANCE_MESSAGE));
    const status = spawnSync(process.execPath, [cliFile, 'status'], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /LOCKED/);
    assert.match(status.stdout, /维护/);
    const unlock = spawnSync(process.execPath, [cliFile, 'unlock'], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(unlock.status, 0, unlock.stderr);
    const status2 = spawnSync(process.execPath, [cliFile, 'status'], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.match(status2.stdout, /not locked/);
  } finally { t.cleanup(); }
});

test('locked preflight returns the maintenance one-liner and exits 0 for any kind', { skip: CODEX_CLI_SKIP }, () => {
  const t = tempEnv();
  const ws = fs.mkdtempSync(path.join(root, 'temp', 'mlock-preflight-'));
  try {
    acquireMaintenanceLock({ reason: 'test', env: t.env });
    const env = { ...process.env, ...t.env, ORCH_AGENT: 'codex' };
    const real = spawnSync(process.execPath, [preflightFile, 'build'], { cwd: ws, env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(real.status, 0, real.stderr);
    assert.match(real.stdout.trim(), new RegExp('^' + MAINTENANCE_MESSAGE + '$'));
    const bogus = spawnSync(process.execPath, [preflightFile, 'nonsense-kind'], { cwd: ws, env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(bogus.status, 0, bogus.stderr);
    assert.match(bogus.stdout.trim(), new RegExp('^' + MAINTENANCE_MESSAGE + '$'));
    releaseMaintenanceLock(t.env);
    const unlocked = spawnSync(process.execPath, [preflightFile, 'read'], { cwd: ws, env: { ...process.env, ORCH_MAINTENANCE_LOCK: t.env.ORCH_MAINTENANCE_LOCK, ORCH_AGENT: 'codex' }, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(unlocked.status, 0, unlocked.stderr);
    assert.match(unlocked.stdout, /ok: read-only kind/);
  } finally { t.cleanup(); fs.rmSync(ws, { recursive: true, force: true }); }
});

test('locked force --assert/--verify pass through with the one-liner; --status shows the lock', { skip: CODEX_CLI_SKIP }, () => {
  const t = tempEnv();
  const ws = fs.mkdtempSync(path.join(root, 'temp', 'mlock-force-'));
  try {
    acquireMaintenanceLock({ reason: 'test', env: t.env });
    const env = { ...process.env, ...t.env, ORCH_AGENT: 'codex' };
    const asserted = spawnSync(process.execPath, [forceFile, '--assert', 'exec'], { cwd: ws, env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(asserted.status, 0, asserted.stderr);
    assert.match(asserted.stdout.trim(), new RegExp('^' + MAINTENANCE_MESSAGE + '$'));
    const verified = spawnSync(process.execPath, [forceFile, '--verify', fileURLToPath(import.meta.url)], { cwd: ws, env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout.trim(), new RegExp('^' + MAINTENANCE_MESSAGE + '$'));
    const status = spawnSync(process.execPath, [forceFile, '--status'], { cwd: ws, env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /maintenance lock: LOCKED/);
    assert.match(status.stdout, /enforcement:/);
  } finally { t.cleanup(); fs.rmSync(ws, { recursive: true, force: true }); }
});

test('locked --run-windows/--spawn skip orchestration with the one-liner and create no launcher', { skip: CODEX_CLI_SKIP }, () => {
  const t = tempEnv();
  const ws = fs.mkdtempSync(path.join(root, 'temp', 'mlock-sdk-'));
  try {
    acquireMaintenanceLock({ reason: 'test', env: t.env });
    const env = { ...process.env, ...t.env, ORCH_AGENT: 'codex', WORKSPACE_DIR: ws, ORCH_STATE_DIR: path.join(ws, 'temp', 'orchestrator') };
    const run = spawnSync(process.execPath, [sdkFile, '--run-windows', '修复登录页'], { cwd: ws, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp('^' + MAINTENANCE_MESSAGE + '$', 'm'));
    const stateDir = path.join(ws, 'temp', 'orchestrator');
    const leftovers = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter((f) => /win-launch-|agent-win-/.test(f)) : [];
    assert.deepEqual(leftovers, [], 'locked run-windows must not create launcher artifacts');
    const spawned = spawnSync(process.execPath, [sdkFile, '--spawn', 't', '做点啥'], { cwd: ws, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(spawned.status, 0, spawned.stderr);
    assert.match(spawned.stdout, new RegExp('^' + MAINTENANCE_MESSAGE + '$', 'm'));
    const status = spawnSync(process.execPath, [sdkFile, '--status', '--readonly'], { cwd: ws, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /maintenance lock: LOCKED/);
    assert.match(status.stdout, /=== alive agent TUI windows ===/, 'read-only --status must bypass the lock');
    releaseMaintenanceLock(t.env);
    const plan = spawnSync(process.execPath, [sdkFile, '--plan', '只是分析一下'], { cwd: ws, env: { ...process.env, ORCH_MAINTENANCE_LOCK: t.env.ORCH_MAINTENANCE_LOCK, ORCH_AGENT: 'codex', WORKSPACE_DIR: ws, ORCH_STATE_DIR: path.join(ws, 'temp', 'orchestrator') }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(plan.status, 0, plan.stderr);
    assert.doesNotMatch(plan.stdout, new RegExp('^' + MAINTENANCE_MESSAGE + '$', 'm'), 'unlocked --plan must not be gated');
  } finally { t.cleanup(); fs.rmSync(ws, { recursive: true, force: true }); }
});
