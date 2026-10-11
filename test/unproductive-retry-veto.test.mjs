import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runWindows} from '../scripts/core/runner.mjs';
import {powershellExe} from '../scripts/core/contracts.mjs';

const family = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../temp');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeHarness({workspace, runId}) {
  const ps = powershellExe();
  const kids = [];
  let attempt = 0;
  const checkpointHelper = fileURLToPath(new URL('../scripts/core/checkpoint.mjs', import.meta.url));
  const attemptFile = n => path.join(workspace, 'temp', 'orchestrator', 'runs', runId, 'attempts', 'B1', String(n), 'attempt.json');
  const sessionFile = path.join(workspace, 'fake-session.jsonl');
  fs.writeFileSync(sessionFile, 'start\n', 'utf8');
  const launcher = key => {
    const lp = path.join(workspace, `win-launch-${key}.ps1`);
    // WMI identity binding can take several seconds under the full suite; keep
    // the fake launcher alive long enough to reach the actual wait/veto path.
    fs.writeFileSync(lp, 'Start-Sleep -Seconds 30\n', 'utf8');
    const pidf = path.join(workspace, `window-${key}.pid`);
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', lp], {windowsHide: true, stdio: 'ignore'});
    kids.push(child);
    fs.writeFileSync(pidf, String(child.pid), 'utf8');
    return {lp, pidf, rf: path.join(workspace, `win-${key}.result.json`)};
  };
  const hooks = {
    plan: async () => [{title: 'A', tasks: [{prompt: '执行甲'}]}],
    compact: value => value,
    infer: () => [],
    prompt: value => value,
    launcher,
    spawn: async () => true,
    session: async () => sessionFile,
    wait: async () => {
      attempt += 1;
      if (attempt === 1) return {done: false, exitCode: 1};
      fs.mkdirSync(path.join(workspace, 'proj-07'), {recursive: true});
      fs.writeFileSync(path.join(workspace, 'proj-07', 'alpha.txt'), 'ALPHA_OK', 'utf8');
      spawnSync(process.execPath, [checkpointHelper, attemptFile(attempt), 'T001', 'started'], {windowsHide: true, timeout: 15000});
      spawnSync(process.execPath, [checkpointHelper, attemptFile(attempt), 'T001', 'completed'], {windowsHide: true, timeout: 15000});
      return {done: true, exitCode: 0};
    },
    readPid: pidf => Number(fs.readFileSync(pidf, 'utf8').trim()),
    exitCode: () => 0,
    register: () => {},
    unregister: () => {},
    cleanup: () => {},
    commit: () => {},
    guardian: () => {},
    close: async pid => {
      const child = kids.find(item => item.pid === pid);
      if (child) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {windowsHide: true, timeout: 10000}); } catch {} }
    },
  };
  const acceptanceFile = path.join(workspace, 'acceptance.json');
  fs.writeFileSync(acceptanceFile, JSON.stringify({T001: {retrySafe: false, checks: [{type: 'file', path: 'proj-07/alpha.txt'}]}}), 'utf8');
  return {hooks, acceptanceFile, kids, attempts: () => attempt};
}

async function cleanup(workspace, kids) {
  for (const child of kids) {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, timeout: 10000}); } catch {}
  }
  await sleep(200);
  fs.rmSync(workspace, {recursive: true, force: true});
}

test('retrySafe:false vetoes the unproductive no-checkpoint retry', {timeout: 180000}, async () => {
  fs.mkdirSync(family, {recursive: true});
  const workspace = fs.mkdtempSync(path.join(family, 'unproductive-veto-'));
  const harness = makeHarness({workspace, runId: 'unproductive-veto'});
  const previousBackoff = process.env.ORCH_TRANSIENT_BACKOFF_MS;
  process.env.ORCH_TRANSIENT_BACKOFF_MS = '0';
  try {
    const sum = await runWindows('执行甲', harness.hooks, {
      workspace,
      capacity: 4,
      runId: 'unproductive-veto',
      auth: 'test',
      coordinator: path.join(workspace, 'temp', 'coordinator'),
      acceptanceFile: harness.acceptanceFile,
      maxAttempts: 1,
      timeoutMs: 60000,
    });
    assert.equal(sum.success, false);
    assert.equal(harness.attempts(), 1, 'the explicit retry veto must cover the unproductive path too');
    assert.match(String(sum.results.B1.reason || ''), /Uncertain tasks|retrySafe|veto|budget/i);
  } finally {
    if (previousBackoff === undefined) delete process.env.ORCH_TRANSIENT_BACKOFF_MS;
    else process.env.ORCH_TRANSIENT_BACKOFF_MS = previousBackoff;
    await cleanup(workspace, harness.kids);
  }
});
