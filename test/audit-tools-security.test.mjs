import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leakScript = path.join(root, 'tools', 'orch-leak-scan.py');
const patrolScript = path.join(root, 'tools', 'orch-patrol.py');
const junctionScript = path.join(root, 'tools', 'flip-orch-junction.ps1');
const evidenceRoot = path.join(root, 'temp', 'review-audit-tools-20261004');
const fixtureEmail = ['audit-test', 'example.invalid'].join('@');

function trustedPwshExe() {
  if (process.platform !== 'win32') return '';
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:/Windows';
  const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || 'C:/Program Files';
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    localAppData && path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
  ].filter(Boolean);
  const whereExe = path.win32.join(systemRoot, 'System32', 'where.exe');
  const where = spawnSync(whereExe, ['pwsh.exe'], {encoding: 'utf8', windowsHide: true, timeout: 5000});
  const trustedRoots = candidates.map((candidate) => path.win32.dirname(candidate).toLowerCase());
  for (const raw of String(where.stdout || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const candidate = path.win32.normalize(raw);
    if (trustedRoots.some((rootPath) => candidate.toLowerCase() === path.win32.join(rootPath, 'pwsh.exe').toLowerCase())) {
      return candidate;
    }
  }
  const resolved = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  assert.ok(resolved, 'PowerShell 7 executable not found in trusted absolute locations');
  return resolved;
}

const PS_EXE = trustedPwshExe();

function fixture() {
  fs.mkdirSync(evidenceRoot, {recursive: true});
  return fs.mkdtempSync(path.join(evidenceRoot, 'fixture-'));
}

function resultText(result) {
  return String(result.stdout || '') + String(result.stderr || '');
}

function runPython(args, options = {}) {
  return spawnSync('python', [args[0], ...args.slice(1)], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    ...options,
  });
}

function runPatrol(args, options = {}) {
  return runPython([patrolScript, ...args], options);
}

function runGit(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
}

function makeGitRepo(dir, {commit = true} = {}) {
  fs.mkdirSync(dir, {recursive: true});
  let r = runGit(dir, ['init', '-q']);
  assert.equal(r.status, 0, resultText(r));
  if (commit) {
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'tracked\n', 'utf8');
    r = runGit(dir, ['add', '-A']);
    assert.equal(r.status, 0, resultText(r));
    r = spawnSync('git', ['-C', dir, '-c', 'user.name=audit-test', '-c', 'user.email=' + fixtureEmail, 'commit', '-qm', 'fixture'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    });
    assert.equal(r.status, 0, resultText(r));
  }
}

function writePsFixture(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body.replaceAll('\n', '\r\n'), 'utf8');
  return file;
}

function runPwsh(file, args = [], options = {}) {
  return spawnSync(PS_EXE, ['-NoProfile', '-File', file, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    ...options,
  });
}

function makeJunction(dir, link, target) {
  const ps = writePsFixture(dir, 'make-junction.ps1', [
    'param([string]$Link,[string]$Target)',
    "$ErrorActionPreference = 'Stop'",
    'New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null',
  ].join('\n'));
  const r = runPwsh(ps, [link, target]);
  assert.equal(r.status, 0, resultText(r));
}

function junctionTarget(dir, link) {
  const ps = writePsFixture(dir, 'read-junction.ps1', [
    'param([string]$Link)',
    "$ErrorActionPreference = 'Stop'",
    "[string](Get-Item -LiteralPath $Link -Force).Target",
  ].join('\n'));
  const r = runPwsh(ps, [link]);
  assert.equal(r.status, 0, resultText(r));
  return String(r.stdout).trim();
}

function flip(home, version, options = {}) {
  return spawnSync(PS_EXE, ['-NoProfile', '-File', junctionScript, '-Version', version], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: {...process.env, USERPROFILE: home, HOME: home, ...options.env},
  });
}

function setupJunctionFixture(dir, version = '2026.10.4') {
  const tools = path.join(dir, '.tools');
  const nodeModules = path.join(tools, 'node24-fresh', 'node_modules');
  const releases = path.join(tools, 'releases');
  const oldTarget = path.join(tools, 'previous', 'open-tui-orchestrator');
  const target = path.join(releases, version, 'open-tui-orchestrator');
  fs.mkdirSync(nodeModules, {recursive: true});
  fs.mkdirSync(oldTarget, {recursive: true});
  fs.mkdirSync(target, {recursive: true});
  const link = path.join(nodeModules, 'open-tui-orchestrator');
  makeJunction(dir, link, oldTarget);
  return {tools, nodeModules, releases, oldTarget, target, link, version};
}

