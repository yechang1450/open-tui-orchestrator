import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const family = path.join(root, 'temp');
const PKG_FILES = ['cli.mjs', 'orch.mjs', 'repair.mjs', 'package.json', 'release.json', 'README.md'];

function minimalPackage() {
  fs.mkdirSync(family, {recursive: true});
  const pkg = fs.mkdtempSync(path.join(family, 'shim-dep-'));
  for (const rel of PKG_FILES) fs.copyFileSync(path.join(root, rel), path.join(pkg, rel));
  fs.cpSync(path.join(root, 'scripts'), path.join(pkg, 'scripts'), {recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`)});
  return pkg;
}

test('a missing engine dependency at the shim entry collapses to one FATAL line, never a raw stack', () => {
  const pkg = minimalPackage();
  try {
    // 夹具改动（仅副本）：禁用预检与封印校验，模拟“预检未命中”的真实路径（审计 E2b 的构造）。
    const shimFile = path.join(pkg, 'scripts', 'orchestrate-sdk.mjs');
    let src = fs.readFileSync(shimFile, 'utf8');
    src = src.replace("if (requestedAgent === 'codex' || (!requestedAgent && (process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID))) await import('./sdk-dependency-check.mjs');", '/* precheck disabled by test fixture */');
    src = src.replace('    verifyRelease();', '    /* release check disabled by test fixture */');
    fs.writeFileSync(shimFile, src);
    const env = {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      PATH: process.env.PATH,
      ProgramFiles: process.env.ProgramFiles,
      ProgramW6432: process.env.ProgramW6432,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      ORCH_AGENT: 'codex',
      ORCH_MAINTENANCE_LOCK: path.join(family, 'no-lock.json'),
    };
    const r = spawnSync(process.execPath, [shimFile, '--status'], {cwd: pkg, env, encoding: 'utf8', windowsHide: true, timeout: 60000});
    const out = (r.stdout || '') + (r.stderr || '');
    assert.notEqual(r.status, 0, 'a missing engine dependency must fail: ' + out);
    assert.match(out, /\[orchestrator\] FATAL: /, out);
    assert.match(out, /Cannot find (package|module)|ERR_MODULE_NOT_FOUND|RELEASE_DEPENDENCY_MISSING/, 'the fixture must reach the dependency path: ' + out);
    assert.doesNotMatch(out, /RELEASE_INTEGRITY_FAILED/, 'the fixture must reach the dependency path, not the seal path: ' + out);
    assert.doesNotMatch(out, /^\s+at /m, 'no Node stack frames: ' + out);
    assert.doesNotMatch(out, /node:internal/, 'no raw internals: ' + out);
  } finally { fs.rmSync(pkg, {recursive: true, force: true}); }
});
