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
// 该语义只在 Windows（Git-Bash）成立，其他平台跳过并给出说明，而不是报假失败。
test('runtime context normalizes MSYS-style paths instead of mangling them', (t) => {
  if (process.platform !== 'win32') {
    t.skip('MSYS 风格路径只在 Windows/Git-Bash 上出现；本平台见下一条断言（POSIX 原样保留）');
    return;
  }
  const r = resolveRuntimeContext(
    {WORKSPACE_DIR: '/d/temp/ws', ORCH_STATE_DIR: '/d/temp/ws/temp/orchestrator'},
    'D:/'
  );
  assert.equal(r.workspace, path.resolve('D:/temp/ws'));
  assert.equal(r.state, path.resolve('D:/temp/ws/temp/orchestrator'));
});

// 判据：Linux/macOS 上 /d/temp/ws 就是普通绝对路径，必须原样保留（不得被改写成 D:/temp/ws）。
// 反例（必红）：去掉 msysToNative 里的平台判断 → workspace 变成 <cwd>/D:/temp/ws。
// 该语义只在 POSIX 平台成立（Windows 上 /d/... 会按当前盘符解析），Windows 上跳过并给出说明。
test('runtime context leaves POSIX absolute paths untouched', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX 绝对路径语义只在 Linux/macOS 成立；Windows 见上一条（MSYS 归一）');
    return;
  }
  const r = resolveRuntimeContext(
    {WORKSPACE_DIR: '/d/temp/ws', ORCH_STATE_DIR: '/d/temp/ws/temp/orchestrator'},
    '/tmp'
  );
  assert.equal(r.workspace, path.resolve('/tmp', '/d/temp/ws'));
  assert.equal(r.state, path.resolve('/d/temp/ws/temp/orchestrator'));
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
