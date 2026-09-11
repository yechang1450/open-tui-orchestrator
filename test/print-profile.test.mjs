import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveProfileHost,profileArgs} from '../scripts/core/print-profile.mjs';
import {writeProfileLauncher,waitProfileResult} from '../scripts/core/print-runtime.mjs';
import {adaptAgent} from '../scripts/core/adapt-lib.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const family = path.join(root, 'temp');

// 伪 print-class CLI：FAKE_HELP 控制 --help 表面、FAKE_VERSION 控制版本；
// 探活提示词 → 只回令牌；块提示词 → 执行 checkpoint 协议 + 写回执 + 完成标记。
const FAKE = `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log(process.env.FAKE_HELP || '--message --yes-always --model'); process.exit(0); }
if (args.includes('--version')) { console.log(process.env.FAKE_VERSION || 'FakeAgent 7.7.7'); process.exit(0); }
const prompt = args[args.length - 1] || '';
const adapt = /reply with exactly (ADAPTOK-\\S+) and nothing else/.exec(prompt);
if (adapt) { console.log(adapt[1]); process.exit(0); }
const token = /【本块唯一标识】\\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(prompt)?.[1] || 'tok';
const cp = (helper, file, id, state) => spawnSync(process.execPath, [helper, file, id, state], { windowsHide: true });
for (const m of prompt.matchAll(/开始前：node "([^"]+)" "([^"]+)" (\\S+) started/g)) cp(m[1], m[2], m[3], 'started');
fs.writeFileSync('receipt.json', JSON.stringify({ok: true, token}));
for (const m of prompt.matchAll(/完成自验后：node "([^"]+)" "([^"]+)" (\\S+) completed/g)) cp(m[1], m[2], m[3], 'completed');
console.log('done __ORCH_DONE__ ' + token);
`;

function setup() {
  fs.mkdirSync(family, {recursive: true});
  const dir = fs.mkdtempSync(path.join(family, 'print-profile-'));
  const fake = path.join(dir, 'fakeprint.mjs');
  const profiles = path.join(dir, 'agent-profiles');
  fs.writeFileSync(fake, FAKE);
  return {dir, fake, profiles};
}