function assertClean(dir) {
  fs.rmSync(dir, {recursive: true, force: true});
}

test('leak scanner refuses default history scan when the target has no git metadata', () => {
  const dir = fixture();
  try {
    fs.writeFileSync(path.join(dir, 'plain.txt'), 'no secrets here\n', 'utf8');
    const r = runPython([leakScript, dir]);
    assert.notEqual(r.status, 0, resultText(r));
    assert.match(resultText(r), /not-scanned|未扫描|\.git/i);
  } finally {
    assertClean(dir);
  }
});

test('leak scanner applies --allow to the matching identity without hiding a credential on the same line', () => {
  const dir = fixture();
  const identity = 'public-handle';
  const fakeKey = 'sk-' + 'a'.repeat(24);
  try {
    const file = path.join(dir, 'fixture.txt');
    fs.writeFileSync(file, identity + '\n', 'utf8');
    let r = runPython([leakScript, dir, '--no-history', '--identity', identity, '--allow', identity]);
    assert.equal(r.status, 0, resultText(r));

    fs.writeFileSync(file, identity + ' ' + fakeKey + '\n', 'utf8');
    r = runPython([leakScript, dir, '--no-history', '--identity', identity, '--allow', identity]);
    assert.notEqual(r.status, 0, resultText(r));
    assert.match(resultText(r), /凭据形态/);
    assert.doesNotMatch(resultText(r), new RegExp(fakeKey));
  } finally {
    assertClean(dir);
  }
});

