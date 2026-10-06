import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveHost,launchArgs} from '../scripts/core/host-cli.mjs';

const cleanPiEnv = {...process.env};
for (const key of ['ORCH_UNIT_CMD','ORCH_UNIT_CMD_FILE','ORCH_CLI','PI_EXE']) delete cleanPiEnv[key];
const piEnv = (extra = {}) => ({...cleanPiEnv, ORCH_AGENT:'pi', FORCE_COLOR:'1', ...extra});
let piAvailable = false;
try {
 piAvailable = Boolean(resolveHost({env:piEnv()}));
} catch (error) {
 if (!(error?.code === 'CLI_MISSING' || /CLI_MISSING/.test(String(error?.message)))) throw error;
}
const piOnly = {skip:piAvailable ? false : 'pi CLI is not installed'};
test('installed pi resolves its own CLI and never receives Codex flags',piOnly,()=>{
 const host=resolveHost({env:piEnv()});
 assert.equal(host.agent,'pi');assert.ok(host.config.prefixArgs.at(-1).endsWith('cli.js'));
 assert.match(host.config.version,/^\d+\.\d+\.\d+$/);
 const args=launchArgs(host.config,{cwd:process.cwd()});
 assert.ok(args.includes('--approve'));assert.ok(args.includes('--offline'));
 assert.ok(!args.includes('--sandbox'));assert.ok(!args.includes('--cd'));
});
test('an explicit missing pi CLI never falls back to PATH or Codex',()=>{
 assert.throws(()=>resolveHost({env:piEnv({ORCH_CLI:'D:/temp/no-such-pi-orchestrator-test.exe'})}),/CLI_MISSING/);
 assert.throws(()=>launchArgs({id:'pi'},{sandbox:'read-only'}),/PI_SANDBOX_UNSUPPORTED/);
});
