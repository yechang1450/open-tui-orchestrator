import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const drill = path.join(repo, 'tools', 'l5-recovery-drill.mjs');
const node = process.execPath;  // 2026-10-08: was a hardcoded C:/Program Files/nodejs path (repo convention is process.execPath)
const evidence = path.resolve(repo, '..', '..', 'workspace', 'temp', 'review-l5-20261004', 'security-test');
const marker = 'open-tui-orchestrator l5 root v1\n';

function reset(dir) {
  fs.rmSync(dir, {recursive: true, force: true});
  fs.mkdirSync(dir, {recursive: true});
}

function ownedRoot(dir) {
  reset(dir);
  fs.writeFileSync(path.join(dir, '.orch-l5-root'), marker, 'utf8');
  return dir;
}

function runRejected(root, {cwd = repo, orchRepo = path.join(root, 'fake-repo')} = {}) {
  const env = {
    ...process.env,
    ORCH_L5_ROOT: root,
    ORCH_REPO: orchRepo,
    ORCH_COORDINATOR_DIR: path.join(root, 'coordinator'),
  };
  for (const key of ['WORKSPACE_DIR', 'ORCH_STATE_DIR', 'ORCH_TUI', 'ORCH_APPROVAL', 'ORCH_SANDBOX', 'NODE_TEST_CONTEXT']) delete env[key];
  return spawnSync(node, [drill], {cwd, env, encoding: 'utf8', timeout: 30000, windowsHide: true});
}

function names(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

if (process.platform !== 'win32') {
  test('L5 security tests require Windows', {skip: true}, () => {});
} else {
  test('rejects a root that contains the cwd or repository before creating workspace state', () => {
    const root = ownedRoot(path.join(evidence, 'orch-l5-parent-root'));
    const cwd = path.join(root, 'cwd');
    const fakeRepo = path.join(root, 'repo');
    fs.mkdirSync(cwd, {recursive: true});
    fs.mkdirSync(fakeRepo, {recursive: true});
    const before = names(root);
    const result = runRejected(root, {cwd, orchRepo: fakeRepo});
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr + result.stdout, /cwd|repository|workspace|ORCH_L5_ROOT/i);
    assert.deepEqual(names(root), before, 'root rejection must not create or remove control state');
  });

  test('rejects a symlink or junction in a ROOT ancestor before following it', () => {
    const target = path.join(evidence, 'junction-target');
    const linkParent = path.join(evidence, 'junction-parent');
    const rootTarget = path.join(target, 'orch-l5-ancestor-root');
    reset(target);
    fs.rmSync(linkParent, {recursive: true, force: true});
    fs.symlinkSync(target, linkParent, 'junction');
    ownedRoot(rootTarget);
    const rootThroughLink = path.join(linkParent, path.basename(rootTarget));
    const before = names(rootTarget);
    const result = runRejected(rootThroughLink, {orchRepo: path.join(evidence, 'fake-repo-ancestor')});
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr + result.stdout, /symlink|junction|Unsafe path/i);
    assert.deepEqual(names(rootTarget), before, 'ancestor junction rejection must not write through the link');
    assert.equal(fs.existsSync(path.join(rootTarget, 'ws')), false);
  });

  test('rejects a workspace child junction before deleting or replacing it', () => {
    const root = ownedRoot(path.join(evidence, 'orch-l5-child-junction-root'));
    const outside = path.join(evidence, 'child-junction-target');
    reset(outside);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'keep\n', 'utf8');
    const ws = path.join(root, 'ws');
    fs.symlinkSync(outside, ws, 'junction');
    fs.writeFileSync(path.join(root, 'release'), 'old-release\n', 'utf8');
    fs.writeFileSync(path.join(root, 'waiting'), 'old-waiting\n', 'utf8');
    const result = runRejected(root, {orchRepo: path.join(evidence, 'fake-repo-child')});
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr + result.stdout, /symlink|junction|Unsafe path/i);
    assert.equal(fs.lstatSync(ws).isSymbolicLink(), true, 'the child junction must remain untouched');
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'keep\n');
    assert.equal(fs.readFileSync(path.join(root, 'release'), 'utf8'), 'old-release\n');
    assert.equal(fs.readFileSync(path.join(root, 'waiting'), 'utf8'), 'old-waiting\n');
  });

  test('does not silently continue after workspace cleanup fails', () => {
    const source = fs.readFileSync(drill, 'utf8');
    assert.doesNotMatch(source, /cleanup of the previous run dir failed[\s\S]*continuing/, 'cleanup failure must abort before controls are rewritten');
    assert.match(source, /assertNoSymlinkPath\(WS\)/);
    assert.match(source, /realpathWithMissing/);
  });

  test('does not fall back to an unverified child kill and preserves second-owner identity', () => {
    const source = fs.readFileSync(drill, 'utf8');
    assert.match(source, /sameProcess\(owner, observed\)/);
    assert.match(source, /sameProcess\(owner2,/);
    assert.doesNotMatch(source, /if\s*\(!controllerExited\)\s*\{\s*killTree\(child\.pid\)/s);
    assert.match(source, /identity mismatch/);
    assert.match(source, /snapshot.*unknown|unknown.*snapshot|Cannot verify process identities/is);
  });

  test('serializes salvage timeout recovery and verifies real process closure on success', () => {
    const source = fs.readFileSync(drill, 'utf8');
    assert.match(source, /salvage.*timeout|timeout.*salvage/is);
    assert.match(source, /await[\s\S]{0,300}(stop|kill)[\s\S]{0,300}(quiescent|gone|exited)/i);
    assert.match(source, /guardian[\s\S]{0,300}engine/i);
    assert.match(source, /orphan|quiescent|no live/i);
    assert.match(source, /report\.passed\s*=\s*report\.businessPassed/);
    assert.match(source, /orphanCheckAfterCleanup/);
    assert.match(source, /process\.exit\(report\.passed\s*\?\s*0\s*:\s*1\)/, 'the drill must close its own CLI process after writing the report');
    assert.match(source, /path\.join\(WS,[\s\S]{0,120}runId/i, 'barriers must be run/workspace scoped, not shared ROOT controls');
  });
}

process.on('exit', () => {
  try { fs.rmSync(evidence, {recursive: true, force: true}); } catch {}
});
