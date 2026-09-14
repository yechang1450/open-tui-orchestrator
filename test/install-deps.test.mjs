import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const family = path.join(root, 'temp');
const cliEntry = path.join(root, 'cli.mjs');
const PKG_FILES = ['cli.mjs', 'orch.mjs', 'repair.mjs', 'package.json', 'release.json', 'README.md', 'LICENSE'];

// 公开安装路径：npm 发行包里不带锁定的 SDK 依赖（node-pty + codex-sdk），用户装完包必须能用
// 一条命令补上，不需要自己拼路径。三条判据都可红：幂等路径若改成每次都联网跑 npm ci 会失败；
// 缺工具链时若吐栈帧、假绿、或不再指名手工兜底命令，同样失败。
function minimalPackage() {
  const pkg = fs.mkdtempSync(path.join(family, 'install-deps-'));
  for (const rel of PKG_FILES) fs.copyFileSync(path.join(root, rel), path.join(pkg, rel));
  fs.cpSync(path.join(root, 'scripts'), path.join(pkg, 'scripts'), {recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`)});
  return pkg;
}
const bareEnv = () => ({SystemRoot: process.env.SystemRoot, PATH: '', ORCH_MAINTENANCE_LOCK: path.join(family, 'no-lock.json')});

test('--install-deps reports already-present without touching the network', () => {
  fs.mkdirSync(family, {recursive: true});
  const r = spawnSync(process.execPath, [cliEntry, '--install-deps'], {cwd: family, env: {...process.env, ORCH_MAINTENANCE_LOCK: path.join(family, 'no-lock.json')}, encoding: 'utf8', windowsHide: true, timeout: 60000});
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const line = r.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  const parsed = JSON.parse(line);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, 'already-present');
  assert.ok(parsed.scriptsDir.endsWith('scripts'), parsed.scriptsDir);
  assert.ok(fs.existsSync(path.join(parsed.scriptsDir, 'node_modules', '@openai', 'codex-sdk', 'package.json')), 'the reported directory must actually carry the shim');
  assert.doesNotMatch(r.stdout, /added \d+ packages/, 'the idempotent path must not run npm');
});

test('--install-deps fails closed and cleanly when npm is unavailable', () => {
  const pkg = minimalPackage();
  try {
    const r = spawnSync(process.execPath, [path.join(pkg, 'cli.mjs'), '--install-deps'], {cwd: family, env: bareEnv(), encoding: 'utf8', windowsHide: true, timeout: 60000});
    const out = (r.stdout || '') + (r.stderr || '');
    assert.notEqual(r.status, 0, 'a missing toolchain must fail: ' + out);
    assert.match(out, /FATAL: dependency install failed/, out);
    assert.match(out, /npm ci --prefix/, 'the manual fallback command must be named: ' + out);
    assert.doesNotMatch(out, /^\s+at /m, 'no Node stack frames: ' + out);
    assert.doesNotMatch(out, /"ok":true/, 'a failure must never claim success: ' + out);
  } finally { fs.rmSync(pkg, {recursive: true, force: true}); }
});

test('--install-deps stays a no-op on a copy whose shim is already present', () => {
  const pkg = minimalPackage();
  try {
    for (const name of ['@openai/codex-sdk', '@lydell/node-pty']) {
      const dir = path.join(pkg, 'scripts', 'node_modules', ...name.split('/'));
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '0.0.0'}));
    }
    const r = spawnSync(process.execPath, [path.join(pkg, 'cli.mjs'), '--install-deps'], {cwd: family, env: bareEnv(), encoding: 'utf8', windowsHide: true, timeout: 60000});
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /"action":"already-present"/, r.stdout);
  } finally { fs.rmSync(pkg, {recursive: true, force: true}); }
});
