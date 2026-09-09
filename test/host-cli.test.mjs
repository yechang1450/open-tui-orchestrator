import { test } from 'node:test';
import { networkArgs } from '../scripts/network-policy.mjs';
import assert from 'node:assert/strict';
import { detectHostAgent, detectHostFromChain, resolveHost, launchArgs } from '../scripts/host-cli.mjs';
test('unknown and explicitly unsupported hosts never become codex', () => {
  assert.throws(() => detectHostAgent({}, { chain: [] }), /HOST_UNKNOWN/);
  assert.equal(detectHostAgent({ ORCH_AGENT: 'unknown', CODEX_THREAD_ID: 'x' }), 'unknown');
  assert.throws(() => resolveHost({env:{ ORCH_AGENT: 'unknown' }}), /ADAPTER_UNSUPPORTED/);
});
test('initiating agent is detected from the nearest matching ancestor process', () => {
  const bash = { pid: 2, name: 'bash.exe', cmdline: 'bash -c node cli.mjs' };
  const terminal = { pid: 9, name: 'WindowsTerminal.exe', cmdline: '' };
  assert.equal(detectHostFromChain([bash, { pid: 3, name: 'kimi.exe', cmdline: 'C:\\Users\\u\\.kimi-code\\bin\\kimi.exe' }, terminal]), 'kimi');
  assert.equal(detectHostFromChain([{ pid: 3, name: 'node.exe', cmdline: 'node C:\\tools\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js' }, bash]), 'pi');
  assert.equal(detectHostFromChain([{ pid: 3, name: 'codex.exe', cmdline: 'codex.exe' }]), 'codex');
  assert.equal(detectHostFromChain([{ pid: 3, name: 'node.exe', cmdline: 'node C:\\tools\\node_modules\\@openai\\codex\\bin\\codex.js' }]), 'codex');
  assert.equal(detectHostFromChain([{ pid: 3, name: 'opencode.exe', cmdline: '' }]), 'opencode');
  assert.equal(detectHostFromChain([{ pid: 3, name: 'node.exe', cmdline: 'node C:\\tools\\node_modules\\openclaw\\openclaw.mjs tui' }]), 'openclaw');
  // A nested orchestration window binds to its own agent, not the outer initiator.
  assert.equal(detectHostFromChain([
    { pid: 3, name: 'node.exe', cmdline: 'node C:\\tools\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js' },
    { pid: 4, name: 'kimi.exe', cmdline: 'kimi.exe' },
  ]), 'pi');
  assert.equal(detectHostFromChain([bash, terminal]), null);
  assert.equal(detectHostAgent({ ORCH_AGENT: 'pi' }, { chain: [{ name: 'kimi.exe' }] }), 'pi');
  assert.equal(detectHostAgent({ CODEX_SESSION_ID: 's' }, { chain: [{ name: 'kimi.exe' }] }), 'codex');
  assert.equal(detectHostAgent({}, { chain: [{ name: 'kimi.exe', cmdline: '' }] }), 'kimi');
});
test('missing CLI cannot start or install anything', () => {
  assert.throws(() => resolveHost({env:{ ORCH_AGENT:'codex' }, candidates:()=>[], probe:()=>false}), /CLI_MISSING/);
});
test('host identity and resolved executable are preserved', () => {
  assert.equal(detectHostAgent({ CODEX_THREAD_ID:'x' }), 'codex');
  const host = resolveHost({env:{ORCH_AGENT:'codex'}, candidates:()=>['missing','native cli'], probe:p=>p==='native cli'});
  assert.equal(host.config.bin,'native cli');
  assert.deepEqual(launchArgs(host.config,{cwd:'a b',sandbox:'read-only',approval:'never'}), ['--cd','a b','-a','never','--sandbox','read-only','-c','projects."a b".trust_level="trusted"',...networkArgs()]);
  const authorized = launchArgs(host.config,{cwd:'a b',sandbox:'danger-full-access',approval:'never'});
  assert.ok(authorized.includes('--dangerously-bypass-approvals-and-sandbox'));
  // Codex rejects the approval flag together with the dangerous bypass flag;
  // the bypass itself is the no-prompt authorization envelope for this mode.
  assert.equal(authorized.includes('-a'), false);
  assert.equal(authorized.includes('never'), false);
  assert.throws(()=>launchArgs({id:'unknown'}),/ADAPTER_UNSUPPORTED/);
});
