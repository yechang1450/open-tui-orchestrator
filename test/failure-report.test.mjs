import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyFailure, formatFailureLines} from '../scripts/core/failure-report.mjs';

// 用户令 2026-09-18：能自愈的自愈；修不了的必须「问题+原因+已尝试+怎么办」。
// 这些判据能红：把 formatFailureLines 退回只打一行 FATAL，本文件立刻失败。

test('first line stays the machine contract, guidance follows', () => {
  const err = new Error('CLI_MISSING: claude; no supported installed Claude Code CLI found.');
  const lines = formatFailureLines(err);
  assert.equal(lines[0], '[orchestrator] FATAL: CLI_MISSING: claude; no supported installed Claude Code CLI found.');
  assert.ok(lines.length > 1, 'guidance lines must follow the FATAL line');
  assert.ok(lines.some(l => l.includes('cause:')), 'cause must be stated');
  assert.ok(lines.some(l => l.includes('tried:')), 'what was already tried must be stated');
  assert.ok(lines.some(l => l.includes('fix:')), 'the user must be told what to do');
});

test('cli-missing guidance names the concrete remedy', () => {
  const c = classifyFailure(new Error('CLI_MISSING: kimi; no supported installed Kimi Code CLI found.'));
  assert.equal(c.tier, 'guidance');
  assert.match(c.fix, /--cli|ORCH_CLI|npm i -g/);
  assert.ok(c.tried.length >= 1);
});

test('quota exhaustion tells the user to wait or upgrade, not just fail', () => {
  const c = classifyFailure(new Error("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 4:10 PM."));
  assert.equal(c.tier, 'guidance');
  assert.match(c.fix, /重置|等待|升级|重跑/);
});

test('uncertain tasks point at retrySafe (the auto-retry declaration)', () => {
  const c = classifyFailure(new Error('Uncertain tasks: T002 — hint: declare {"checks":[...],"retrySafe":true}'));
  assert.equal(c.tier, 'repair');
  assert.match(c.fix, /retrySafe/);
});

test('stall/auto-healed failures do not carry guidance noise', () => {
  const c = classifyFailure(new Error('stalled: no unit progress for 34s'));
  assert.equal(c.tier, 'auto');
  const lines = formatFailureLines(c);
  assert.equal(lines.length, 1, 'auto-healed classes stay one line');
});

test('an unknown failure still exits with a cause and a next step', () => {
  const lines = formatFailureLines(new Error('weird platform-specific explosion'));
  assert.equal(lines[0], '[orchestrator] FATAL: weird platform-specific explosion');
  assert.ok(lines.some(l => l.includes('cause:')));
  assert.ok(lines.some(l => l.includes('fix:') && l.includes('ORCH_DEBUG')));
});
