import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {powershellExe} from '../scripts/core/contracts.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const LIVE=path.join(repo,'test','live-inactive-window.ps1');
const PS_EXE=powershellExe();
// 2026-10-09: the workspace moved off the user profile (USERPROFILE\workspace is a deprecated,
// empty shell on this box). WORKSPACE_DIR is the repo's canonical workspace env (cli.mjs,
// orchestrate-sdk.mjs) — use it first, keep the old derivation as a fallback.
const workspaceRoot=process.env.WORKSPACE_DIR||(process.env.USERPROFILE?path.join(process.env.USERPROFILE,'workspace'):path.join(process.env.HOME||process.cwd(),'workspace'));
const fixtureRoot=path.join(workspaceRoot,'temp','otui-live-inactive-window-fixture-');
const liveSource=fs.readFileSync(LIVE,'utf8');
fs.mkdirSync(path.dirname(fixtureRoot),{recursive:true});

function makeFixture(prefix){
 const dir=fs.mkdtempSync(path.join(path.dirname(fixtureRoot),path.basename(fixtureRoot)+prefix));
 return {dir,fixture:path.join(dir,'fixture.json'),report:path.join(dir,'report.json')};
}

function writeHelper(dir,name,body){
 const file=path.join(dir,name);
 fs.writeFileSync(file,body.replaceAll('\n','\r\n'),'utf8');
 return file;
}

function runFixture(fixture){
 if(!/\$FixturePath/.test(liveSource)) throw new Error('live fixture mode is not implemented yet');
 return spawnSync(PS_EXE,['-NoProfile','-NonInteractive','-File',LIVE,'-FixturePath',fixture],{
  cwd:repo,encoding:'utf8',windowsHide:true,timeout:30000,
 });
}

function readReport(report){
 assert.equal(fs.existsSync(report),true,'fixture must leave report.json evidence');
 return JSON.parse(fs.readFileSync(report,'utf8'));
}

test('queued target foreground events fail closed even when callback foreground is restored',()=>{
 assert.match(liveSource,/EventEvidence/);
 assert.match(liveSource,/CallbackForegrounds/);
 assert.doesNotMatch(liveSource, /\$parts\[2\]\s+-eq\s+\('\''actual='\''/);
 const {dir,fixture,report}=makeFixture('events-');
 const helper=writeHelper(dir,'helper.ps1',`param([string]$Payload)
[Console]::Out.WriteLine('{"ok":true}')
exit 0
`);
 fs.writeFileSync(fixture,JSON.stringify({
  mode:'fixture',
  launcherScript:helper,
  targetHwnd:4242,
  startedTick:1000,
  teardownStart:5000,
  visible:true,
  minimized:false,
  receipt:true,
  closed:true,
  liveForegroundSamples:0,
  events:[
   {hwnd:4242,eventTick:1100,callbackForeground:100},
   {hwnd:4242,eventTick:1200,callbackForeground:100},
   {hwnd:4242,eventTick:5100,callbackForeground:4242},
   {hwnd:99,eventTick:1200,callbackForeground:100},
  ],
 },null,2),'utf8');
 const result=runFixture(fixture);
 assert.equal(result.status,1,result.stdout+'\n'+result.stderr);
 const reportJson=readReport(report);
 assert.equal(reportJson.targetForegroundEvents,2);
 assert.equal(reportJson.teardownForegroundEvents,1);
 assert.equal(reportJson.foregroundEvents,3);
 assert.deepEqual(reportJson.callbackForegrounds,[100,100,4242,100]);
 assert.equal(reportJson.passed,false,'target events must affect the acceptance verdict');
});

test('completed launcher jobs with helper stderr and nonzero exit are recorded and fail closed',()=>{
 assert.match(liveSource,/Receive-Job\s+-Job\s+\$job\s+-ErrorAction\s+Continue/);
 assert.match(liveSource,/launcherExitCode/);
 assert.doesNotMatch(liveSource,/Receive-Job\s+-Job\s+\$launchJob\s+-ErrorAction\s+SilentlyContinue/);
 for(const [label,exitCode,body,marker] of [
  ['console-error',1,`param([string]$Payload)
[Console]::Error.WriteLine('INACTIVE_WINDOW_LAUNCH_FAILED: fixture console error')
exit 1
`,'fixture console error'],
  ['write-error',7,`param([string]$Payload)
Write-Error 'fixture write error'
exit 7
`,'fixture write error'],
 ]){
  const {dir,fixture,report}=makeFixture(`launch-${label}-`);
  const helper=writeHelper(dir,'helper.ps1',body);
  fs.writeFileSync(fixture,JSON.stringify({
   mode:'fixture',launcherScript:helper,targetHwnd:4242,startedTick:1000,teardownStart:5000,
   visible:true,minimized:false,receipt:true,closed:true,liveForegroundSamples:0,events:[],
  },null,2),'utf8');
  const result=runFixture(fixture);
  assert.equal(result.status,1,`${label}: ${result.stdout}\n${result.stderr}`);
  const reportJson=readReport(report);
  assert.equal(reportJson.passed,false,label);
  assert.equal(reportJson.launcherJobState,'Completed',label);
  assert.equal(reportJson.launcherExitCode,exitCode,label);
  assert.ok(reportJson.launcherJobOutput.length>0,label);
  assert.equal(JSON.parse(reportJson.launcherJobOutput.at(-1)).exitCode,exitCode,label);
  assert.match(String(reportJson.failure),/launcher|exit|failed/i,label);
  assert.match(String(reportJson.launcherStderr),new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'),label);
 }
});
