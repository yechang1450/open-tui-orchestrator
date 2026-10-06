import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('poll entry keeps release failures on the machine-readable fatal path', () => {
  const source = fs.readFileSync(path.join(repo, 'scripts', 'poll-windows.mjs'), 'utf8');
  assert.match(source, /formatFailureLines/);
  assert.match(source, /releaseError/);
  assert.match(source, /if \(!releaseError && IS_MAIN\)/);
  assert.doesNotMatch(source, /console\.error\(e\.stack\|\|e\.message\)/);
});
