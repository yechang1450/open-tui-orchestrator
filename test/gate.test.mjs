import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const family = path.join(root, 'temp');
const GATE_FILES = ['README.md', 'README-zh.md', 'package.json', 'release.json', 'cli.mjs', 'orch.mjs'];

// in-repo gate (scripts/gate.mjs) 是公开仓里的机判门禁：它自己是判据，判据本身必须能红。
// 两条用例：真仓上 --consistency 必须绿；口径被篡改的副本上必须红并指名是哪一处。
function gateCopy() {
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, 'gate-'));
  for (const rel of GATE_FILES) fs.copyFileSync(path.join(root, rel), path.join(dir, rel));
  fs.mkdirSync(path.join(dir, 'docs'), {recursive: true});
  fs.copyFileSync(path.join(root, 'docs', 'release-policy.md'), path.join(dir, 'docs', 'release-policy.md'));
  fs.cpSync(path.join(root, 'scripts'), path.join(dir, 'scripts'), {recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`)});
  return dir;
}
const runGate = (dir, flag) => spawnSync(process.execPath, [path.join(dir, 'scripts', 'gate.mjs'), flag], {cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 120000});
const scrub = (text) => text.replace(/[A-Za-z]:\\+Users\\+[^\\]+/g, '<user>');

test('gate: --consistency passes on the real repository', () => {
  const r = runGate(root, '--consistency');
  const out = scrub((r.stdout || '') + (r.stderr || ''));
  assert.equal(r.status, 0, out);
  assert.match(out, /L4 PASS/, out);
});

test('gate: --consistency goes red on a tampered copy and names the file', () => {
  const dir = gateCopy();
  try {
    const readme = path.join(dir, 'README.md');
    const before = fs.readFileSync(readme, 'utf8');
    const broken = before.replace(/(with )\d+(\/\d+ offline tests passing)/, '$1' + '1$2');
    assert.notEqual(broken, before, 'the fixture must actually change the count line');
    fs.writeFileSync(readme, broken);
    const r = runGate(dir, '--consistency');
    const out = scrub((r.stdout || '') + (r.stderr || ''));
    assert.equal(r.status, 1, 'a tampered count line must fail the gate: ' + out);
    assert.match(out, /README\.md: regression total is not all-green|README\.md.*⇒ FAIL/, out);
    assert.match(out, /ORCH_GATE: FAIL \(L4\)/, out);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
