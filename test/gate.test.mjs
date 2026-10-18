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

test('gate: an unknown flag cannot produce PASS with zero criteria', () => {
  for (const args of [['--suites'], ['unexpected-positional-argument'], ['-x'], ['--consistency', 'unexpected-positional-argument']]) {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'gate.mjs'), ...args], {cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000});
    const out = scrub((r.stdout || '') + (r.stderr || ''));
    assert.equal(r.status, 1, out);
    assert.match(out, /unknown gate flag|unrecognized gate flag/i, out);
    assert.doesNotMatch(out, /ORCH_GATE: PASS/, out);
  }
});

test('gate: un-attributed red tests cannot be auto-passed as environment flakes', async () => {
  const {canAutoPassEnvironmentFlake} = await import(pathToFileURL(path.join(root, 'scripts', 'gate.mjs')).href);
  assert.equal(canAutoPassEnvironmentFlake([{name: 'dynamic red'}], new Set(), []), false);
  assert.equal(canAutoPassEnvironmentFlake([{name: 'known red'}], new Set(['other red']), []), false);
  assert.equal(canAutoPassEnvironmentFlake([{name: 'known red'}], new Set(['known red']), ['test/known.test.mjs']), false);
  assert.equal(canAutoPassEnvironmentFlake([{name: 'known red'}], new Set(['known red']), []), true);
});

// L1 预算（2026-10-06）：本机满载时 91 个测试文件跑不完默认的 900s，被 spawnSync 砍断后没有
// `ℹ tests` 汇总，于是 L4 报 `measured suite undefined`——派生红而非套件红。套件预算走 suite()
// 的 ORCH_GATE_SUITE_TIMEOUT_MS（本就在），本用例钉住它别被退回硬编码。
test('gate: the L1 suite budget stays tunable instead of hardcoded to 900s', async () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'gate.mjs'), 'utf8');
  assert.match(source, /ORCH_GATE_SUITE_TIMEOUT_MS/, 'gate must expose a tunable suite budget');
  assert.match(source, /Math\.max\(60000,/, 'the suite budget keeps its 60s floor');
});

// 跳过项必须具名且正当（2026-10-06 用户拍板方案 A）：宿主 CLI 未安装的 skip 放行，
// 其它任何理由的 skip 一律判红。红例：把理由放宽成「任何 skip 都行」时，本用例必红。
test('gate: only named host-absence skips are accepted, every other skip fails L1', async () => {
  const {suiteSkips, SKIP_REASON_ALLOWED} = await import(pathToFileURL(path.join(root, 'scripts', 'gate.mjs')).href);
  const hostAbsent = '\uFE63 installed kimi resolves its own CLI (0.58ms) # kimi CLI is not installed';
  const otherReason = '\uFE63 some flaky case (1.20ms) # waiting on an upstream fix';
  const parsed = suiteSkips([hostAbsent, otherReason, '\u2714 a passing case (2.00ms)', '\u2139 skipped 2'].join('\n'));
  assert.equal(parsed.length, 2, 'both skip lines must be parsed: ' + JSON.stringify(parsed));
  assert.equal(parsed[0].name, 'installed kimi resolves its own CLI');
  assert.equal(parsed[0].reason, 'kimi CLI is not installed');
  assert.ok(SKIP_REASON_ALLOWED.test(parsed[0].reason), 'host-absence reason is allowed');
  assert.ok(!SKIP_REASON_ALLOWED.test(parsed[1].reason), 'any other reason must be rejected');
  // 解析数必须与 reporter 报的 skipped 一致，否则 L1 判红（漏解析不许蒙混）。
  assert.equal(suiteSkips('\u2714 only a pass (1ms)').length, 0);
});

// 实测套件规模把具名合法 skip 计入（2026-10-15 修）：宿主未装的机器上，套件实测 536 pass + 3 skip
// 与文档声明的 539 曾永远对不上（L4 假红），并逼出「为无关用例装 CLI 或改文档数字」两种坏选择。
// 红例：退回「只数 pass」的旧口径时本用例必红。
test('gate: the measured suite total counts named host-absence skips', async () => {
  const {measuredSuiteTotal} = await import(pathToFileURL(path.join(root, 'scripts', 'gate.mjs')).href);
  assert.equal(measuredSuiteTotal(536, 0, 3), 539, 'host-absence skips are suite members');
  assert.equal(measuredSuiteTotal(539, 0, 0), 539, 'no skips: unchanged');
  assert.equal(measuredSuiteTotal(537, 2, 0), 539, 'an environment-flake pass keeps its fail counted');
  assert.equal(measuredSuiteTotal(536, 2, 3), 541, 'all three classes add up');
});

// 进程快照预算钉给 gate 子进程（2026-10-06）：L1 以 --test-concurrency=3 真起进程，满载机器上
// PowerShell/WMI 枚举超过 15s，成片测试以 `did not return within 15000 ms` 收场——预算红而非判据红。
// 生产默认值不动（snapshot-diagnostics.test.mjs 把 15s 钉成契约），只在 gate 子进程里钉大预算。
test('gate: child processes get a realistic process-snapshot budget while the production default stays 15s', async () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'gate.mjs'), 'utf8');
  assert.match(source, /ORCH_PS_TIMEOUT_MS: process\.env\.ORCH_GATE_PS_TIMEOUT_MS \|\| '120000'/,
    'gate must pin a snapshot budget for its children');
  // 生产默认值不得被顺手改掉。
  const {processSnapshotTimeoutMs} = await import(pathToFileURL(path.join(root, 'scripts', 'core', 'leases.mjs')).href);
  const previous = process.env.ORCH_PS_TIMEOUT_MS;
  try {
    delete process.env.ORCH_PS_TIMEOUT_MS;
    assert.equal(processSnapshotTimeoutMs(), 15000, 'production default stays 15 s');
  } finally {
    if (previous === undefined) delete process.env.ORCH_PS_TIMEOUT_MS; else process.env.ORCH_PS_TIMEOUT_MS = previous;
  }
});
