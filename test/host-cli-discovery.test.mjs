import test from 'node:test';
import assert from 'node:assert/strict';
import {cliCandidates} from '../scripts/host-cli.mjs';

test('Windows CLI discovery consults the native where.exe result when PATH is empty', () => {
  const candidates = cliCandidates({PATH:'',Path:'',SystemRoot:'C:\\Windows'}, 'win32', {
    where: () => ({status:0, stdout:'C:\\Program Files\\Codex\\codex.exe\r\n'})
  });
  assert.ok(candidates.includes('C:\\Program Files\\Codex\\codex.exe'));
});
