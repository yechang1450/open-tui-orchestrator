import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadProfile, profileArgs} from '../scripts/core/print-profile.mjs';
import {resolveRuntimeContext} from '../scripts/core/runtime-context.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// 判据：窗口入口只在 mode=window 时生效；headless（默认）逐字不变。
// 反例（必红）：把 mode 透传删掉 → window 断言 '--tui' 失败。
test('profile window entry: mode=window picks the TUI argv, headless stays verbatim', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'core', 'agent-profiles', 'hermes.json'), 'utf8'));
  const cfg = {profile: {args: raw.args || raw.profile?.args || {}}};
  const headless = profileArgs(cfg, {});
  const win = profileArgs(cfg, {mode: 'window'});
  assert.ok(headless.includes('-z'), `headless keeps the one-shot flag: ${JSON.stringify(headless)}`);
  assert.ok(!headless.includes('--tui'), `headless must not carry the TUI flag: ${JSON.stringify(headless)}`);
  assert.equal(win[0], 'chat', `window argv starts with the subcommand: ${JSON.stringify(win)}`);
  assert.ok(win.includes('--tui'), `window argv carries the TUI flag: ${JSON.stringify(win)}`);
  assert.equal(win[win.length - 1], '-q', `window argv ends with the seeding flag (prompt appended by the caller): ${JSON.stringify(win)}`);
  assert.ok(!win.includes('-z'), `window argv must not carry the one-shot flag: ${JSON.stringify(win)}`);
});

// 判据：MSYS 风格路径必须归一为原生形式（否则 spawn cwd 会被烫成 D:\d\temp\… 而 ENOENT）。
// 反例（必红）：去掉 msysToNative → workspace 变成 <cwd 盘>:\d\temp\ws。
test('runtime context normalizes MSYS-style paths instead of mangling them', () => {
  const r = resolveRuntimeContext(
    {WORKSPACE_DIR: '/d/temp/ws', ORCH_STATE_DIR: '/d/temp/ws/temp/orchestrator'},
    'D:/'
  );
  assert.equal(r.workspace, path.resolve('D:/temp/ws'));
  assert.equal(r.state, path.resolve('D:/temp/ws/temp/orchestrator'));
});

// 判据：hermes 画像必须声明窗口入口（真 TUI 路线依赖它）。
// 反例（必红）：删掉画像里的 windowPrefix/windowPrompt → 断言失败。
test('the hermes profile declares the window entry', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'core', 'agent-profiles', 'hermes.json'), 'utf8'));
  const args = raw.args || raw.profile?.args || {};
  assert.ok(Array.isArray(args.windowPrefix) && args.windowPrefix.includes('--tui'), 'windowPrefix includes --tui');
  assert.ok(Array.isArray(args.windowPrompt) && args.windowPrompt.includes('-q'), 'windowPrompt is the seeding flag');
  assert.ok(Array.isArray(args.prompt) && args.prompt.includes('-z'), 'the headless one-shot flag stays');
});
