import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {coreInventory, runtimeInventory, verifyRelease} from '../scripts/release-integrity.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));

// 最小发布树：封印校验所需的四件（core 两件 + cli.mjs + package.json + release.json 自封）。
function writeFixture(root) {
  fs.mkdirSync(path.join(root, 'scripts', 'core'), {recursive: true});
  fs.writeFileSync(path.join(root, 'scripts', 'core', 'contracts.mjs'), "export const CORE_VERSION='test';\n");
  fs.writeFileSync(path.join(root, 'scripts', 'core', 'orchestrate-sdk.mjs'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'cli.mjs'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({
    schema: 2,
    coreVersion: 'test',
    files: coreInventory(root),
    runtimeFiles: runtimeInventory(root),
  }));
}

test('generic release seal covers the current core and runtime entrypoints', () => {
  const result = verifyRelease(source);
  assert.equal(result.schema, 2);
  assert.equal(result.coreVersion, '1.14.8');
  assert.ok(result.files >= 20, `expected a sealed execution core, got ${result.files}`);
  assert.ok(result.runtimeFiles >= 10, `expected sealed runtime entrypoints, got ${result.runtimeFiles}`);
});

test('generic release verification rejects changed and injected files', () => {
  const family = path.join(source, 'temp');
  fs.mkdirSync(family, {recursive: true});
  const root = fs.mkdtempSync(path.join(family, 'release-integrity-'));
  try {
    writeFixture(root);
    assert.equal(verifyRelease(root).files, 2);

    fs.appendFileSync(path.join(root, 'cli.mjs'), '\n// changed\n');
    assert.throws(() => verifyRelease(root), /RELEASE_INTEGRITY_FAILED/);

    fs.writeFileSync(path.join(root, 'cli.mjs'), '#!/usr/bin/env node\n');
    fs.writeFileSync(path.join(root, 'scripts', 'core', 'injected.mjs'), 'export {};\n');
    assert.throws(() => verifyRelease(root), /RELEASE_INTEGRITY_FAILED/);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

// 防绕过：封印树里出现链接（junction/符号链接）必须被拒，而不是顺着链接去哈希别人的文件。
// 红例方向：把 release-integrity.mjs 里的 isSymbolicLink 检查去掉，本判据必须红（校验会绿着通过）。
test('generic release verification refuses a linked entry inside the sealed tree', () => {
  const family = path.join(source, 'temp');
  fs.mkdirSync(family, {recursive: true});
  const root = fs.mkdtempSync(path.join(family, 'release-integrity-link-'));
  const outside = fs.mkdtempSync(path.join(family, 'release-outside-'));
  try {
    writeFixture(root);
    fs.writeFileSync(path.join(outside, 'orchestrate-sdk.mjs'), 'export {};\n');
    // junction 在 Windows 上无需提权，Node 的 lstat 把它报成 symbolic link——正是要拦的形态。
    fs.symlinkSync(outside, path.join(root, 'scripts', 'core', 'linked'), 'junction');
    assert.throws(() => verifyRelease(root), /RELEASE_LINK_FORBIDDEN/);
  } finally {
    fs.rmSync(outside, {recursive: true, force: true});
    fs.rmSync(root, {recursive: true, force: true});
  }
});
