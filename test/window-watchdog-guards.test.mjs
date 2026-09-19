import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = fs.readFileSync(path.join(root, 'scripts', 'core', 'orchestrate-sdk.mjs'), 'utf8');

// 截取 writeInteractiveLauncher 的启动器正文区间（const body = [ … ].join）
function launcherBodySlice() {
  const fn = src.indexOf('function writeInteractiveLauncher');
  assert.ok(fn > 0, 'writeInteractiveLauncher must exist');
  const from = src.indexOf('const body = [', fn);
  const to = src.indexOf('].join', from);
  assert.ok(from > 0 && to > from, 'launcher body array must be found');
  return src.slice(from, to);
}

// 判据①：弱判据（token+完成 字词）不得回归——它曾在 8-25 秒内随机错杀活窗。
// 反例（必红）：把 Contains('__NEVER_TOKEN_DONE__') 改回 Contains('完成')。
test('window watchdog: the word-based completion heuristic stays disabled', () => {
  const body = launcherBodySlice();
  assert.ok(!body.includes("Contains('完成')"), 'the token+完成 heuristic must never come back (it kills live windows)');
  assert.ok(body.includes('__NEVER_TOKEN_DONE__'), 'the inert switch documents the disabled heuristic');
  assert.ok(body.includes('__ORCH_DONE__'), 'completion relies on the __ORCH_DONE__ marker');
});

// 判据②：启动器正文里不得出现"字符串内容行里的 /*"——PowerShell 逐行解析正文，正文里出现 C 风格注释即整窗解析崩（曾致全员速死）。
// 合法豁免：JS 层注释行（// 开头，不进 PS）与嵌在 here-string 里的 C# 处 `/* ignore */`。
// 反例（必红）：在任一 "…" 正文行里写 /* … */。
test('window watchdog: the launcher body has no stray C-style comments (PowerShell parses it line by line)', () => {
  const body = launcherBodySlice();
  const lines = body.split('\n').filter((l) => !l.trim().startsWith('//'));
  const cleaned = lines.join('\n').split('/* ignore */').join('');
  assert.ok(!cleaned.includes('/*') && !cleaned.includes('*/'), 'no stray /* */ inside launcher body lines — PowerShell does not parse it');
});
