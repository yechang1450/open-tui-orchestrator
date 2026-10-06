import test from 'node:test';
import assert from 'node:assert/strict';
import {main,parsePollingOptions} from '../scripts/core/poll-windows.mjs';

const complete={runId:'poll-test',finishedAt:1,blocks:[{key:'B1'}],tasks:[{id:'T1'}],results:{B1:{status:'verified'}},taskResults:{T1:{status:'verified'}}};

test('poll rejects invalid timing, missing values and unknown flags',()=>{
  for(const args of [['--timeoutMs','Infinity'],['--timeoutMs','NaN'],['--timeoutMs','-1'],['--timeoutMs',''],['--intervalMs','0'],['--timeoutMs'],['--unknown'],['toString','1']])assert.throws(()=>parsePollingOptions(['--run-id','poll-test',...args]),/POLL_ARGUMENT_INVALID/);
  assert.equal(parsePollingOptions(['--run-id','poll-test','--timeoutMs','0']).timeoutMs,0);
});

test('poll sleeps only for the remaining deadline budget',async()=>{
  let time=0;const waits=[];const previous=process.exitCode;
  try{
    await main(['--run-id','poll-test','--timeoutMs','20','--intervalMs','5000'],{now:()=>time,sleep:async ms=>{waits.push(ms);time+=ms;},load:()=>null,log:()=>{},error:()=>{}});
    assert.deepEqual(waits,[20]);assert.equal(process.exitCode,1);
  }finally{process.exitCode=previous;}
});

test('process inspection failure cannot produce success',async()=>{
  await assert.rejects(main(['--run-id','poll-test'],{load:()=>complete,snapshot:()=>{throw new Error('inspection unavailable');},log:()=>{},error:()=>{}}),/inspection unavailable/);
});

test('verified result must be observed closed twice before success',async()=>{
  let time=0,calls=0;const previous=process.exitCode;
  try{
    await main(['--run-id','poll-test','--timeoutMs','2000','--intervalMs','500'],{now:()=>time,sleep:async ms=>{time+=ms;},load:()=>complete,snapshot:()=>{calls++;return new Map();},log:()=>{},error:()=>{}});
    assert.equal(calls,2);assert.equal(process.exitCode,0);
  }finally{process.exitCode=previous;}
});

test('inline engine success without a summary fails immediately instead of claiming execution',async()=>{
  const previous=process.exitCode;const logs=[];let snapshots=0,time=0;
  try{
    await main(['--run-id','poll-inline','--inline','--engine-exit','0','--timeoutMs','20','--intervalMs','5'],{
      engineExit:0,now:()=>time,load:()=>null,
      snapshot:()=>{snapshots++;throw new Error('inline must not inspect windows');},
      sleep:async ms=>{time+=ms;},
      log:line=>logs.push(line),error:line=>logs.push('ERR '+line),
    });
    assert.equal(snapshots,0);
    assert.equal(process.exitCode,1);
    assert.match(logs.join('\n'),/INLINE_NOT_EXECUTED|inline/);
    assert.doesNotMatch(logs.join('\n'),/timeout/);
  }finally{process.exitCode=previous;}
});

test('engine failure without a summary fails immediately instead of timing out',async()=>{
  const previous=process.exitCode;const logs=[];let snapshots=0,time=0;
  try{
    await main(['--run-id','poll-failed','--timeoutMs','20','--intervalMs','5'],{
      engineExit:1,now:()=>time,load:()=>null,
      snapshot:()=>{snapshots++;throw new Error('failed engine must not inspect windows');},
      sleep:async ms=>{time+=ms;},
      log:line=>logs.push(line),error:line=>logs.push('ERR '+line),
    });
    assert.equal(snapshots,0);
    assert.equal(process.exitCode,1);
    assert.match(logs.join('\n'),/engine-exit|failed/);
    assert.doesNotMatch(logs.join('\n'),/timeout/);
  }finally{process.exitCode=previous;}
});

test('finalized failed inventory reports the failure without waiting for live windows',async()=>{
  let time=0,snapshots=0;const logs=[],waits=[],previous=process.exitCode;
  const failed={...complete,success:false,taskResults:{T1:{status:'failed',reason:'probe rejected'}},results:{B1:{status:'failed',reason:'probe rejected'}}};
  try{
    await main(['--run-id','poll-test','--timeoutMs','1000'],{
      now:()=>time,load:()=>failed,
      snapshot:()=>{snapshots++;return new Map();},
      sleep:async ms=>{waits.push(ms);time+=ms;},
      log:line=>logs.push(line),error:line=>logs.push(line),
    });
    assert.equal(process.exitCode,1);
    assert.deepEqual(waits,[]);
    assert.equal(snapshots,0);
    assert.match(logs.join('\n'),/T1:failed/);
    assert.doesNotMatch(logs.join('\n'),/timeout/);
  }finally{process.exitCode=previous;}
});

test('failed engine with an unfinished inventory reports engine failure immediately',async()=>{
  let time=0;const logs=[],waits=[],previous=process.exitCode;
  const unfinished={...complete,finishedAt:null,taskResults:{T1:{status:'running'}},results:{B1:{status:'running'}}};
  try{
    await main(['--run-id','poll-test','--engine-exit','3','--timeoutMs','1000'],{
      now:()=>time,load:()=>unfinished,
      snapshot:()=>{throw new Error('failed engine must not inspect windows');},
      sleep:async ms=>{waits.push(ms);time+=ms;},
      log:line=>logs.push(line),error:line=>logs.push(line),
    });
    assert.equal(process.exitCode,1);
    assert.deepEqual(waits,[]);
    assert.match(logs.join('\n'),/engine-exit=3/);
    assert.doesNotMatch(logs.join('\n'),/timeout/);
  }finally{process.exitCode=previous;}
});
