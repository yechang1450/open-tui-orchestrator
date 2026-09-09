import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveHost,launchArgs} from '../scripts/core/host-cli.mjs';
import {opencodePlannerArgs} from '../scripts/core/opencode-host.mjs';
test('installed opencode resolves its own CLI and never receives Codex flags',()=>{
 const host=resolveHost({env:{...process.env,ORCH_AGENT:'opencode'}});
 assert.equal(host.agent,'opencode');
 assert.match(host.config.version,/^\d+\.\d+\.\d+$/);
 const args=launchArgs(host.config,{cwd:process.cwd()});
 assert.deepEqual(args.slice(0,3),['run','-i','--auto']);
 const dirAt=args.indexOf('--dir');assert.ok(dirAt>0);assert.equal(args[dirAt+1],process.cwd());
 assert.ok(!args.includes('--sandbox'));assert.ok(!args.includes('--cd'));
 const plan=opencodePlannerArgs(host.config,{cwd:process.cwd()});
 assert.deepEqual(plan.slice(0,3),['run','--format','json']);
 assert.ok(plan.includes('--dir'));
});
test('an explicit missing opencode CLI never falls back to PATH or Codex',()=>{
 assert.throws(()=>resolveHost({env:{...process.env,ORCH_AGENT:'opencode',ORCH_CLI:'D:/temp/no-such-opencode-orchestrator-test.exe'}}),/CLI_MISSING/);
 assert.throws(()=>launchArgs({id:'opencode'},{sandbox:'read-only'}),/OPENCODE_SANDBOX_UNSUPPORTED/);
});
