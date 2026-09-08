import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyRelease} from '../scripts/release-integrity.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
const repair = path.join(source, 'repair.mjs');

test('repair validates and publishes a clean CLI package', () => {
  const family = path.join('D:\\temp', 'orchestrator');
  fs.mkdirSync(family, {recursive: true});
  const root = fs.mkdtempSync(path.join(family, 'publication-'));
  try {
    const check = spawnSync(process.execPath, [repair], {cwd: source, encoding: 'utf8', windowsHide: true, timeout: 30000});
    assert.equal(check.status, 0, check.stderr || check.stdout);

    const publish = spawnSync(process.execPath, [repair, '--target', root], {cwd: source, encoding: 'utf8', windowsHide: true, timeout: 30000});
    assert.equal(publish.status, 0, publish.stderr || publish.stdout);
    const published = path.join(root, 'open-tui-orchestrator');
    assert.deepEqual(verifyRelease(published), verifyRelease(source));
    for (const name of ['.git', 'node_modules', 'temp', 'coverage']) {
      assert.equal(fs.existsSync(path.join(published, name)), false, `published package contains ${name}`);
    }
    assert.equal(fs.existsSync(path.join(published, 'scripts', '.agent-cache.json')), false);

    const duplicate = spawnSync(process.execPath, [repair, '--target', root], {cwd: source, encoding: 'utf8', windowsHide: true, timeout: 30000});
    assert.equal(duplicate.status, 2, duplicate.stdout);
    assert.match(duplicate.stderr, /already exists/i);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
