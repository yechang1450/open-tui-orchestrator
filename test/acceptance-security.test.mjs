import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveAcceptanceCommand, verifyChecks} from '../scripts/core/contracts.mjs';

// 2026-10-09: WORKSPACE_DIR first - the old chain assumed the repo lives INSIDE the workspace
// (the pre-move layout) and now lands on the deprecated USERPROFILE\workspace shell.
const evidenceRoot = path.join(process.env.WORKSPACE_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'workspace'), 'temp', 'otui-review-acceptance-20261004');
fs.mkdirSync(evidenceRoot, {recursive: true});
const fixture = prefix => {
  const dir = fs.mkdtempSync(path.join(evidenceRoot, prefix));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace, {recursive: true});
  return {dir, workspace};
};
const cleanup = dir => fs.rmSync(dir, {recursive: true, force: true});
const outsideWorkspace = error => /outside workspace|workspace.*outside|workspace.*escape/i.test(error?.message || String(error));

test('absolute acceptance executable paths cannot point inside the workspace', () => {
  const {dir, workspace} = fixture('acceptance-absolute-');
  const executable = path.join(workspace, 'validator.exe');
  fs.writeFileSync(executable, 'fixture', 'utf8');
  try {
    assert.throws(() => resolveAcceptanceCommand(executable, workspace), outsideWorkspace);
  } finally {
    cleanup(dir);
  }
});

test('relative acceptance executable paths cannot point inside the workspace', () => {
  const {dir, workspace} = fixture('acceptance-relative-');
  const tools = path.join(workspace, 'tools');
  const executable = path.join(tools, 'validator.exe');
  fs.mkdirSync(tools);
  fs.writeFileSync(executable, 'fixture', 'utf8');
  try {
    assert.throws(() => resolveAcceptanceCommand(path.relative(workspace, executable), workspace), outsideWorkspace);
  } finally {
    cleanup(dir);
  }
});

test('workspace junctions to external binaries cannot become acceptance executables', {skip: process.platform !== 'win32'}, () => {
  const {dir, workspace} = fixture('acceptance-junction-');
  const external = path.join(dir, 'external-bin');
  const linked = path.join(workspace, 'linked-bin');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'validator.exe'), 'fixture', 'utf8');
  fs.symlinkSync(external, linked, 'junction');
  try {
    assert.throws(() => resolveAcceptanceCommand(path.join('linked-bin', 'validator.exe'), workspace), outsideWorkspace);
  } finally {
    cleanup(dir);
  }
});

test('trusted external acceptance executables remain usable', () => {
  const {dir, workspace} = fixture('acceptance-external-');
  const external = path.join(dir, 'external-bin', 'validator.exe');
  fs.mkdirSync(path.dirname(external), {recursive: true});
  fs.writeFileSync(external, 'fixture', 'utf8');
  try {
    assert.equal(path.normalize(resolveAcceptanceCommand(external, workspace)), path.normalize(external));
  } finally {
    cleanup(dir);
  }
});

test('PATH resolution skips a workspace-shadowed executable and keeps the external node', {skip: process.platform !== 'win32'}, () => {
  const {dir, workspace} = fixture('acceptance-path-');
  const shadow = path.join(workspace, 'node.exe');
  fs.writeFileSync(shadow, 'workspace shadow', 'utf8');
  const nodeDir = path.dirname(process.execPath);
  const expected = path.join(nodeDir, 'node.exe');
  assert.ok(fs.existsSync(expected), expected);
  try {
    const resolved = resolveAcceptanceCommand('node', workspace, {
      PATH: [workspace, nodeDir].join(path.delimiter),
      PATHEXT: '.EXE',
    });
    const canonical = value => path.normalize(value).toLowerCase();
    assert.equal(canonical(resolved), canonical(expected));
    assert.notEqual(canonical(resolved), canonical(shadow));
  } finally {
    cleanup(dir);
  }
});

test('acceptance file checks cannot escape the workspace', () => {
  const parent = fs.mkdtempSync(path.join(evidenceRoot, 'acceptance-file-'));
  const workspace = path.join(parent, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(parent, 'outside.txt'), 'outside', 'utf8');
  try {
    const result = verifyChecks([{type: 'file', path: '../outside.txt'}], workspace);
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /escape.*workspace|workspace.*escape/i);
  } finally {
    fs.rmSync(parent, {recursive: true, force: true});
  }
});

test('acceptance JSON checks cannot escape the workspace', () => {
  const parent = fs.mkdtempSync(path.join(evidenceRoot, 'acceptance-json-'));
  const workspace = path.join(parent, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(parent, 'outside.json'), JSON.stringify({ok: true}), 'utf8');
  try {
    const result = verifyChecks([{type: 'json', path: '../outside.json', equals: {ok: true}}], workspace);
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /escape.*workspace|workspace.*escape/i);
  } finally {
    fs.rmSync(parent, {recursive: true, force: true});
  }
});

test('absent checks reject dangling links instead of treating them as absent', () => {
  const parent = fs.mkdtempSync(path.join(evidenceRoot, 'acceptance-dangling-'));
  const workspace = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  const link = path.join(workspace, 'gone');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, link, 'junction');
  fs.rmSync(outside, {recursive: true, force: true});
  try {
    const result = verifyChecks([{type: 'absent', path: 'gone'}], workspace);
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /unexpected path|link|symlink|junction/i);
  } finally {
    fs.rmSync(parent, {recursive: true, force: true});
  }
});

test('acceptance checks follow a junction workspace root without rejecting its own files', {skip: process.platform !== 'win32'}, () => {
  const parent = fs.mkdtempSync(path.join(evidenceRoot, 'acceptance-workspace-link-'));
  const realWorkspace = path.join(parent, 'real-workspace');
  const linkedWorkspace = path.join(parent, 'linked-workspace');
  fs.mkdirSync(realWorkspace);
  fs.writeFileSync(path.join(realWorkspace, 'result.txt'), 'ok', 'utf8');
  fs.symlinkSync(realWorkspace, linkedWorkspace, 'junction');
  try {
    const result = verifyChecks([{type: 'file', path: 'result.txt'}], linkedWorkspace);
    assert.equal(result.status, 'verified', result.reason);
  } finally {
    fs.rmSync(parent, {recursive: true, force: true});
  }
});

test('command checks do not execute a workspace-shadowed bare binary', {skip: process.platform !== 'win32'}, () => {
  const parent = fs.mkdtempSync(path.join(evidenceRoot, 'acceptance-command-'));
  const workspace = path.join(parent, 'workspace');
  fs.mkdirSync(workspace);
  const comspec = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  try {
    const baseline = spawnSync('node', ['/d', '/c', 'exit', '0'], {cwd: workspace, encoding: 'utf8', windowsHide: true});
    assert.notEqual(baseline.status, 0, 'the baseline node invocation must fail for the cmd-only argument shape');
    fs.copyFileSync(comspec, path.join(workspace, 'node.exe'));
    const result = verifyChecks([{type: 'command', command: 'node', args: ['/d', '/c', 'exit', '0'], exitCode: 0}], workspace);
    assert.equal(result.status, 'failed', 'a workspace binary must not forge a verified acceptance command');
    assert.match(result.reason, /command|executable|workspace|path/i);
  } finally {
    fs.rmSync(parent, {recursive: true, force: true});
  }
});