test('adapt probes a print-class CLI surface and generates a profile (live-verified, no commit)', () => {
  const s = setup();
  try {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'adapt.mjs'), '--agent', 'fakeprint', '--cli', s.fake, '--profiles-dir', s.profiles, '--no-commit', '--json'], { env: {...process.env}, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const report = JSON.parse(r.stdout);
    assert.equal(report.passed, true, JSON.stringify(report).slice(0, 400));
    assert.equal(report.version, '7.7.7');
    assert.deepEqual(report.profile.args.prompt, ['--message']);
    assert.deepEqual(report.profile.args.approve, ['--yes-always']);
    assert.deepEqual(report.profile.args.model, ['--model']);
    assert.equal(report.profile.args.effort, null);
    assert.equal(report.live.answered, true);
    assert.equal(report.committed, false);
    const written = JSON.parse(fs.readFileSync(path.join(s.profiles, 'fakeprint.json'), 'utf8'));
    assert.equal(written.schema, 1);
    assert.equal(written.id, 'fakeprint');
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('a generated profile resolves and its argv keeps the prompt after the prompt flag', () => {
  const s = setup();
  try {
    spawnSync(process.execPath, [path.join(root, 'scripts', 'adapt.mjs'), '--agent', 'fakeprint', '--cli', s.fake, '--profiles-dir', s.profiles, '--no-commit'], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const env = {...process.env, ORCH_AGENT_PROFILES_DIR: s.profiles, ORCH_CLI: s.fake};
    const host = resolveProfileHost(env, 'fakeprint');
    assert.equal(host.agent, 'fakeprint');
    assert.equal(host.config.version, '7.7.7');
    const args = profileArgs(host.config, {model: 'fake/m1', effort: null});
    assert.equal(args[args.length - 1], '--message');
    assert.ok(args.includes('--yes-always'));
    assert.equal(args[args.indexOf('--model') + 1], 'fake/m1');
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('the profile launcher round-trips prompt argv, checkpoints, receipt and result file', () => {
  const s = setup();
  try {
    spawnSync(process.execPath, [path.join(root, 'scripts', 'adapt.mjs'), '--agent', 'fakeprint', '--cli', s.fake, '--profiles-dir', s.profiles, '--no-commit'], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const host = resolveProfileHost({...process.env, ORCH_AGENT_PROFILES_DIR: s.profiles, ORCH_CLI: s.fake}, 'fakeprint');
    const prompt = '执行窗口任务 "带引号" 与中文\n【本块唯一标识】pptest1';
    const la = writeProfileLauncher(host.config, {key: 'B1', suffix: 'test', prompt, workspace: s.dir, temp: path.join(s.dir, 'temp')});
    const result = spawnSync('powershell.exe', ['-NoProfile', '-File', la.lp], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const r = JSON.parse(fs.readFileSync(la.rf, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0]);
    assert.equal(r.__EXIT__, 0);
    assert.ok(String(r.__REPORT__).includes('pptest1'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'receipt.json'), 'utf8')).ok, true);
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('waitProfileResult returns the launcher-written outcome immediately', async () => {
  const s = setup();
  try {
    const rf = path.join(s.dir, 'r.json');
    fs.writeFileSync(rf, JSON.stringify({__EXIT__: 0, __DONE__: true, __REPORT__: 'ok'}));
    const res = await waitProfileResult(rf, 5000, path.join(s.dir, 'missing.pid'));
    assert.equal(res.done, true); assert.equal(res.exitCode, 0); assert.equal(res.text, 'ok');
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('a profiled agent runs end-to-end through orch (forced unit, acceptance verified)', async () => {
  const s = setup();
  const ws = fs.mkdtempSync(path.join(family, 'print-profile-run-'));
  try {
    spawnSync(process.execPath, [path.join(root, 'scripts', 'adapt.mjs'), '--agent', 'fakeprint', '--cli', s.fake, '--profiles-dir', s.profiles, '--no-commit'], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    fs.writeFileSync(path.join(ws, 'acceptance.json'), JSON.stringify({T001: [{type: 'json', path: 'receipt.json', equals: {ok: true}}]}));
    const env = {...process.env, ORCH_AGENT: 'fakeprint', ORCH_CLI: s.fake, ORCH_AGENT_PROFILES_DIR: s.profiles, ORCH_ACCEPTANCE_FILE: path.join(ws, 'acceptance.json'), ORCH_MAINTENANCE_LOCK: path.join(ws, 'no-lock.json'), ORCH_MAX_POLL_MS: '120000', WORKSPACE_DIR: ws, ORCH_STATE_DIR: path.join(ws, 'temp', 'orchestrator')};
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, [path.join(root, 'orch.mjs'), '--run-id', 'profile-e2e', '整理一下这个请求'], { cwd: ws, env, encoding: 'utf8', windowsHide: true, timeout: 180000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /spawned headless fakeprint unit/);
    const sum = JSON.parse(fs.readFileSync(path.join(ws, 'temp', 'orchestrator', 'runs', 'profile-e2e', 'summary.json'), 'utf8'));
    assert.equal(sum.success, true, JSON.stringify(sum.results).slice(0, 400));
  } finally {
    for (let i = 0; i < 5; i++) { try { fs.rmSync(s.dir, {recursive: true, force: true}); } catch { /* retry */ } try { fs.rmSync(ws, {recursive: true, force: true}); } catch { /* retry */ } await new Promise((res) => setTimeout(res, 400)); }
  }
});

test('built-in agents are reported as already adapted and nothing is written', async () => {
  const report = await adaptAgent({id: 'kimi', live: false, commit: false});
  assert.equal(report.passed, true);
  assert.equal(report.skipped, 'builtin');
});
