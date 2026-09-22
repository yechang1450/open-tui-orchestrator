import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {verifyRelease} from '../scripts/release-integrity.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
const repair = path.join(source, 'repair.mjs');

test('repair validates and publishes a clean CLI package', () => {
  // 临时产物落在系统临时目录：写死 `D:\temp` 只是作者机器的习惯，没有 D: 盘的机器第一步就 ENOENT
  //（2026-09-22 本机实测：ENOENT mkdir 'D:\temp\orchestrator'）；也不能落在本仓 temp/ 下——
  // repair 明确拒绝"发布到源码树内部"（Publish target must be outside the source tree）。
  const family = path.join(os.tmpdir(), 'orchestrator');
  fs.mkdirSync(family, {recursive: true});
  const root = fs.mkdtempSync(path.join(family, 'publication-'));
  // publish 期间 repair.mjs 会礼貌性上锁（礼让并发引擎）；锁路径必须是本用例私有的，
  // 否则并行跑的动作类用例会撞见这把锁而误吃维护话术（曾致 status/force 用例偶发红）。
  const repairEnv = { ...process.env, ORCH_MAINTENANCE_LOCK: path.join(root, 'publish-lock.json') };
  try {
    const check = spawnSync(process.execPath, [repair], {cwd: source, env: repairEnv, encoding: 'utf8', windowsHide: true, timeout: 30000});
    assert.equal(check.status, 0, check.stderr || check.stdout);

    const publish = spawnSync(process.execPath, [repair, '--target', root], {cwd: source, env: repairEnv, encoding: 'utf8', windowsHide: true, timeout: 30000});
    assert.equal(publish.status, 0, publish.stderr || publish.stdout);
    const published = path.join(root, 'open-tui-orchestrator');
    assert.deepEqual(verifyRelease(published), verifyRelease(source));
    for (const name of ['.git', 'node_modules', 'temp', 'coverage']) {
      assert.equal(fs.existsSync(path.join(published, name)), false, `published package contains ${name}`);
    }
    assert.equal(fs.existsSync(path.join(published, 'scripts', '.agent-cache.json')), false);

    const duplicate = spawnSync(process.execPath, [repair, '--target', root], {cwd: source, env: repairEnv, encoding: 'utf8', windowsHide: true, timeout: 30000});
    assert.equal(duplicate.status, 2, duplicate.stdout);
    assert.match(duplicate.stderr, /already exists/i);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
