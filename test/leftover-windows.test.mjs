import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {leftoverWindowHandles} from '../scripts/orchestrate-sdk.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const family = path.join(root, 'temp');

// 2026-09-17 用户令：杀过进程/powercut 之后不许留下一排「[已退出进程，代码为 N]」的窗让人手动关。
// 收口只用**本 run 自己**录下的窗口句柄（spawn 时写的 win-*.window.json），且执行侧还要求窗口属于
// Windows Terminal 且其宿主当前无任何子进程（尸体窗）。本判据锁住"只认自己的记录"这一半：
test('leftover window handles come only from this run\'s own spawn verdicts', () => {
  const dir = fs.mkdtempSync(path.join(family, 'leftover-'));
  try {
    fs.writeFileSync(path.join(dir, 'win-B1-run-a1.window.json'), JSON.stringify({ok: true, hwnd: '0x1234', title: 'x'}), 'utf8');
    fs.writeFileSync(path.join(dir, 'win-B2-run-a1.window.json'), JSON.stringify({ok: true, hwnd: '0x1234'}), 'utf8');   // 去重
    fs.writeFileSync(path.join(dir, 'win-B3-run-a1.window.json'), JSON.stringify({ok: false, reason: 'no new visible window appeared within 9000ms'}), 'utf8'); // 没有 hwnd
    fs.writeFileSync(path.join(dir, 'win-B4-run-a1.window.json'), '{ not json', 'utf8');                                  // 坏文件
    fs.writeFileSync(path.join(dir, 'window-B5-run-a1.pid'), '1234', 'utf8');                                             // 非裁决文件
    fs.writeFileSync(path.join(dir, 'other.window.json'), JSON.stringify({hwnd: '0xDEAD'}), 'utf8');                       // 命名不符，不收
    const got = leftoverWindowHandles(dir);
    assert.deepEqual(got, ['0x1234'], 'only well-formed hwnd values from this run\'s verdict files may be closed: ' + JSON.stringify(got));
    assert.deepEqual(leftoverWindowHandles(path.join(dir, 'missing')), [], 'a missing dir must not throw');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('the run path sweeps leftover windows before the runner starts (source wiring)', () => {
  const src = fs.readFileSync(path.join(root, 'scripts', 'core', 'orchestrate-sdk.mjs'), 'utf8');
  const idxSweep = src.indexOf('await sweepLeftoverRunWindows();');
  const idxRun = src.indexOf('const result=await runWindows(request,{');
  assert.ok(idxSweep > -1, 'sweepLeftoverRunWindows must be wired into the run path');
  assert.ok(idxRun > -1, 'runWindows call must exist');
  assert.ok(idxSweep < idxRun, 'the sweep must run before the runner so stale corpses vanish before new windows open');
});
