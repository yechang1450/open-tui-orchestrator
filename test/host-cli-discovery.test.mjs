import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {cliCandidates} from '../scripts/host-cli.mjs';

test('Windows CLI discovery consults the native where.exe result when PATH is empty', () => {
  const candidates = cliCandidates({PATH:'',Path:'',SystemRoot:'C:\\Windows'}, 'win32', {
    where: () => ({status:0, stdout:'C:\\Program Files\\Codex\\codex.exe\r\n'})
  });
  assert.ok(candidates.includes('C:\\Program Files\\Codex\\codex.exe'));
});

test('Windows CLI discovery finds the packaged codex binary under the vendor bin layout', () => {
  const dir = 'C:\\tools\\node';
  const vendor = path.join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor');
  const candidates = cliCandidates({PATH:dir,Path:'',SystemRoot:'C:\\Windows'}, 'win32', {
    where: () => ({status:1, stdout:''})
  });
  assert.ok(candidates.includes(path.join(vendor, 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')));
  assert.ok(candidates.includes(path.join(vendor, 'x86_64-pc-windows-msvc', 'codex', 'codex.exe')));
});
