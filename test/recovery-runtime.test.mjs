import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runWindows,verifyRun,waitForProcessExit} from '../scripts/core/runner.mjs';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';
import {claimRun,releaseRun} from '../scripts/core/leases.mjs';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('launcher exit verification tolerates a short process teardown race',async()=>{
 const expected={ProcessId:7,Name:'powershell.exe',Started:'s',CommandLine:'win-launch-test.ps1'};let calls=0;
 const gone=await waitForProcessExit(expected,{timeoutMs:200,intervalMs:10,snapshot:()=>calls++===0?new Map([[7,expected]]):new Map()});
 assert.equal(gone,true);
 const stuck=await waitForProcessExit(expected,{timeoutMs:20,intervalMs:10,snapshot:()=>new Map([[7,expected]])});
 assert.equal(stuck,false);
});
test('checkpoint refuses duplicate execution and completion without a start record',()=>{
 fs.mkdirSync(family,{recursive:true});const d=fs.mkdtempSync(path.join(family,'checkpoints-'));
 try{const f=path.join(d,'attempt.json');fs.writeFileSync(f,JSON.stringify({runId:'r',token:'t',taskIds:['T1']}));
  assert.throws(()=>recordCheckpoint(f,'T1','completed'),/started/);recordCheckpoint(f,'T1','started');
  assert.throws(()=>recordCheckpoint(f,'T1','started'),/already started/);recordCheckpoint(f,'T1','completed');
  assert.throws(()=>recordCheckpoint(f,'T1','started'),/already completed/);assert.throws(()=>recordCheckpoint(f,'other','started'),/Invalid/);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('two controllers cannot own the same run concurrently',async()=>{
 const d=fs.mkdtempSync(path.join(family,'run-claim-'));let claim;
 try{claim=claimRun(d,'run');assert.throws(()=>claimRun(d,'run'),/live controller/);releaseRun(d,'run',claim);claim=claimRun(d,'run');}
 finally{if(claim)releaseRun(d,'run',claim);await pause(500);fs.rmSync(d,{recursive:true,force:true});}
});
test('actual partial execution is recovered without repeating its completed side effect',async()=>{
 const d=fs.mkdtempSync(path.join(family,'recover-process-')),attempts=[],children=[];
 const lit=s=>"'"+s.replaceAll("'","''")+"'";
 const worker=path.join(d,'worker.mjs');
 fs.writeFileSync(worker,`import fs from 'node:fs';import path from 'node:path';import {recordCheckpoint} from ${JSON.stringify(new URL('../scripts/core/checkpoint.mjs',import.meta.url).href)};
 const [file,rf,root]=process.argv.slice(2),a=JSON.parse(fs.readFileSync(file));
 while(!fs.existsSync(rf+'.go'))await new Promise(r=>setTimeout(r,20));
 for(const id of a.taskIds){recordCheckpoint(file,id,'started');
 if(id==='T001'){const f=path.join(root,'count.json');const count=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)).count:0;fs.writeFileSync(f,JSON.stringify({count:count+1}));}
 if(id==='T002'&&a.number===1){fs.writeFileSync(rf,JSON.stringify({exitCode:23,attempt:a.number}));process.exit(23);}
 if(id==='T002')fs.writeFileSync(path.join(root,'done.json'),JSON.stringify({done:true}));
 recordCheckpoint(file,id,'completed');}
 fs.writeFileSync(rf,JSON.stringify({exitCode:0,attempt:a.number}));`);
 const checks=path.join(d,'acceptance.json');fs.writeFileSync(checks,JSON.stringify({T001:[{type:'json',path:'count.json',equals:{count:1}}],T002:{retrySafe:true,checks:[{type:'json',path:'done.json',equals:{done:true}}]}}));
 const hooks={plan:async()=>[{title:'linked',type:'linked',tasks:[{prompt:'执行甲'},{prompt:'执行乙'}]}],compact:p=>p,infer:()=>[],prompt:p=>p,
  launcher:(key,prompt,suffix)=>{const file=/开始前：node "[^"]+" "([^"]+)"/.exec(prompt)[1];attempts.push(JSON.parse(fs.readFileSync(file)).taskIds);
   const pidf=path.join(d,'window-'+suffix+'.pid'),lp=path.join(d,'win-launch-'+suffix+'.ps1'),rf=path.join(d,suffix+'.result');
   fs.writeFileSync(lp,'\ufeff'+`$PID | Set-Content -LiteralPath ${lit(pidf)} -Encoding UTF8\n& ${lit(process.execPath)} ${lit(worker)} ${lit(file)} ${lit(rf)} ${lit(d)}\nexit 0`);return{pidf,lp,rf};},
  spawn:async(lp,_title,pidf)=>{const child=spawn('powershell.exe',['-NoProfile','-File',lp],{windowsHide:true,stdio:'ignore'});children.push(child);const end=Date.now()+15000;while(!fs.existsSync(pidf)&&Date.now()<end)await pause(20);return fs.existsSync(pidf);},
  readPid:p=>{try{return fs.existsSync(p)?Number(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'')):0;}catch{return 0;}},
  session:async()=> 'controlled',wait:async(_session,_timeout,rf)=>{fs.writeFileSync(rf+'.go','go');const end=Date.now()+15000;while(!fs.existsSync(rf)&&Date.now()<end)await pause(20);return {done:fs.existsSync(rf),exitCode:JSON.parse(fs.readFileSync(rf)).exitCode};},
  exitCode:rf=>fs.existsSync(rf)?JSON.parse(fs.readFileSync(rf)).exitCode:null,
  register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},close:async(pid)=>{const end=Date.now()+10000;while(Date.now()<end){try{process.kill(pid,0);}catch{await pause(100);return;}await pause(100);}try{process.kill(pid);}catch{}await pause(300);},
 };
 try{const opts={workspace:d,capacity:8,runId:'partial',acceptanceFile:checks,coordinator:path.join(d,'temp','coordinator'),auth:'test'};
  const sum=await runWindows('执行甲；执行乙',hooks,opts);
  if(!sum.success){const dump=[];const walk=(p,pre='')=>{try{for(const e of fs.readdirSync(p,{withFileTypes:true})){const fp=path.join(p,e.name);if(e.isDirectory())walk(fp,pre+e.name+'/');else{let c='';try{c=fs.readFileSync(fp,'utf8').slice(0,300)}catch(x){c='<'+x.message+'>'}dump.push(pre+e.name+' :: '+c.replace(/\n/g,' '))}}}catch{}};walk(d);console.error('RRT-DUMP\n'+dump.join('\n')+'\nRRT-END');}
  assert.equal(sum.success,true,JSON.stringify(sum.results));assert.deepEqual(attempts,[['T001','T002'],['T002']]);assert.equal(JSON.parse(fs.readFileSync(path.join(d,'count.json'))).count,1);
  const recovered=await runWindows('',hooks,{...opts,resume:true});assert.equal(recovered.success,true);assert.equal(attempts.length,2,'verified resume must open no new window');
 }finally{for(const child of children)if(child.exitCode===null)child.kill();await pause(500);fs.rmSync(d,{recursive:true,force:true});}
});

test('resume and verify refuse a tampered acceptance contract',async()=>{
 const d=fs.mkdtempSync(path.join(family,'acceptance-tamper-')),children=[];
 const lit=s=>"'"+s.replaceAll("'","''")+"'";
 const worker=path.join(d,'worker.mjs');
 fs.writeFileSync(worker,`import fs from 'node:fs';import path from 'node:path';import {recordCheckpoint} from ${JSON.stringify(new URL('../scripts/core/checkpoint.mjs',import.meta.url).href)};
 const [file,rf,root]=process.argv.slice(2),a=JSON.parse(fs.readFileSync(file));
 while(!fs.existsSync(rf+'.go'))await new Promise(r=>setTimeout(r,20));
 for(const id of a.taskIds){recordCheckpoint(file,id,'started');fs.writeFileSync(path.join(root,'done.json'),JSON.stringify({done:true}));recordCheckpoint(file,id,'completed');}
 fs.writeFileSync(rf,JSON.stringify({exitCode:0,attempt:a.number}));`);
 const checks=path.join(d,'acceptance-src.json');fs.writeFileSync(checks,JSON.stringify({T001:[{type:'json',path:'done.json',equals:{done:true}}]}));
 const hooks={plan:async()=>[{title:'only',type:'parallel',tasks:[{prompt:'执行甲'}]}],compact:p=>p,infer:()=>[],prompt:p=>p,
  launcher:(key,prompt,suffix)=>{const file=/开始前：node "[^"]+" "([^"]+)"/.exec(prompt)[1];
   const pidf=path.join(d,'window-'+suffix+'.pid'),lp=path.join(d,'win-launch-'+suffix+'.ps1'),rf=path.join(d,suffix+'.result');
   fs.writeFileSync(lp,'\uFEFF'+`$PID | Set-Content -LiteralPath ${lit(pidf)} -Encoding UTF8\n& ${lit(process.execPath)} ${lit(worker)} ${lit(file)} ${lit(rf)} ${lit(d)}\nexit 0`);return{pidf,lp,rf};},
  spawn:async(lp,_title,pidf)=>{const child=spawn('powershell.exe',['-NoProfile','-File',lp],{windowsHide:true,stdio:'ignore'});children.push(child);const end=Date.now()+15000;while(!fs.existsSync(pidf)&&Date.now()<end)await pause(20);return fs.existsSync(pidf);},
  readPid:p=>{try{return fs.existsSync(p)?Number(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'')):0;}catch{return 0;}},
  session:async()=> 'controlled',wait:async(_session,_timeout,rf)=>{fs.writeFileSync(rf+'.go','go');const end=Date.now()+15000;while(!fs.existsSync(rf)&&Date.now()<end)await pause(20);return {done:fs.existsSync(rf),exitCode:JSON.parse(fs.readFileSync(rf)).exitCode};},
  exitCode:rf=>fs.existsSync(rf)?JSON.parse(fs.readFileSync(rf)).exitCode:null,
  register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},close:async()=>{await pause(100);},
 };
 try{const opts={workspace:d,capacity:8,runId:'tamper',acceptanceFile:checks,coordinator:path.join(d,'temp','coordinator'),auth:'test'};
  const sum=await runWindows('执行甲',hooks,opts);
  assert.equal(sum.success,true,JSON.stringify(sum.results));
  assert.match(sum.acceptanceSha256||'',/^[0-9a-f]{64}$/,'creation stamps the acceptance hash');
  // 篡改持久化的验收契约（run 目录对窗内 agent 可写）：插入会以控制器权限执行的 command 检查
  fs.writeFileSync(path.join(d,'temp','orchestrator','runs','tamper','acceptance.json'),JSON.stringify({T001:[{type:'command',command:'powershell.exe',args:['-NoProfile','-Command','exit 0']}]}));
  await assert.rejects(runWindows('',hooks,{...opts,acceptanceFile:undefined,resume:true}),/Acceptance contract changed/);
  assert.throws(()=>verifyRun(d,'tamper'),/Acceptance contract changed/);
 }finally{for(const child of children)if(child.exitCode===null)child.kill();await pause(500);fs.rmSync(d,{recursive:true,force:true});}
});
