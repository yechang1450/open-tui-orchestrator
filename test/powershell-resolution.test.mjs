import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {powershellExe} from '../scripts/core/contracts.mjs';

const evidenceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'workspace', 'temp', 'otui-review-acceptance-20261004');
fs.mkdirSync(evidenceRoot, {recursive: true});
const fixture = prefix => {
  const dir = fs.mkdtempSync(path.join(evidenceRoot, prefix));
  return {dir, env: {
    SystemRoot: path.join(dir, 'system-root'),
    ProgramW6432: path.join(dir, 'program-files'),
    ProgramFiles: path.join(dir, 'program-files'),
    LOCALAPPDATA: path.join(dir, 'local-appdata'),
  }};
};
const cleanup = dir => fs.rmSync(dir, {recursive: true, force: true});

test('PowerShell resolver returns an existing trusted PowerShell 7 executable', {skip: process.platform !== 'win32'}, () => {
  const {dir, env} = fixture('powershell-existing-');
  const expected = path.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  fs.mkdirSync(path.dirname(expected), {recursive: true});
  fs.writeFileSync(expected, 'fixture', 'utf8');
  try {
    assert.equal(path.normalize(powershellExe(env)), path.normalize(expected));
  } finally {
    cleanup(dir);
  }
});

test('PowerShell resolver accepts a trusted Windows App Execution Alias after an absolute executable probe', {skip: process.platform !== 'win32'}, () => {
  const {dir, env} = fixture('powershell-alias-');
  const localAlias = path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe');
  const calls = [];
  const fakeSpawnSync = (file, args) => {
    calls.push({file, args});
    if (args.length === 1 && args[0] === 'pwsh.exe') return {status: 0, stdout: localAlias + '\\r\\n'};
    if (path.normalize(file).toLowerCase() === path.normalize(localAlias).toLowerCase()) {
      return {status: 0, stdout: 'C:\\\\Program Files\\\\WindowsApps\\\\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\\\\pwsh.exe\\r\\n'};
    }
    return {status: 1, stdout: '', stderr: 'missing fixture'};
  };
  try {
    const resolved = powershellExe(env, {spawnSync: fakeSpawnSync});
    assert.equal(path.normalize(resolved).toLowerCase(), path.normalize(localAlias).toLowerCase());
    assert.ok(calls.some(call => path.normalize(call.file).toLowerCase() === path.normalize(localAlias).toLowerCase() && call.args.includes('-NoProfile')));
  } finally {
    cleanup(dir);
  }
});
test('PowerShell resolver fails closed when no trusted PowerShell 7 executable exists', {skip: process.platform !== 'win32'}, () => {
  const {dir, env} = fixture('powershell-missing-');
  const legacyPs5 = path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  fs.mkdirSync(path.dirname(legacyPs5), {recursive: true});
  fs.writeFileSync(legacyPs5, 'legacy fixture', 'utf8');
  try {
    assert.throws(() => powershellExe(env), /PowerShell 7|trusted.*executable|not found/i);
  } finally {
    cleanup(dir);
  }
});

// 回归钉住真实故障：探测预算原本硬编码 5s，本机负载高峰时 WindowsApps 应用执行别名冷启动
// 实测 5s 预算 ETIMEDOUT@5086ms、13.8s 才成功，于是把可用的 pwsh 误报成「不存在」。
// 正向：预算来自 ORCH_PS_PROBE_TIMEOUT_MS / deps.probeTimeoutMs。
test('PowerShell resolver gives discovery probes a configurable budget instead of a hardcoded 5s', {skip: process.platform !== 'win32'}, () => {
  const {dir, env} = fixture('powershell-budget-');
  const calls = [];
  // deps.probeTimeoutMs 必须压过 env（原 5s 硬编码路径会让本用例红：探针只给 5000ms）。
  const fakeSpawnSync = (file, args, opts) => {
    calls.push(opts?.timeout);
    if (args.length === 1 && args[0] === 'pwsh.exe') return {status: 0, stdout: ''};
    return {status: 0, stdout: 'C:\\\\Program Files\\\\WindowsApps\\\\pwsh\\\\'};
  };
  try {
    const resolved = powershellExe({...env, ORCH_PS_PROBE_TIMEOUT_MS: '45000'}, {
      spawnSync: fakeSpawnSync, existsSync: () => false, probeTimeoutMs: 30000,
    });
    assert.ok(resolved, 'resolver must return a trusted candidate');
    assert.ok(calls.length > 0, 'resolver must probe at least one candidate');
    assert.ok(calls.every(value => value === 30000),
      'every discovery probe must honour the explicit budget, got ' + JSON.stringify(calls));
    assert.ok(!calls.includes(5000), 'no probe may fall back to the old hardcoded 5s budget');
  } finally {
    cleanup(dir);
  }
});

// 注入（红能力）：预算不得由生产代码硬编码回 5s，否则上面的正向用例会失去意义。
test('PowerShell resolver budget defaults to 30s and never silently falls back to 5s', {skip: process.platform !== 'win32'}, () => {
  const {dir, env} = fixture('powershell-budget-default-');
  const calls = [];
  const fakeSpawnSync = (file, args, opts) => {
    calls.push(opts?.timeout);
    return {status: 1, stdout: '', stderr: 'nope'};
  };
  try {
    assert.throws(() => powershellExe(env, {spawnSync: fakeSpawnSync, existsSync: () => false}));
    assert.ok(calls.length > 0 && calls.every(value => value === 30000),
      'default discovery budget must be 30000ms, got ' + JSON.stringify(calls));
    // 显式 env 覆盖
    calls.length = 0;
    assert.throws(() => powershellExe({...env, ORCH_PS_PROBE_TIMEOUT_MS: '45000'}, {spawnSync: fakeSpawnSync, existsSync: () => false}));
    assert.ok(calls.every(value => value === 45000), 'env override must win, got ' + JSON.stringify(calls));
  } finally {
    cleanup(dir);
  }
});
