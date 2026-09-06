import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHostAgent, resolveHost, launchArgs } from '../scripts/host-cli.mjs';
test('unknown and explicitly unsupported hosts never become codex', () => {
  assert.throws(() => detectHostAgent({}), /HOST_UNKNOWN/);
  assert.equal(detectHostAgent({ ORCH_AGENT: 'unknown', CODEX_THREAD_ID: 'x' }), 'unknown');
  assert.throws(() => resolveHost({env:{ ORCH_AGENT: 'unknown' }}), /ADAPTER_UNSUPPORTED/);
});
test('missing CLI cannot start or install anything', () => {
  assert.throws(() => resolveHost({env:{ ORCH_AGENT:'codex' }, candidates:()=>[], probe:()=>false}), /CLI_MISSING/);
});
test('host identity and resolved executable are preserved', () => {
  assert.equal(detectHostAgent({ CODEX_THREAD_ID:'x' }), 'codex');
  const host = resolveHost({env:{ORCH_AGENT:'codex'}, candidates:()=>['missing','native cli'], probe:p=>p==='native cli'});
  assert.equal(host.config.bin,'native cli');
  assert.deepEqual(launchArgs(host.config,{cwd:'a b',sandbox:'read-only',approval:'never'}), ['--cd','a b','-a','never','--sandbox','read-only']);
  assert.throws(()=>launchArgs({id:'unknown'}),/ADAPTER_UNSUPPORTED/);
});
