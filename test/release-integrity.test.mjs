import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {coreInventory, runtimeInventory, verifyRelease} from '../scripts/release-integrity.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));

test('generic release seal covers the current core and runtime entrypoints', () => {
  const result = verifyRelease(source);
  assert.equal(result.schema, 2);
  assert.equal(result.coreVersion, '1.12.0');
  assert.ok(result.files >= 20, `expected a sealed execution core, got ${result.files}`);
  assert.ok(result.runtimeFiles >= 10, `expected sealed runtime entrypoints, got ${result.runtimeFiles}`);
});

test('generic release verification rejects changed and injected files', () => {
  const family = path.join(source, 'temp');
  fs.mkdirSync(family, {recursive: true});
  const root = fs.mkdtempSync(path.join(family, 'release-integrity-'));
  try {
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
