import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveHost,launchArgs} from '../scripts/core/host-cli.mjs';
test('installed claude resolves its own CLI and never receives Codex flags',()=>{
 const host=resolveHost({env:{...process.env,ORCH_AGENT:'claude'}});
 assert.equal(host.agent,'claude');
 assert.match(host.config.bin,/claude\.exe$/i);
 assert.match(host.config.version,/^\d+\.\d+\.\d+$/);
 const args=launchArgs(host.config,{cwd:process.cwd()});
 assert.ok(args.includes('--dangerously-skip-permissions'));
 assert.ok(args.includes('-p'));
 assert.ok(!args.includes('--sandbox'));assert.ok(!args.includes('--cd'));assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
});
test('an explicit missing claude CLI never falls back to PATH or Codex',()=>{
 assert.throws(()=>resolveHost({env:{...process.env,ORCH_AGENT:'claude',ORCH_CLI:'D:/temp/no-such-claude-orchestrator-test.exe'}}),/CLI_MISSING/);
 assert.throws(()=>launchArgs({id:'claude'},{sandbox:'read-only'}),/CLAUDE_SANDBOX_UNSUPPORTED/);
});
test('claude model argv precedes -p so the prompt stays the last argument',()=>{
 const pm=process.env.ORCH_MODEL;process.env.ORCH_MODEL='claude-opus-4';
 try{
  const args=launchArgs({id:'claude',prefixArgs:[]},{cwd:process.cwd()});
  assert.equal(args[args.indexOf('-p')-1],'claude-opus-4');
  assert.equal(args[args.indexOf('--model')+1],'claude-opus-4');
 }finally{if(pm===undefined)delete process.env.ORCH_MODEL;else process.env.ORCH_MODEL=pm;}
});
