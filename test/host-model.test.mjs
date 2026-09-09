import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectHostModelEffort, inheritHostModelEffort } from '../scripts/core/host-model.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'host-model-'));
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// ------------------------------------------------------------------ codex --
test('codex: CODEX_THREAD_ID 定位 rollout，取最后出现的 model/reasoning_effort', () => {
  const home = tmpdir();
  const tid = '01a0856d-094f-7b43-829c-d178936249a6';
  const now = new Date();
  const y = String(now.getFullYear());
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const roll = path.join(home, 'sessions', y, mo, d, `rollout-2026-09-09T17-08-30-${tid}.jsonl`);
  write(roll, [
    JSON.stringify({ type: 'turn_context', payload: { model: 'old-model', reasoning_effort: 'low' } }),
    JSON.stringify({ type: 'response_item', payload: { model: 'gpt-6-astra', reasoning_effort: 'ultra' } }),
  ].join('\n'));
  const got = detectHostModelEffort('codex', { env: { CODEX_THREAD_ID: tid }, homes: { codex: home } });
  assert.deepEqual(got, { model: 'gpt-6-astra', effort: 'ultra', source: 'codex-rollout' });
});

test('codex: 找不到 rollout 时回退 config.toml 的 model/model_reasoning_effort', () => {
  const home = tmpdir();
  write(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "ultra"\n');
  const got = detectHostModelEffort('codex', { env: { CODEX_THREAD_ID: 'missing-tid' }, homes: { codex: home } });
  assert.deepEqual(got, { model: 'gpt-6-astra', effort: 'ultra', source: 'codex-config' });
});

test('codex: rollout 与 config 都没有时返回 null', () => {
  const home = tmpdir();
  assert.equal(detectHostModelEffort('codex', { env: {}, homes: { codex: home } }), null);
});

// ------------------------------------------------------------------- kimi --
function kimiSession(home, wdName, sessionName, cwd, updatedAt, wireLines) {
  const dir = path.join(home, 'sessions', wdName, sessionName);
  write(path.join(dir, 'state.json'), JSON.stringify({ cwd, updatedAt }));
  if (wireLines) write(path.join(dir, 'agents', 'main', 'wire.jsonl'), wireLines.join('\n'));
}

test('kimi: 按 cwd 匹配最新会话，读 wire.jsonl 末条 llm.request 的 modelAlias/thinkingEffort', () => {
  const home = tmpdir();
  kimiSession(home, 'wd_d_aaa', 'session_old', 'D:/', 100, [
    JSON.stringify({ type: 'llm.request', model: 'kimi-k2', modelAlias: 'kimi-k2', thinkingEffort: 'low' }),
  ]);
  kimiSession(home, 'wd_d_bbb', 'session_new', 'D:\\', 200, [
    JSON.stringify({ type: 'context.append_message', model: 'decoy' }),
    JSON.stringify({ type: 'llm.request', model: 'kimi-k3', modelAlias: 'kimi-k3', thinkingEffort: 'max' }),
  ]);
  const got = detectHostModelEffort('kimi', { cwd: 'D:\\', env: {}, homes: { kimi: home } });
  assert.deepEqual(got, { model: 'kimi-k3', effort: 'max', source: 'kimi-wire' });
});

test('kimi: cwd 不匹配任何会话时回退 config.toml 的 default_model/[thinking].effort', () => {
  const home = tmpdir();
  kimiSession(home, 'wd_x', 'session_a', 'C:/elsewhere', 999, null);
  write(path.join(home, 'config.toml'), 'default_model = "kimi-k3"\n[thinking]\nenabled = true\neffort = "max"\n');
  const got = detectHostModelEffort('kimi', { cwd: 'D:/', env: {}, homes: { kimi: home } });
  assert.deepEqual(got, { model: 'kimi-k3', effort: 'max', source: 'kimi-config' });
});

// --------------------------------------------------------------------- pi --
test('pi: 读 settings.json 的 defaultModel/defaultThinkingLevel', () => {
  const home = tmpdir();
  write(path.join(home, 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'opencode-go', defaultModel: 'glm-5.3-flash', defaultThinkingLevel: 'max' }));
  const got = detectHostModelEffort('pi', { env: {}, homes: { pi: home } });
  assert.deepEqual(got, { model: 'glm-5.3-flash', effort: 'max', source: 'pi-settings' });
});

// --------------------------------------------------------------- opencode --
test('opencode: 解析带注释/尾逗号的 jsonc 顶层 model；effort 恒 null', () => {
  const home = tmpdir();
  write(path.join(home, 'opencode.jsonc'), '{\n  // user model\n  "$schema": "https://opencode.ai/config.json",\n  "model": "opencode-go/glm-5.3-flash",\n}\n');
  const got = detectHostModelEffort('opencode', { env: {}, homes: { opencode: home } });
  assert.deepEqual(got, { model: 'opencode-go/glm-5.3-flash', effort: null, source: 'opencode-config' });
});

test('openclaw 与未知 agent 不检测', () => {
  assert.equal(detectHostModelEffort('openclaw', { env: {} }), null);
  assert.equal(detectHostModelEffort('bogus', { env: {} }), null);
});

// ----------------------------------------------------------------- 卫生 ----
test('含空白/引号的脏值一律丢弃', () => {
  const home = tmpdir();
  write(path.join(home, 'agent', 'settings.json'), JSON.stringify({ defaultModel: 'glm "; bad', defaultThinkingLevel: 'max\nrm -rf' }));
  assert.equal(detectHostModelEffort('pi', { env: {}, homes: { pi: home } }), null);
});

// ------------------------------------------------------ 引擎写回优先级 ------
test('inheritHostModelEffort: 显式 env 优先，检测只补空缺', () => {
  const home = tmpdir();
  write(path.join(home, 'agent', 'settings.json'), JSON.stringify({ defaultModel: 'glm-5.3-flash', defaultThinkingLevel: 'max' }));
  const env = { ORCH_MODEL: 'explicit-model' };
  const got = inheritHostModelEffort('pi', { env, homes: { pi: home } });
  assert.deepEqual(got, { model: 'glm-5.3-flash', effort: 'max', source: 'pi-settings' });
  assert.equal(env.ORCH_MODEL, 'explicit-model'); // 不被覆盖
  assert.equal(env.ORCH_EFFORT, 'max');           // 空缺被补齐
});

test('inheritHostModelEffort: NODE_TEST_CONTEXT 下豁免；kimi 同步写 KIMI_MODEL_THINKING_EFFORT', () => {
  const home = tmpdir();
  write(path.join(home, 'config.toml'), 'default_model = "kimi-k3"\n[thinking]\neffort = "max"\n');
  const guarded = { NODE_TEST_CONTEXT: '1' };
  assert.equal(inheritHostModelEffort('kimi', { cwd: 'D:/', env: guarded, homes: { kimi: home } }), null);
  assert.equal(guarded.ORCH_MODEL, undefined);
  const env = {};
  inheritHostModelEffort('kimi', { cwd: 'D:/', env, homes: { kimi: home } });
  assert.equal(env.ORCH_MODEL, 'kimi-k3');
  assert.equal(env.ORCH_EFFORT, 'max');
  assert.equal(env.KIMI_MODEL_THINKING_EFFORT, 'max');
});
