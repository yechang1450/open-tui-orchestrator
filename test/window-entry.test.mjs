import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadProfile, profileArgs} from '../scripts/core/print-profile.mjs';
import {resolveRuntimeContext, msysToNative} from '../scripts/core/runtime-context.mjs';

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

// 判据：Windows/Git-Bash 风格的 /d/temp/ws 必须归一为原生形式（否则 spawn cwd 会被烫成 D:\d\temp\…
// 而 ENOENT）；而 Linux/macOS 上的 /d/temp/ws 就是普通绝对路径，必须原样保留（不得改写成 D:/temp/ws）。
// 两条语义在**任何平台**上都判定：平台注入纯函数 + 当前平台走一遍真解析链，不再用 {skip} 跳过——
// 跳过等于留一个永远不会红的盲区，而 gate 的 L1 判据要求 skipped==0（2026-09-22 合并成一条）。
// 反例（必红）：去掉 msysToNative 的平台判断 → POSIX 断言红；去掉归一 → workspace 变成 <cwd 盘>:\d\temp\ws。
test('runtime context normalizes MSYS-style paths on Windows and keeps POSIX absolute paths elsewhere', () => {
  assert.equal(msysToNative('/d/temp/ws', 'win32'), 'D:/temp/ws');
  assert.equal(msysToNative('/C/temp/ws', 'win32'), 'C:/temp/ws');
  assert.equal(msysToNative('D:/temp/ws', 'win32'), 'D:/temp/ws');
  assert.equal(msysToNative('/d/temp/ws', 'linux'), '/d/temp/ws');
  assert.equal(msysToNative('/d/temp/ws', 'darwin'), '/d/temp/ws');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'otui-window-entry-'));
  const workspace = path.join(fixture, 'ws');
  const state = path.join(workspace, 'temp', 'orchestrator');
  fs.mkdirSync(state, {recursive: true});
  const native = value => path.resolve(value).replaceAll('\\', '/');
  const toMsys = value => {
    const normalized = native(value);
    if (process.platform !== 'win32') return normalized;
    const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
    return drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : normalized;
  };
  try {
    const r = resolveRuntimeContext(
      {WORKSPACE_DIR: toMsys(workspace), ORCH_STATE_DIR: toMsys(state)},
      process.cwd(),
    );
    assert.equal(r.workspace, path.resolve(workspace));
    assert.equal(r.state, path.resolve(state));
  } finally {
    fs.rmSync(fixture, {recursive: true, force: true});
  }
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
