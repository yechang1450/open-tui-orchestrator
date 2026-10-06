import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {processSnapshot, transaction} from '../scripts/core/leases.mjs';
import {powershellExe} from '../scripts/core/contracts.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const family=path.join(root,'temp');fs.mkdirSync(family,{recursive:true});
const lockScript=path.join(root,'scripts','core','lease-lock.ps1');
const PS=powershellExe();
const self=processSnapshot().get(process.pid)||{ProcessId:process.pid,Started:''};

function startHolder(dir,ticket){
  return spawn(PS,['-NoProfile','-File',lockScript,'-Directory',dir,'-Ticket',ticket,'-Owner',String(self.ProcessId),'-Started',self.Started],{windowsHide:true,stdio:'ignore'});
}
async function waitReady(ticket,ms=15000){
  for(let i=0;i<ms/100;i++){if(fs.existsSync(ticket+'.ready'))return true;await new Promise(r=>setTimeout(r,100));}
  return false;
}

test('an abandoned kernel mutex is not taken as a clean acquisition', async () => {
  const dir=fs.mkdtempSync(path.join(family,'lease-lock-'));
  const t1=path.join(dir,'t1'),t2=path.join(dir,'t2'),t3=path.join(dir,'t3');
  let h1=null,h2=null,h3=null;
  try{
    h1=startHolder(dir,t1);
    assert.ok(await waitReady(t1),'the first holder must acquire the kernel mutex');
    // 第二个等待者必须先进入 WaitOne（等待中的等待者才会收到 AbandonedMutexException——
    // 若在 t1 死后才构造，互斥对象已被销毁重建，根本不会出现遗弃语义）。
    h2=startHolder(dir,t2);
    await new Promise(r=>setTimeout(r,3000));
    assert.equal(fs.existsSync(t2+'.ready'),false,'the second holder must still be waiting while t1 holds the mutex');
    // 强杀 t1 助手（taskkill/AV/OOM）：互斥被遗弃，但其属主可能仍在临界区——弃锁不等于安全进入。
    spawnSync('taskkill',['/PID',String(h1.pid),'/T','/F'],{windowsHide:true});
    h1=null;
    let settled=false;
    for(let i=0;i<100;i++){if(fs.existsSync(t2+'.status')){settled=true;break;}await new Promise(r=>setTimeout(r,100));}
    assert.ok(settled,'the waiting holder must settle with a status ticket');
    assert.equal(fs.readFileSync(t2+'.status','utf8').trim(),'abandoned-mutex');
    assert.equal(fs.existsSync(t2+'.ready'),false,'an abandoned mutex must not be reported as a clean acquisition');
    // 有界重试：弃锁状态被消费后，下一次获取必须是干净的。
    h3=startHolder(dir,t3);
    assert.ok(await waitReady(t3),'a bounded retry after the abandonment must acquire cleanly');
  }finally{
    for(const child of [h1,h2,h3])if(child){try{spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});}catch{/* already gone */}}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});


test("transaction refuses to retry after an abandoned coordinator mutex", {timeout: 240000}, async () => {
  const dir = fs.mkdtempSync(path.join(family, "lease-abandoned-transaction-"));
  const ticket = path.join(dir, "holder");
  const started = path.join(dir, "transaction-started");
  const resultFile = path.join(dir, "transaction-result.json");
  const worker = path.join(dir, "transaction-worker.mjs");
  const nodeExe = "C:/Program Files/nodejs/node.exe";
  const holder = startHolder(dir, ticket);
  let child = null;
  try {
    assert.ok(await waitReady(ticket), "the first holder must acquire the kernel mutex");
    const moduleUrl = new URL("../scripts/core/leases.mjs", import.meta.url).href;
    fs.writeFileSync(worker, [
      "import fs from " + JSON.stringify("node:fs") + ";",
      "import {transaction, processSnapshot} from " + JSON.stringify(moduleUrl) + ";",
      "const [dir, resultFile, started] = process.argv.slice(2);",
      "processSnapshot(); fs.writeFileSync(started, " + JSON.stringify("started") + ");",
      "try { const result = transaction(dir, () => ({ok: true})); fs.writeFileSync(resultFile, JSON.stringify({ok: true, result})); }",
      "catch (error) { fs.writeFileSync(resultFile, JSON.stringify({ok: false, error: String(error.message || error)})); process.exitCode = 1; }",
    ].join(String.fromCharCode(10)), "utf8");
    child = spawn(nodeExe, [worker, dir, resultFile, started], {env: {...process.env, ORCH_MUTEX_WAIT_MS: "30000", ORCH_MUTEX_RETRIES: "1", ORCH_PS_TIMEOUT_MS: "120000"}, windowsHide: true, stdio: "ignore"});
    const startedDeadline = Date.now() + 60000;
    while (!fs.existsSync(started) && Date.now() < startedDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(fs.existsSync(started), "the transaction worker must reach its pre-lock snapshot");
    // 关键前提（与上一条用例同一条道理）：**等待中的**等待者才会收到 AbandonedMutexException。
    // 若在属主死后才构造互斥对象，内核对象已被销毁重建，遗弃语义根本不出现，worker 会干净拿到锁。
    // 因此必须等 worker 的 lease-lock.ps1 真的进入 WaitOne 再杀属主——裸睡 1500ms 是按空载机器写的，
    // 满载时 PowerShell 冷启动就要几秒，属主被杀时 worker 还没开始等，本用例就变成假红。
    // 等待预算同步放大到 30000ms，留足「启动 → 进入 WaitOne → 被杀」的窗口。
    await new Promise(resolve => setTimeout(resolve, 10000));
    spawnSync("taskkill", ["/PID", String(holder.pid), "/T", "/F"], {windowsHide: true});
    const resultDeadline = Date.now() + 60000;
    while (!fs.existsSync(resultFile) && Date.now() < resultDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(fs.existsSync(resultFile), "the transaction worker must return after abandoned mutex detection");
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.error || "", /abandoned-mutex/);
    if (child.exitCode === null) await new Promise(resolve => child.once("exit", resolve));
  } finally {
    try { spawnSync("taskkill", ["/PID", String(holder.pid), "/T", "/F"], {windowsHide: true}); } catch {}
    if (child && child.exitCode === null) { try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {windowsHide: true}); } catch {} }
    if (holder.exitCode === null) await new Promise(resolve => holder.once("exit", resolve));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
