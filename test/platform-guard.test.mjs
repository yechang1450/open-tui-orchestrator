import {test} from 'node:test';
import assert from 'node:assert/strict';
import {enforceWindowsOnly} from '../scripts/platform-guard.mjs';

test('platform guard refuses real commands even when a neutral flag is also present',()=>{
 assert.equal(enforceWindowsOnly(['--run-windows','req','--help'],'linux'),true,'a neutral flag must not whitelist a real command');
 assert.equal(enforceWindowsOnly(['--run-windows','req'],'linux'),true);
 assert.equal(enforceWindowsOnly(['--plan','req','-h'],'linux'),true);
});

test('platform guard keeps only genuinely neutral invocations reachable on non-Windows',()=>{
 assert.equal(enforceWindowsOnly(['--help'],'linux'),false);
 assert.equal(enforceWindowsOnly(['-h'],'linux'),false);
 assert.equal(enforceWindowsOnly(['--version'],'linux'),false);
 assert.equal(enforceWindowsOnly(['--install-deps'],'linux'),false);
 assert.equal(enforceWindowsOnly(['--help','--version'],'linux'),false);
 assert.equal(enforceWindowsOnly([],'linux'),true,'a bare invocation is not a neutral help surface');
 assert.equal(enforceWindowsOnly(['--help'],'win32'),false);
 assert.equal(enforceWindowsOnly(['--run-windows','req'],'win32'),false);
});
