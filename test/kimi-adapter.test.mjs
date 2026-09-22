import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveHost,launchArgs} from '../scripts/core/host-cli.mjs';
test('installed kimi resolves its own CLI and never receives Codex flags',()=>{
 const host=resolveHost({env:{...process.env,ORCH_AGENT:'kimi'}});
 assert.equal(host.agent,'kimi');assert.match(host.config.bin,/kimi\.exe$/i);
 assert.match(host.config.version,/^\d+\.\d+\.\d+$/);
 const args=launchArgs(host.config,{cwd:process.cwd()});
 assert.deepEqual(args,['-p']);
 assert.ok(!args.includes('--sandbox'));assert.ok(!args.includes('--cd'));
});
test('an explicit missing kimi CLI never falls back to PATH or Codex',()=>{
 assert.throws(()=>resolveHost({env:{...process.env,ORCH_AGENT:'kimi',ORCH_CLI:'D:/temp/no-such-kimi-orchestrator-test.exe'}}),/CLI_MISSING/);
 assert.throws(()=>launchArgs({id:'kimi'},{sandbox:'read-only'}),/KIMI_SANDBOX_UNSUPPORTED/);
});
test('kimi model argv precedes -p so the parser never eats the model as a subcommand',()=>{
 const pm=process.env.ORCH_MODEL;process.env.ORCH_MODEL='kimi-k3';
 try{
  const args=launchArgs({id:'kimi',prefixArgs:[]},{cwd:process.cwd()});
  assert.deepEqual(args,['-m','kimi-k3','-p']);
 }finally{if(pm===undefined)delete process.env.ORCH_MODEL;else process.env.ORCH_MODEL=pm;}
});