test('leak scanner reports an unreadable file instead of silently treating it as scanned', (t) => {
  const dir = fixture();
  const bad = path.join(dir, 'broken-link.txt');
  try {
    try {
      fs.symlinkSync('missing-target.txt', bad, 'file');
    } catch (error) {
      const probe = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('leak', r'''${leakScript.replaceAll('\\', '\\\\')}''')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
def fake_walk(root, onerror=None):
    if onerror:
        onerror(OSError(13, 'permission denied', 'blocked-entry'))
    return iter(())
mod.os.walk = fake_walk
sys.exit(mod.main([r'''${dir.replaceAll('\\', '\\\\')}''', '--no-history']))
`;
      const r = spawnSync('python', ['-c', probe], {cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000});
      assert.notEqual(r.status, 0, resultText(r));
      assert.match(resultText(r), /扫描证据错误|scan error|不可读/i);
      return;
    }
    const r = runPython([leakScript, dir, '--no-history']);
    assert.notEqual(r.status, 0, resultText(r));
    assert.match(resultText(r), /unreadable|scan error|不可读|扫描错误/i);
  } finally {
    assertClean(dir);
  }
});

test('patrol marks a git failure as UNKNOWN instead of treating empty HEAD and dirty zero as green', () => {
  const dir = fixture();
  const state = path.join(dir, 'state');
  try {
    const r = runPatrol(['--repo', path.join(dir, 'not-a-repo'), '--state-dir', state, '--no-gate']);
    assert.notEqual(r.status, 0, resultText(r));
    const saved = JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8'));
    assert.equal(saved.verdict, 'UNKNOWN');
    assert.match(resultText(r), /UNKNOWN|repo/i);
  } finally {
    assertClean(dir);
  }
});

test('patrol preserves a corrupt state file and fails closed', () => {
  const dir = fixture();
  const repo = path.join(dir, 'repo');
  const state = path.join(dir, 'state');
  makeGitRepo(repo);
  fs.mkdirSync(state, {recursive: true});
  const original = '{"last_judged":';
  fs.writeFileSync(path.join(state, 'state.json'), original, 'utf8');
  try {
    const r = runPatrol(['--repo', repo, '--state-dir', state, '--no-gate']);
    assert.notEqual(r.status, 0, resultText(r));
    assert.equal(fs.readFileSync(path.join(state, 'state.json'), 'utf8'), original);
    assert.match(resultText(r), /state|JSON|未知|不可读/i);
  } finally {
    assertClean(dir);
  }
});

test('patrol records no-gate and dirty observations as SKIPPED, not as an OK verdict', () => {
  const dir = fixture();
  const repo = path.join(dir, 'repo');
  const state = path.join(dir, 'state');
  makeGitRepo(repo);
  try {
    let r = runPatrol(['--repo', repo, '--state-dir', state, '--no-gate']);
    assert.equal(r.status, 0, resultText(r));
    let saved = JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8'));
    assert.equal(saved.verdict, 'SKIPPED');
    assert.equal(saved.gate.skipped, 'no-gate(flag)');

    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n', 'utf8');
    r = runPatrol(['--repo', repo, '--state-dir', path.join(dir, 'dirty-state'), '--no-gate']);
    assert.equal(r.status, 0, resultText(r));
    saved = JSON.parse(fs.readFileSync(path.join(dir, 'dirty-state', 'state.json'), 'utf8'));
    assert.equal(saved.verdict, 'SKIPPED');
    assert.equal(saved.gate.skipped, 'dirty-tree');
  } finally {
    assertClean(dir);
  }
});

test('patrol defers when the judge probe is unknown and never falls back to a bare pwsh command', () => {
  const probe = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('patrol', r'''${patrolScript.replaceAll('\\', '\\\\')}''')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.powershell_exe = lambda: r'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
calls = []
class Result:
    returncode = 17
    stdout = b''
    stderr = b'probe failed'
def fake_run(argv, **kwargs):
    calls.append(argv)
    return Result()
mod.subprocess.run = fake_run
value = mod.other_judge_running()
print(json.dumps({'value': value, 'argv': calls[0] if calls else []}))
`;
  const r = spawnSync('python', ['-c', probe], {cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000});
  assert.equal(r.status, 0, resultText(r));
  const observed = JSON.parse(String(r.stdout).trim());
  assert.equal(observed.value, null);
  assert.notEqual(observed.argv[0], 'pwsh');
  assert.notEqual(observed.argv[0], 'powershell');
  assert.match(observed.argv[0], /pwsh\.exe$/i);
});

test('junction switch rejects a releases junction escape and preserves the original link', {skip: process.platform !== 'win32'}, () => {
  const dir = fixture();
  try {
    const setup = setupJunctionFixture(dir);
    const outside = path.join(dir, 'outside-releases');
    const outsideTarget = path.join(outside, setup.version, 'open-tui-orchestrator');
    fs.mkdirSync(outsideTarget, {recursive: true});
    fs.rmSync(setup.releases, {recursive: true, force: true});
    makeJunction(dir, setup.releases, outside);

    const r = flip(dir, setup.version);
    assert.notEqual(r.status, 0, resultText(r));
    assert.equal(path.normalize(junctionTarget(dir, setup.link)), path.normalize(setup.oldTarget));
  } finally {
    assertClean(dir);
  }
});

test('junction switch rejects a version-directory junction escape and preserves the original link', {skip: process.platform !== 'win32'}, () => {
  const dir = fixture();
  try {
    const setup = setupJunctionFixture(dir);
    const versionDir = path.join(setup.releases, setup.version);
    const outsideVersion = path.join(dir, 'outside-version', setup.version);
    fs.rmSync(versionDir, {recursive: true, force: true});
    fs.mkdirSync(outsideVersion, {recursive: true});
    fs.mkdirSync(path.join(outsideVersion, 'open-tui-orchestrator'), {recursive: true});
    makeJunction(dir, versionDir, outsideVersion);

    const r = flip(dir, setup.version);
    assert.notEqual(r.status, 0, resultText(r));
    assert.equal(path.normalize(junctionTarget(dir, setup.link)), path.normalize(setup.oldTarget));
  } finally {
    assertClean(dir);
  }
});

test('junction switch reports rollback failure instead of swallowing it', {skip: process.platform !== 'win32'}, () => {
  const dir = fixture();
  try {
    const setup = setupJunctionFixture(dir);
    const wrapper = writePsFixture(dir, 'inject-junction-failure.ps1', [
      'param([string]$Tool,[string]$Version,[ValidateSet("primary","rollback")] [string]$Mode)',
      '$script:attempt = 0',
      'function New-Item {',
      '  param([string]$ItemType,[string]$Path,[string]$Target,[switch]$Force)',
      '  $script:attempt++',
      '  if ($script:attempt -eq 1) { throw "injected primary create failure" }',
      '  if ($Mode -eq "rollback") { throw "injected rollback failure" }',
      '  Microsoft.PowerShell.Management\\New-Item -ItemType $ItemType -Path $Path -Target $Target -Force:$Force | Out-Null',
      '}',
      '& $Tool -Version $Version',
    ].join('\n'));
    const r = runPwsh(wrapper, [junctionScript, setup.version, 'rollback'], {
      env: {...process.env, USERPROFILE: dir, HOME: dir},
    });
    assert.notEqual(r.status, 0, resultText(r));
    assert.match(resultText(r), /rollback|injected rollback failure/i);
  } finally {
    assertClean(dir);
  }
});
