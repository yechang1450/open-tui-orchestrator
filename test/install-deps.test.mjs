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

test('--install-deps fails closed and cleanly when the npm toolchain is missing', () => {
  // 用 ORCH_NPM_BIN 指到一个不存在的 npm 来模拟缺工具链：这条路不会误伤 PATH——
  // 现代 Node 的 npm 直启（node_modules/npm/bin/npm-cli.js）在空 PATH 下也照样能装，
  // 所以「空 PATH」不再能代表「缺 npm」。断言不变：fail-closed、指名手工兜底、无栈帧、不假绿。
  const pkg = minimalPackage();
  try {
    const env = {...bareEnv(), ORCH_NPM_BIN: path.join(pkg, 'no-such-npm.cmd')};
    const r = spawnSync(process.execPath, [path.join(pkg, 'cli.mjs'), '--install-deps'], {cwd: family, env, encoding: 'utf8', windowsHide: true, timeout: 60000});
    const out = (r.stdout || '') + (r.stderr || '');
    assert.notEqual(r.status, 0, 'a missing toolchain must fail: ' + out);
    assert.match(out, /FATAL: dependency install failed/, out);
    assert.match(out, /npm ci --prefix/, 'the manual fallback command must be named: ' + out);
    assert.doesNotMatch(out, /^\s+at /m, 'no Node stack frames: ' + out);
    assert.doesNotMatch(out, /"ok":true/, 'a failure must never claim success: ' + out);
  } finally { fs.rmSync(pkg, {recursive: true, force: true}); }
});

test('--install-deps reports a successful install as installed (npm stub, success path)', () => {
  // 真机回归抓到的洞：装前算一次的 present 常量会把「刚装成功」误判成失败——成功路径必须有判据。
  // 用 PATH 前置的 npm 桩（只建出依赖目录、exit 0）离线确定性地走完成功路径。
  const pkg = minimalPackage();
  const stubDir = fs.mkdtempSync(path.join(family, 'install-deps-stub-'));
  try {
    const script = "const fs=require('fs'),p=require('path');const i=process.argv.indexOf('--prefix');const d=process.argv[i+1];"
      + "for(const n of ['@openai/codex-sdk','@lydell/node-pty']){const x=p.join(d,'node_modules',...n.split('/'));fs.mkdirSync(x,{recursive:true});fs.writeFileSync(p.join(x,'package.json'),JSON.stringify({name:n,version:'0.0.0'}));}";
    fs.writeFileSync(path.join(stubDir, 'npm.cmd'), `@echo off\r\n"${process.execPath}" -e "${script.replace(/"/g, '\\"')}" %*\r\n`);
    const env = {SystemRoot: process.env.SystemRoot, PATH: `${stubDir}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${path.join(process.env.SystemRoot || '', 'System32')}`, ORCH_MAINTENANCE_LOCK: path.join(family, 'no-lock.json'), ORCH_AGENT: 'codex'};
    const r = spawnSync(process.execPath, [path.join(pkg, 'cli.mjs'), '--install-deps'], {cwd: family, env, encoding: 'utf8', windowsHide: true, timeout: 60000});
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /"action":"installed"/, r.stdout);
    assert.ok(fs.existsSync(path.join(pkg, 'scripts', 'node_modules', '@openai', 'codex-sdk', 'package.json')), 'the success path must leave the shim in place');
  } finally {
    fs.rmSync(stubDir, {recursive: true, force: true});
    fs.rmSync(pkg, {recursive: true, force: true});
  }
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
