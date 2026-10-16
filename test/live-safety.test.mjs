import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  loadDecomposeCache,
  readJsonDiagnostic,
  inspectProcess,
  collectOwnedProcessTargets,
  codexFailureReasons,
  ninthOrderedAfterAFreedSlot,
} from './live-safety.mjs';

const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const identity=(pid,overrides={})=>({
  ProcessId:pid,
  Started:'2026-10-04T00:00:00.000Z',
  Name:'node.exe',
  CommandLine:'node orchestrate-sdk.mjs --run-id fixture',
  ...overrides,
});

function fixture(tag) {
  fs.mkdirSync(family,{recursive:true});
  return fs.mkdtempSync(path.join(family,'live-safety-'+tag+'-'));
}

test('decompose cache rejects malformed state without overwriting evidence',()=>{
  const dir=fixture('cache');
  try {
    for(const [name,contents,pattern] of [
      ['invalid-json','{"version":','unreadable'],
      ['version-mismatch',JSON.stringify({version:'old',entries:{}}),'version/schema mismatch'],
      ['missing-entries',JSON.stringify({version:'v1'}),'version/schema mismatch'],
      ['array-entries',JSON.stringify({version:'v1',entries:[]}),'version/schema mismatch'],
    ]) {
      const file=path.join(dir,name+'.json');
      fs.writeFileSync(file,contents,'utf8');
      assert.throws(()=>loadDecomposeCache(file,'v1'),new RegExp(pattern));
      assert.equal(fs.readFileSync(file,'utf8'),contents,name+' must remain byte-for-byte intact');
    }
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('decompose cache accepts a valid object and preserves existing entries',()=>{
  const dir=fixture('cache-valid');
  try {
    const file=path.join(dir,'cache.json');
    fs.writeFileSync(file,JSON.stringify({version:'v1',entries:{old:{blocks:[]}}}),'utf8');
    const cache=loadDecomposeCache(file,'v1');
    cache.entries.next={blocks:[{title:'fixture'}]};
    assert.deepEqual(cache,{version:'v1',entries:{old:{blocks:[]},next:{blocks:[{title:'fixture'}]}}});
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('JSON diagnostics turn corruption into reportable data instead of throwing',()=>{
  const dir=fixture('json');
  try {
    const file=path.join(dir,'summary.json');
    fs.writeFileSync(file,'{"broken":','utf8');
    const result=readJsonDiagnostic(file,{label:'summary.json'});
    assert.equal(result.ok,false);
    assert.equal(result.kind,'invalid-json');
    assert.match(result.message,/summary\.json/);
    assert.equal(readJsonDiagnostic(path.join(dir,'missing.json'),{label:'result.json'}).kind,'missing');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('identity checks are tri-state and never treat a failed snapshot as process absence',()=>{
  const expected=identity(41);
  assert.equal(inspectProcess(expected,()=>{throw new Error('CIM unavailable');}).state,'unknown');
  assert.equal(inspectProcess(expected,()=>new Map()).state,'gone');
  assert.equal(inspectProcess(expected,()=>new Map([[41,identity(41,{Started:'reused'})]])).state,'mismatch');
  assert.equal(inspectProcess(expected,()=>new Map([[41,identity(41)]])).state,'live');
});

test('cleanup targets require full identities and include only owned descendants/windows',()=>{
  const controller=identity(10);
  const launcher=identity(20,{CommandLine:'pwsh.exe -File win-launch-fixture.ps1'});
  const child=identity(21,{ProcessId:21,CommandLine:'codex.exe --fixture'});
  const grandchild=identity(22,{ProcessId:22,CommandLine:'node child.mjs'});
  const unrelated=identity(30,{ProcessId:30,CommandLine:'node unrelated.mjs'});
  const snapshot=new Map([
    [10,controller],[20,launcher],[21,{...child,ParentProcessId:20}],[22,{...grandchild,ParentProcessId:21}],[30,unrelated],
  ]);
  const result=collectOwnedProcessTargets({
    controllers:[{label:'controller',identity:controller}],
    runId:'r1',
    windows:[
      {runId:'r1',identity:launcher},
      {runId:'r1',pid:30},
      {runId:'other',identity:unrelated},
    ],
  },()=>snapshot);
  assert.equal(result.state,'unknown','an identity-less owned window must block a cleanup claim');
  assert.deepEqual(result.targets.map(t=>t.pid).sort((a,b)=>a-b),[10,20]);
  assert.deepEqual(result.targets.find(t=>t.pid===20).descendants.sort((a,b)=>a-b),[21,22]);
  assert.match(result.diagnostics.join(' '),/identity/);
});

test('codex verdict keeps sampling failures in the pass/fail decision',()=>{
  const result=codexFailureReasons({
    samplingComplete:true,
    measurementFailures:[{stage:'sample',message:'one'},{stage:'sample',message:'two'}],
    engineExit:0,pollExit:0,peak:8,capacity:8,receiptsValid:true,ordered:true,overlap:true,
    windowLaunches:8,uniqueLaunchers:8,summaryResultCount:8,summaryResultsVerified:true,
    automaticClose:true,coreUnchanged:true,
  });
  assert.equal(result.passed,false);
  assert.deepEqual(result.failureReasons,['measurement-errors']);
});

test('codex verdict rejects an unknown or blocked cleanup result',()=>{
  const base={
    samplingComplete:true,
    measurementFailures:[],
    engineExit:0,pollExit:0,peak:8,capacity:8,receiptsValid:true,ordered:true,overlap:true,
    windowLaunches:8,uniqueLaunchers:8,summaryResultCount:8,summaryResultsVerified:true,
    automaticClose:true,coreUnchanged:true,
  };
  assert.equal(codexFailureReasons({...base,cleanupState:'clean',cleanupDiagnostics:[]}).passed,true);
  const blocked=codexFailureReasons({...base,cleanupState:'unknown',cleanupDiagnostics:['controller identity unavailable']});
  assert.equal(blocked.passed,false);
  assert.deepEqual(blocked.failureReasons,['cleanup-unknown']);
});

test('live recovery cleanup tracks launch wrappers rather than raw children',()=>{
  for(const name of ['live-guardian.mjs','live-recovery.mjs']) {
    const source=fs.readFileSync(path.join(repo,'test',name),'utf8');
    assert.doesNotMatch(source,/children\.push\(child\)/,name+' must retain the wrapper identity');
    assert.match(source,/const run=\{child,done,output:\(\)=>output,[^}]*label\}/,name+' must create a launch wrapper');
    assert.match(source,/children\.push\(run\)/,name+' must register the launch wrapper');
  }
});

test('live scripts use the fail-closed helpers and cannot lose their report on corrupt JSON',()=>{
  const guardian=fs.readFileSync(path.join(repo,'test','live-guardian.mjs'),'utf8');
  const recovery=fs.readFileSync(path.join(repo,'test','live-recovery.mjs'),'utf8');
  const codex=fs.readFileSync(path.join(repo,'test','live-codex.mjs'),'utf8');
  assert.match(guardian,/loadDecomposeCache/);
  assert.match(recovery,/loadDecomposeCache/);
  assert.match(guardian,/collectOwnedProcessTargets|inspectProcess/);
  assert.match(recovery,/collectOwnedProcessTargets|inspectProcess/);
  assert.match(codex,/readJsonDiagnostic/);
  assert.match(codex,/finally\s*\{/);
  assert.doesNotMatch(guardian,/child\.kill\(/);
  assert.doesNotMatch(recovery,/child\.kill\(/);
  assert.doesNotMatch(codex,/JSON\.parse\(fs\.readFileSync\(f,\s*['"]utf8['"]\)\)/);
  assert.doesNotMatch(codex,/JSON\.parse\(fs\.readFileSync\(summaryFile,\s*['"]utf8['"]\)\)/);
});

test('ninth ordering: the ninth must wait for a freed slot, not for one specific block',()=>{
  const at=(started,finished)=>({started,finished});
  // Lockstep round: the first eight start nearly together and finish between 2000-2007; the ninth
  // starts at 2100, after all of them — the old shape stays green here.
  const lockstep=[
    at(1000,2000),at(1002,2001),at(1004,2002),at(1006,2003),
    at(1008,2004),at(1010,2005),at(1012,2006),at(1014,2007),
    at(2100,2200),
  ];
  assert.equal(ninthOrderedAfterAFreedSlot(lockstep,true),true,'lockstep must pass');

  // Paced round (the measured 2026-10-16 shape, seconds-compressed): the ninth starts after the
  // EARLIEST finish (434) has freed a slot, while block eight launched later and is still running.
  // This is legal under the capacity contract and must pass; the old results[7]-based criterion
  // read it as `ordering-invalid`.
  const staggered=[at(0,434),at(18,434),at(36,434),at(142,434),at(68,434),at(38,434),at(90,434),at(418,500),at(440,460)];
  assert.equal(ninthOrderedAfterAFreedSlot(staggered,true),true,'paced-but-legal must pass');

  // Red case: a defect lets the ninth run while ALL eight are still live (its start predates every
  // finish) — the criterion must red. This is the regression the original criterion was written
  // for, and the new expression keeps it fail-closed.
  const racing=staggered.map(r=>({...r}));
  racing[8]=at(400,460);
  assert.equal(ninthOrderedAfterAFreedSlot(racing,true),false,'racing the ninth must red');

  // Red cases: fail-closed on invalid receipts and on missing finishes.
  assert.equal(ninthOrderedAfterAFreedSlot(lockstep,false),false,'invalid receipts must red');
  const broken=lockstep.map(r=>({...r}));
  broken[3]=at(1000,undefined);
  assert.equal(ninthOrderedAfterAFreedSlot(broken,true),false,'missing finish must red');
});
