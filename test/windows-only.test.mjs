import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL, fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const family = path.join(root, 'temp');
const cliEntry = path.join(root, 'cli.mjs');

// The front page promises "Windows-only: other platforms get a diagnostic instead of a
// half-working install". That promise is only as good as its criterion, so it is enforced at
// the entry and tested here by pretending the platform is Linux via a `--import` preload
// (deterministic, offline). Red-capable in both directions:
//   * remove the guard -> --doctor runs and exits 0 on "Linux" -> case 1 fails;
//   * widen the guard to every entry -> --version / --install-deps refuse -> case 2 fails.
function linuxPreload() {
  fs.mkdirSync(family, {recursive: true});
  const file = path.join(family, 'zzz-platform-linux.mjs');
  fs.writeFileSync(file, "Object.defineProperty(process, 'platform', {value: 'linux'});\n");
  return pathToFileURL(file).href;
}
const runAsLinux = (args) => spawnSync(process.execPath, ['--import', linuxPreload(), cliEntry, ...args],
  {cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000, env: {...process.env, ORCH_MAINTENANCE_LOCK: path.join(family, 'no-lock.json')}});

test('a non-Windows platform is refused at the entry with one diagnostic line', () => {
  const r = runAsLinux(['--agent', 'codex', '--doctor']);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.notEqual(r.status, 0, 'the entry must refuse on a non-Windows platform: ' + out);
  assert.match(out, /\[orchestrator\] FATAL: Windows-only/, out);
  assert.doesNotMatch(out, /^\s+at /m, 'no Node stack frames: ' + out);
  assert.doesNotMatch(out, /"hostError"/, 'a refusal must not look like a healthy doctor report: ' + out);
});

test('the platform-neutral entries still work on a non-Windows platform', () => {
  const version = runAsLinux(['--version']);
  assert.equal(version.status, 0, version.stderr || version.stdout);
  assert.match(version.stdout, /open-tui-orchestrator \d+\.\d+\.\d+ \(core \d+\.\d+\.\d+\)/, version.stdout);
  const deps = runAsLinux(['--install-deps']);
  assert.equal(deps.status, 0, deps.stderr || deps.stdout);
  assert.match(deps.stdout, /"action":"already-present"/, 'the bootstrap is platform-neutral: ' + deps.stdout);
});
