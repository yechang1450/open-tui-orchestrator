import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveHost,launchArgs} from '../scripts/core/host-cli.mjs';
test('claude resolves its own CLI when installed and fails closed when absent',()=>{
 let host=null,error=null;
 try{host=resolveHost({env:{...process.env,ORCH_AGENT:'claude'}});}catch(e){error=e;}
 if(!host){assert.match(String(error?.message||error),/CLI_MISSING/);return;}
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
test('claude admission rejects a CLI whose help lacks the effort flag used by launchArgs',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'otui-claude-help-'));
 const fake=path.join(dir,'claude.mjs');
 fs.writeFileSync(fake,`const a=process.argv.slice(2);if(a.includes('--help')){console.log('--print --dangerously-skip-permissions --model');process.exit(0);}if(a.includes('--version')){console.log('1.2.3');process.exit(0);}`, 'utf8');
 try{
  assert.throws(()=>resolveHost({env:{...process.env,ORCH_AGENT:'claude',ORCH_CLI:fake}}),/CLI_MISSING.*--effort/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
