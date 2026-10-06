import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {powershellExe} from '../scripts/core/contracts.mjs';

// 2026-09-22（第 3 轮，L1 假红根因）：内存采样器是账外产物（fail-open 的学习样本），
// 它的寿命**不得**绑住引擎进程。两条判据，各自可红：
//  ① 引擎启动采样器后必须能立刻退出（旧的 `stdio:['ignore','ignore','pipe']` 会拖住父进程——
//     Node 的 `child.unref()` 只解绑子进程句柄、不解绑管道；实测子进程活 20s 父进程陪满 20.17s）；
//  ② 裸 pid 不是身份：Windows 复用 pid 后，采样器必须认出新槽位的主人不是本单位而立刻收尾
//     （旧实现会对着陌生人轮询满 -MaxMs，实测把一次 spawnSync 240s 预算全耗光 → 假红）。

const root = fileURLToPath(new URL('..', import.meta.url));
const family = path.join(root, 'temp');
const samplerScript = path.join(root, 'scripts', 'core', 'unit-memory-sampler.ps1');

function workDir(tag) {
  fs.mkdirSync(family, {recursive: true});
  return fs.mkdtempSync(path.join(family, tag + '-'));
}

// 一个「活着但什么都不做」的单元根进程（采样器的采样对象）。
function liveRoot(ms = 30000) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},' + ms + ')'], {windowsHide: true, stdio: 'ignore'});
  return child;
}

function killQuietly(pid) {
  try { process.kill(Number(pid)); } catch { /* already gone */ }
}

test('the memory sampler can never hold the engine process open', () => {
  const dir = workDir('sampler-detach');
  const unit = liveRoot(60000);
  const helper = path.join(dir, 'helper.mjs');
  fs.writeFileSync(helper, [
    'import fs from "node:fs";',
    'import {startUnitSampler} from ' + JSON.stringify(pathToFileURL(path.join(root, 'scripts', 'core', 'runner.mjs')).href) + ';',
    'const [outDir, rootPid] = process.argv.slice(2);',
    'const pid = startUnitSampler({pidf: outDir + "/window-x.pid"}, "B1", "tok12345678", Number(rootPid));',
    'console.log("SAMPLER=" + pid);',
    // 让采样器先真正做起来（PowerShell 冷启动），再各自收尾：这样「采样器在跑」与「引擎已能退出」
    // 两件事同时可证，而不是靠时序猜。
    'await new Promise((r) => setTimeout(r, 2500));',
    'console.log("START_MARKER=" + fs.existsSync(outDir + "/unit-peak-B1-12345678.json.start"));',
    'let alive = true; try { process.kill(Number(pid), 0); } catch { alive = false; }',
    'console.log("SAMPLER_ALIVE=" + alive);',
  ].join('\n'));
  try {
    // 预算 30s：旧的管道实现会一直等到采样器自己结束（根进程活着 60s ⇒ 远超预算），于是这里读成超时（status=null）。
    const r = spawnSync(process.execPath, [helper, dir, String(unit.pid)], {encoding: 'utf8', windowsHide: true, timeout: 30000});
    const out = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, 'the engine-side helper must exit on its own: ' + out);
    assert.match(out, /\[mem\] sampler started pid=\d+/, 'the sampler must actually be spawned: ' + out);
    assert.match(out, /START_MARKER=true/, 'the sampler must have really started (its marker file exists): ' + out);
    assert.match(out, /SAMPLER_ALIVE=true/, 'the sampler must still be running when the engine-side helper returns: ' + out);
  } finally {
    killQuietly(unit.pid);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

function runSampler(dir, args, timeout) {
  const out = path.join(dir, 'peak-' + Math.random().toString(36).slice(2, 8) + '.json');
  const r = spawnSync(powershellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', samplerScript, '-OutFile', out, ...args],
    {encoding: 'utf8', windowsHide: true, timeout});
  return {r, out};
}

function readSample(out) {
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

// 引擎给的启动时刻（与 leases.processSnapshot 同源、同格式），用来验证「身份正确 ⇒ 照常采样」。
function startedViaCim(pid) {
  const r = spawnSync(powershellExe(), ['-NoProfile', '-Command',
    '$ErrorActionPreference="Stop"; (Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '").CreationDate.ToUniversalTime().ToString("o")'],
    {encoding: 'utf8', windowsHide: true, timeout: 30000});
  return String(r.stdout || '').trim();
}

test('a recycled pid can never keep the sampler polling (identity, not a bare pid)', () => {
  const dir = workDir('sampler-recycled');
  const unit = liveRoot(120000);
  try {
    // 根 pid 活着，但启动时刻属于**另一个**进程实例 —— 旧槽位被复用的等价情形。
    const {r, out} = runSampler(dir, ['-RootPid', String(unit.pid), '-RootStarted', '2001-01-01T00:00:00.0000000Z', '-IntervalMs', '500', '-MaxMs', '120000'], 40000);
    assert.equal(r.status, 0, 'the sampler must exit instead of polling a foreign process: ' + (r.stderr || ''));
    const sample = readSample(out);
    assert.equal(sample.stopped, 'root-gone', JSON.stringify(sample));
    assert.equal(sample.peakMB, 0, JSON.stringify(sample));
    assert.ok(fs.existsSync(out + '.start'), 'the start marker stays for post-mortem diagnosis');
  } finally {
    killQuietly(unit.pid);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a verified root start time still samples normally, and a dead root stops at once', () => {
  const dir = workDir('sampler-identity');
  const unit = liveRoot(60000);
  try {
    const started = startedViaCim(unit.pid);
    assert.match(started, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?$/, 'CIM start time: ' + started);
    // 身份正确 ⇒ 采样照常（不许把自家单位误判成陌生人）
    const good = runSampler(dir, ['-RootPid', String(unit.pid), '-RootStarted', started, '-IntervalMs', '500', '-MaxMs', '6000'], 40000);
    assert.equal(good.r.status, 0, good.r.stderr || '');
    const sampled = readSample(good.out);
    assert.ok(sampled.peakMB > 0, 'a verified root must still be sampled: ' + JSON.stringify(sampled));
    assert.equal(sampled.stopped, 'max-ms', JSON.stringify(sampled));
    // 根进程消失 ⇒ 立刻收尾（不等到 -MaxMs）
    const t0 = Date.now();
    const deadRoot = spawnSync(process.execPath, ['-e', ''], {windowsHide: true});
    const gone = runSampler(dir, ['-RootPid', String(deadRoot.pid), '-IntervalMs', '500', '-MaxMs', '120000'], 40000);
    assert.equal(gone.r.status, 0, gone.r.stderr || '');
    assert.equal(readSample(gone.out).stopped, 'root-gone');
    assert.ok(Date.now() - t0 < 40000, 'a dead root must not be polled until the ceiling');
  } finally {
    killQuietly(unit.pid);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('the rescan never re-adopts the root slot after the original root was evicted', () => {
  const src = fs.readFileSync(samplerScript, 'utf8');
  assert.match(src, /if\s*\(\s*\$key\s*-eq\s*\$RootPid\s*\)\s*\{\s*continue\s*\}/, 'the rescan must skip the root slot (root identity comes only from -RootStarted / the first pin)');
});
