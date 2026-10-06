// 身份卫生判据：tracked 代码/脚本不得泄漏机器用户名或家目录绝对路径。
//
// 为什么需要这条：身份清理发生过两次回潮。
//   2026-09-14 清 18 个 tracked 文件、77 处（归一到 <user>）；
//   2026-09-16 L10 巡逻/level-check 工具又混入机器用户名 6 处（被记作 regression）；
//   2026-09-28 再次修掉并补此判据。手工修 n 次都不算加固，能变红才算。
//
// 口径：只审代码/脚本（.mjs/.cjs/.js/.ts/.py/.ps1/.sh/.cmd）。
//   文档与验收记录（*.md / *.json）里的历史绝对路径属于叙述，不在本判据范围。
// 陷阱：公开句柄 yechang1450 含有用户名子串，匹配必须带后缀边界，否则误报。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const ME = String(os.userInfo().username || '').trim();
const CODE_RE = /\.(mjs|cjs|js|ts|py|ps1|sh|cmd)$/i;
const SKIP_RE = /^(scripts\/node_modules\/|\.git\/)/;

function trackedCodeFiles() {
  const r = spawnSync('git', ['ls-files'], {cwd: root, encoding: 'utf8', windowsHide: true});
  assert.equal(r.status, 0, 'git ls-files failed: ' + (r.stderr || ''));
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => CODE_RE.test(f) && !SKIP_RE.test(f));
}

// 用户名要带后缀边界（yechang1450 是公开句柄，不是泄漏）。
function userRe() {
  return new RegExp(ME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_-])', 'i');
}
// 家目录绝对路径：只认「本机真实用户名」那一段才算泄漏。
//   C:\Users\<who> 这类占位、或夹具里的单字母样例（C:\Users\u\...）都合法——
//   判据管的是"泄漏我这台机器的身份"，不是"禁止一切 Users 路径字面量"。
function homeRe() {
  if (!ME) return null;
  return new RegExp('[A-Za-z]:\\\\+Users\\\\+' + esc(ME) + '(?![A-Za-z0-9_-])', 'i');
}
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scan(dir) {
  const hits = [];
  const re = ME ? userRe() : null;
  const hre = homeRe();
  for (const rel of trackedCodeFiles()) {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) continue;
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      if (re && re.test(line)) hits.push(`${rel}:${i + 1}: machine user name`);
      if (hre && hre.test(line)) hits.push(`${rel}:${i + 1}: home-dir absolute path`);
    });
  }
  return hits;
}

test('identity hygiene: tracked code carries no machine user name or home-dir path', () => {
  const hits = scan(root);
  assert.deepEqual(hits, [], 'identity leak in tracked code:\n' + hits.join('\n'));
});

test('identity hygiene: the check goes red when a leak is injected', () => {
  assert.ok(ME, 'this judgment needs a resolvable machine user name');
  const files = trackedCodeFiles();
  assert.ok(files.length > 0, 'expected tracked code files');
  const rel = files[0];
  const family = path.join(root, 'temp');
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, 'ident-'));
  try {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, fs.readFileSync(path.join(root, rel), 'utf8')
      + `\n// injected leak: C:\\Users\\${ME}\n`, 'utf8');
    const hits = scan(dir);
    assert.ok(hits.length > 0, 'the injected leak must be caught');
    assert.ok(hits.some((h) => h.includes('machine user name')), 'must name the machine-user hit: ' + hits.join(','));
  } finally {
    // 每次运行都写入一份含机器用户名的副本：不清理就是判据自己禁止的残留（审计实测过 45 个）。
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
