import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {coreInventory, runtimeInventory, verifyRelease} from '../scripts/release-integrity.mjs';
import {CORE_VERSION} from '../scripts/core/contracts.mjs';   // 版本判据与仓库核心同源：进位不再需要手改本文件

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
  assert.equal(result.coreVersion, CORE_VERSION);
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

// npm 包只装「跑起来用得上的」：仓库侧的开发件不得进入封印面（=不得进 npm 包），随包入口必须在。
// 红例方向：把任一 dev 件从 DEV_ONLY_FILES 移回（或把 files 白名单还原），本判据必红。
test('the sealed runtime surface excludes repository-only development files', () => {
  const inv = runtimeInventory(source);
  for (const rel of [
    'scripts/gate.mjs', 'scripts/host-cli.mjs', 'scripts/network-policy.mjs', 'scripts/agent.mjs',
    'scripts/agent-auth-prompt.txt', 'scripts/test-platform-guard.mjs',
    'scripts/open-tui-orchestrator-force.mjs', 'scripts/open-tui-orchestrator-preflight.mjs',
    'scripts/todo-list.mjs', 'repair.mjs',
  ]) assert.equal(rel in inv, false, `${rel} must not be sealed (dev-only, not shipped)`);
  for (const rel of [
    'cli.mjs', 'orch.mjs', 'package.json',
    'scripts/adapt.mjs', 'scripts/install-deps.mjs', 'scripts/maintenance-lock.mjs',
    'scripts/orchestrate-sdk.mjs', 'scripts/poll-windows.mjs', 'scripts/release-integrity.mjs',
    'scripts/sdk-dependency-check.mjs', 'scripts/recover-stale.mjs', 'scripts/runtime-context.mjs',
    'scripts/package.json', 'scripts/package-lock.json', 'scripts/core/orchestrate-sdk.mjs',
    'scripts/core/agent-auth-prompt.txt',
  ]) assert.equal(rel in inv, true, `${rel} must stay sealed (shipped runtime)`);
});
