import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRuntimeContext, runDirectory } from '../scripts/runtime-context.mjs';
import { containedBy } from '../scripts/core/path-security.mjs';
import { launchArgs } from '../scripts/host-cli.mjs';

test('invocation directory owns windows and all default orchestration state', () => {
  const cwd = path.resolve('temp', 'caller workspace');
  const context = resolveRuntimeContext({}, cwd);
  assert.equal(context.workspace, cwd);
  assert.equal(context.temp, path.join(cwd, 'temp'));
  assert.equal(context.state, path.join(cwd, 'temp', 'orchestrator'));
});
test('explicit workspace resolves against caller and propagates without relocating it', () => {
  const cwd = path.resolve('temp');
  const context = resolveRuntimeContext({ WORKSPACE_DIR: 'project' }, cwd);
  assert.equal(context.workspace, path.join(cwd, 'project'));
  assert.equal(context.state, path.join(cwd, 'project', 'temp', 'orchestrator'));
});
test('state override stays inside the initiating workspace temp directory', () => {
  const cwd = path.resolve('temp', 'state-owner');
  const relative = resolveRuntimeContext({ ORCH_STATE_DIR: 'custom', }, cwd);
  assert.equal(relative.state, path.join(cwd, 'temp', 'custom'));
  assert.throws(
    () => resolveRuntimeContext({ ORCH_STATE_DIR: path.join(cwd, '..', 'outside-state') }, cwd),
    /ORCH_STATE_DIR.*workspace temp/i,
  );
});
test('direct runDirectory callers cannot redirect state outside the workspace temp directory', () => {
  const workspace = path.resolve('temp', 'run-owner');
  assert.throws(
    () => runDirectory(workspace, 'safe-run', path.join(workspace, '..', 'outside-state')),
    /state directory.*workspace temp/i,
  );
});
test('state overrides cannot escape through a directory junction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otui-context-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  const link = path.join(workspace, 'temp', 'linked-state');
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(outside, link, 'junction');
  try {
    assert.throws(
      () => resolveRuntimeContext({ ORCH_STATE_DIR: link }, workspace),
      /ORCH_STATE_DIR.*workspace temp/i,
    );
    assert.throws(
      () => runDirectory(workspace, 'linked-run', link),
      /state directory.*workspace temp/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('state overrides reject dangling junctions instead of treating them as missing paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otui-context-dangling-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  const link = path.join(workspace, 'temp', 'dangling-state');
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(outside, link, 'junction');
  fs.rmSync(outside, { recursive: true, force: true });
  try {
    assert.throws(
      () => resolveRuntimeContext({ ORCH_STATE_DIR: link }, workspace),
      /ORCH_STATE_DIR.*workspace temp/i,
    );
    assert.throws(
      () => runDirectory(workspace, 'dangling-run', link),
      /state directory.*workspace temp/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('path containment rejects the exact parent directory, not only deeper ancestors', () => {
  const root = path.resolve('temp', 'containment-owner');
  assert.equal(containedBy(root, path.dirname(root)), false);
  assert.equal(containedBy(root, root), true);
  assert.equal(containedBy(root, path.join(root, 'child')), true);
});
test('authorized windows do not request approval; legacy approval overrides cannot reintroduce prompts', () => {
  const cwd = path.resolve('temp', "caller's workspace");
  const args = launchArgs({id:'codex'}, {cwd});
  assert.equal(args.includes('-a'), false);
  assert.equal(args.includes('never'), false);
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'danger-full-access');
  assert.ok(args.includes(`projects.${JSON.stringify(cwd)}.trust_level="trusted"`));
  const restricted = launchArgs({id:'codex'}, {cwd, approval:['on','request'].join('-'), sandbox:'read-only'});
  assert.equal(restricted[restricted.indexOf('-a') + 1], 'never');
  assert.equal(restricted[restricted.indexOf('--sandbox') + 1], 'read-only');
});
