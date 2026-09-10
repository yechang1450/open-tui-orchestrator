import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const family = path.join(root, 'temp');

// 假 kimi CLI：--help/--version 过 kimi-host 探测；其余调用按提示词里的 checkpoint 指令
// 先记 started、写回执、再记 completed，最后输出完成标记（行为对齐守规矩的真实块代理）。
const FAKE = `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--prompt --output-format --auto'); process.exit(0); }
if (args.includes('--version')) { console.log('9.9.9'); process.exit(0); }
const prompt = args[args.length - 1] || '';
const token = /【本块唯一标识】\\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(prompt)?.[1] || 'tok';
const cp = (helper, file, id, state) => spawnSync(process.execPath, [helper, file, id, state], { windowsHide: true });
for (const m of prompt.matchAll(/开始前：node "([^"]+)" "([^"]+)" (\\S+) started/g)) cp(m[1], m[2], m[3], 'started');
fs.writeFileSync('receipt.json', JSON.stringify({ok: true, token}));
for (const m of prompt.matchAll(/完成自验后：node "([^"]+)" "([^"]+)" (\\S+) completed/g)) cp(m[1], m[2], m[3], 'completed');
console.log('done __ORCH_DONE__ ' + token);
`;

function setup() {
  fs.mkdirSync(family, { recursive: true });
  const ws = fs.mkdtempSync(path.join(family, 'orch-force-'));
  const fake = path.join(ws, 'fake-kimi.mjs');
  fs.writeFileSync(fake, FAKE);
  const acceptance = path.join(ws, 'acceptance.json');
  fs.writeFileSync(acceptance, JSON.stringify({ T001: [{ type: 'json', path: 'receipt.json', equals: { ok: true } }] }));
  const lockFile = path.join(ws, 'no-lock.json');
  const base = { ...process.env, ORCH_AGENT: 'kimi', ORCH_CLI: fake, ORCH_ACCEPTANCE_FILE: acceptance, ORCH_MAINTENANCE_LOCK: lockFile, ORCH_MAX_POLL_MS: '120000' };
  delete base.WORKSPACE_DIR; delete base.ORCH_STATE_DIR; delete base.NODE_TEST_CONTEXT;
  return { ws, acceptance, lockFile, env: base };
}

const run = (env, extra = []) => spawnSync(process.execPath, [path.join(root, 'cli.mjs'), ...extra, '--run-windows', '修复项目81登录页'], { cwd: env.__ws, env: (() => { const e = { ...env, WORKSPACE_DIR: env.__ws, ORCH_STATE_DIR: path.join(env.__ws, 'temp', 'orchestrator') }; delete e.__ws; return e; })(), encoding: 'utf8', windowsHide: true, timeout: 120000 });

test('a single-block request returns inline by default', () => {
  const s = setup();
  const env = { ...s.env, __ws: s.ws };
  try {
    const r = run(env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"mode":"inline"/);
    assert.doesNotMatch(r.stdout, /spawned headless/);
  } finally { fs.rmSync(s.ws, { recursive: true, force: true }); }
});

test('ORCH_FORCE_EXECUTE bypasses the inline gate and actually spawns a unit', () => {
  const s = setup();
  const env = { ...s.env, __ws: s.ws, ORCH_FORCE_EXECUTE: '1' };
  try {
    const r = run(env);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /"mode":"inline"/);
    assert.match(r.stdout, /force-execute: inline gate bypassed/);
    assert.match(r.stdout, /spawned headless kimi unit/);
    assert.match(fs.readFileSync(path.join(s.ws, 'receipt.json'), 'utf8'), /"ok":true/);
    const m = /runId=([A-Za-z0-9_-]+)/.exec(r.stdout);
    assert.ok(m, 'engine must report its runId');
    const sum = JSON.parse(fs.readFileSync(path.join(s.ws, 'temp', 'orchestrator', 'runs', m[1], 'summary.json'), 'utf8'));
    assert.equal(sum.success, true);
  } finally { fs.rmSync(s.ws, { recursive: true, force: true }); }
});

test('the maintenance lock still blocks a forced invocation', () => {
  const s = setup();
  fs.writeFileSync(s.lockFile, JSON.stringify({ version: 1, reason: 'test', startedAt: Date.now(), expiresAt: Date.now() + 3600000 }));
  const env = { ...s.env, __ws: s.ws, ORCH_FORCE_EXECUTE: '1' };
  try {
    const r = run(env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /open-tui-orchestrator正在维护更新，本轮跳过orchestrator直接开始执行/);
    assert.doesNotMatch(r.stdout, /spawned headless/);
  } finally { fs.rmSync(s.ws, { recursive: true, force: true }); }
});
