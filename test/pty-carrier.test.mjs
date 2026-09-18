import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {normalizeUnitCarrier, effectiveUnitCarrier, ptyAvailability} from '../scripts/core/unit-carrier.mjs';
import {spawnHeadlessWithRetry} from '../scripts/core/orchestrate-sdk.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const family = path.join(root, 'temp');

test('carrier normalization: stdio default, registry pty, explicit env wins, unknown refused', () => {
  assert.equal(normalizeUnitCarrier(''), null);
  assert.equal(normalizeUnitCarrier(null), null);
  assert.equal(normalizeUnitCarrier('PTY'), 'pty');
  assert.equal(normalizeUnitCarrier(' stdio '), 'stdio');
  assert.throws(() => normalizeUnitCarrier('window'), /UNSUPPORTED_UNIT_CARRIER/);
  assert.equal(effectiveUnitCarrier({}, {}), 'stdio');
  assert.equal(effectiveUnitCarrier({}, {carrier: 'pty'}), 'pty');
  assert.equal(effectiveUnitCarrier({ORCH_UNIT_CARRIER: 'stdio'}, {carrier: 'pty'}), 'stdio');
  assert.equal(effectiveUnitCarrier({ORCH_UNIT_CARRIER: 'pty'}, {}), 'pty');
});

test('pty engine resolves from the tool install (scripts/node_modules)', {skip: !ptyAvailability().ok}, () => {
  const availability = ptyAvailability();
  assert.equal(availability.ok, true);
  assert.ok(fs.existsSync(availability.resolved), availability.resolved);
  assert.match(availability.resolved.replaceAll('\\', '/'), /scripts\/node_modules\/@lydell\/node-pty\//);
});

test('pty carrier gives the unit a real console while keeping pidf/identity contract', {skip: !ptyAvailability().ok}, async () => {
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, 'pty-probe-'));
  const lp = path.join(dir, 'win-launch-pty-probe.ps1');
  const pidf = path.join(dir, 'window-pty-probe.pid');
  const probe = path.join(dir, 'console-probe.txt');
  const lit = s => "'" + String(s).replaceAll("'", "''") + "'";
  fs.writeFileSync(lp, [
    '$PID | Set-Content -LiteralPath ' + lit(pidf) + ' -Encoding UTF8',
    'try { $w = [Console]::WindowWidth; "console=" + $w | Set-Content -LiteralPath ' + lit(probe) + ' -Encoding UTF8 } catch { "no-console: " + $_.Exception.Message | Set-Content -LiteralPath ' + lit(probe) + ' -Encoding UTF8 }',
    'Start-Sleep -Seconds 8',
  ].join("\n"));
  const prev = process.env.ORCH_UNIT_CARRIER;
  // 0.9.17：辅助窗内存准入参与直连 spawn ⇒ 钉住内存参数，避免本判据随机器剩余内存漂移。
  process.env.ORCH_UNIT_MEM_DEFAULT_MB = '1';
  process.env.ORCH_MIN_FREE_MEM_MB = '1';
  process.env.ORCH_UNIT_CARRIER = 'pty';
  try {
    const ok = await spawnHeadlessWithRetry(lp, 'probe', pidf, 1, 'tok-pty-probe', false);
    assert.equal(ok, true, 'pty-carried spawn must confirm via pidf + launcher identity');
    // 控制台探针：载体必须给启动器一个真实终端（无控制台的裸进程会抛 handle 无效）。
    let text = '';
    for (let i = 0; i < 80 && !text; i++) { try { text = fs.readFileSync(probe, 'utf8').trim(); } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.match(text, /^console=\d+$/, 'PTY carrier must provide a real console (probe said: ' + text + ')');
    let pid = 0;
    for (let i = 0; i < 50 && !pid; i++) { try { pid = Number(fs.readFileSync(pidf, 'utf8').replace(/^\uFEFF/, '').trim()); } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.ok(pid > 0, 'pidf must be readable');
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {windowsHide: true});
  } finally {
    if (prev === undefined) delete process.env.ORCH_UNIT_CARRIER; else process.env.ORCH_UNIT_CARRIER = prev;
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('unknown ORCH_UNIT_CARRIER fails closed before any spawn', async () => {
  const dir = fs.mkdtempSync(path.join(path.join(root, 'temp'), 'pty-probe-'));
  const lp = path.join(dir, 'win-launch-pty-probe-b.ps1');
  const pidf = path.join(dir, 'window-pty-probe-b.pid');
  fs.writeFileSync(lp, '# never runs\n');
  const prev = process.env.ORCH_UNIT_CARRIER;
  const prevMem = [process.env.ORCH_UNIT_MEM_DEFAULT_MB, process.env.ORCH_MIN_FREE_MEM_MB];
  process.env.ORCH_UNIT_CARRIER = 'window';
  // 0.9.17：辅助窗内存准入先于载体解析 ⇒ 先钉住内存参数，让载体错误如实浮出（本测点在载体守卫）。
  process.env.ORCH_UNIT_MEM_DEFAULT_MB = '1';
  process.env.ORCH_MIN_FREE_MEM_MB = '1';
  try {
    await assert.rejects(() => spawnHeadlessWithRetry(lp, 'probe', pidf, 1, 'tok', false), /UNSUPPORTED_UNIT_CARRIER/);
    assert.equal(fs.existsSync(pidf), false, 'fail-closed must not spawn anything');
  } finally {
    if (prev === undefined) delete process.env.ORCH_UNIT_CARRIER; else process.env.ORCH_UNIT_CARRIER = prev;
    if (prevMem[0] === undefined) delete process.env.ORCH_UNIT_MEM_DEFAULT_MB; else process.env.ORCH_UNIT_MEM_DEFAULT_MB = prevMem[0];
    if (prevMem[1] === undefined) delete process.env.ORCH_MIN_FREE_MEM_MB; else process.env.ORCH_MIN_FREE_MEM_MB = prevMem[1];
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
