import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

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

// 判据不得随壳变色（2026-09-16 裁定）：gate 必须报告本壳 ORCH_SPAWN_MODE，且它自己的子进程一律钉
// headless（用户级 ORCH_SPAWN_MODE 保留给手动跑，不得让判据或弹窗行为变色）。红例：改动前没有这条
// 报告行 ⇒ 本用例必红；且本壳设 window 时旧版四条默认断言实测真红（套件日志在案）。
test('gate: reports the shell spawn mode and pins its children to headless', () => {
  const run = (env) => spawnSync(process.execPath, [path.join(root, 'scripts', 'gate.mjs'), '--consistency'], {cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 120000});
  const withWindow = run({...process.env, ORCH_SPAWN_MODE: 'window'});
  const out1 = (withWindow.stdout || '') + (withWindow.stderr || '');
  assert.equal(withWindow.status, 0, out1);
  assert.match(out1, /\[gate\] shell ORCH_SPAWN_MODE=window; children pinned to headless/, out1);
  const bare = {...process.env};
  delete bare.ORCH_SPAWN_MODE;
  const unset = run(bare);
  const out2 = (unset.stdout || '') + (unset.stderr || '');
  assert.equal(unset.status, 0, out2);
  assert.match(out2, /\[gate\] shell ORCH_SPAWN_MODE=\(unset\); children pinned to headless/, out2);
});

// 门禁 L1 红必须点名（2026-09-17）：此前失败只留计数，名单不可恢复（一笔首判红至今无从指名——
// 门禁只打计数、同 HEAD 重判又把日志与判卷记录覆盖）。红例：解析器退化回空即红；对无标记文本
// 编造名字、或绿文本里凭空产生红名，都必红。
test('gate: the L1 red list is named from the suite reporter output', async () => {
  const {suiteReds} = await import(pathToFileURL(path.join(root, 'scripts', 'gate.mjs')).href);
  const redFixture = [
    '✖ sample red one (0.9611ms)',
    '✔ green neighbor (0.1134ms)',
    'ℹ tests 2',
    'ℹ pass 1',
    'ℹ fail 1',
    '',
    '✖ failing tests:',
    '',
    'test at test/sample.test.mjs:3:1',
    '✖ sample red one (0.9611ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  ].join('\n');
  const reds = suiteReds(redFixture);
  assert.equal(reds.length, 1, JSON.stringify(reds));
  assert.equal(reds[0].name, 'sample red one');
  assert.equal(reds[0].at, 'test/sample.test.mjs:3:1');
  // 无 `✖ failing tests:` 区（被中断的运行）时退回内联标记；空名/无红一律不得编造。
  assert.deepEqual(suiteReds('✖ a.test.mjs (12ms)\n✖ b.test.mjs (7ms)\n').map((r) => r.name), ['a.test.mjs', 'b.test.mjs']);
  assert.deepEqual(suiteReds('ℹ tests 2\nℹ pass 2\nℹ fail 0\n'), []);
});
