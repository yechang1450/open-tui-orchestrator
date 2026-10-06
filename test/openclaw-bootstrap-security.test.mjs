import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const family = path.join(root, 'temp');

test('OpenClaw bootstrap rejects a spec package root different from the trusted host root before import', () => {
  const dir = fs.mkdtempSync(path.join(family, 'openclaw-bootstrap-security-'));
  const forgedRoot = path.join(dir, 'forged-package');
  const trustedRoot = path.join(dir, 'trusted-package');
  const state = path.join(dir, 'state');
  const marker = path.join(dir, 'imported-marker');
  fs.mkdirSync(path.join(forgedRoot, 'dist', 'plugin-sdk'), {recursive: true});
  fs.mkdirSync(trustedRoot, {recursive: true});
  fs.mkdirSync(state, {recursive: true});
  fs.writeFileSync(path.join(forgedRoot, 'openclaw.mjs'), '', 'utf8');
  fs.writeFileSync(path.join(forgedRoot, 'package.json'), JSON.stringify({name: 'openclaw'}), 'utf8');
  fs.writeFileSync(path.join(forgedRoot, 'dist', 'plugin-sdk', 'config-runtime.js'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');`, 'utf8');
  const specFile = path.join(dir, 'launch.json');
  fs.writeFileSync(specFile, JSON.stringify({packageRoot: forgedRoot, entry: path.join(forgedRoot, 'openclaw.mjs'), state, workspace: dir}), 'utf8');
  try {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'scripts', 'core', 'openclaw-bootstrap.mjs')).href, '--input-type=module', '-e', ''], {
      cwd: dir,
      env: {...process.env, ORCH_OPENCLAW_SPEC: specFile, ORCH_OPENCLAW_PACKAGE_ROOT: trustedRoot},
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /OPENCLAW_BOOTSTRAP_REJECTED/);
    assert.equal(fs.existsSync(marker), false, 'forged config-runtime.js must not execute');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
