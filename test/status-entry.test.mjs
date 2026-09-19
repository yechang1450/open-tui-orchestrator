import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CODEX_CLI_SKIP} from './helpers/external.mjs';
test('public CLI --version is read-only and never resolves an agent CLI',()=>{
 const file=fileURLToPath(new URL('../cli.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[file,'--version'],{env:{...process.env,ORCH_CLI:'D:/nope/definitely-missing-orch-test.exe'},encoding:'utf8',windowsHide:true,timeout:20000});
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/^open-tui-orchestrator \d+\.\d+\.\d+(?:-\d+)? \(core \d+\.\d+\.\d+(?:-\d+)?\)$/m);
});
test('public SDK status dispatch returns an actual read-only status, not usage',{skip:CODEX_CLI_SKIP},()=>{
 const file=fileURLToPath(new URL('../scripts/orchestrate-sdk.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[file,'--status','--readonly'],{env:{...process.env,ORCH_AGENT:'codex'},encoding:'utf8',windowsHide:true,timeout:20000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/=== alive agent TUI windows ===/);assert.doesNotMatch(result.stdout,/Usage:/);
 const root=fileURLToPath(new URL('../',import.meta.url));
 const workspace=fs.mkdtempSync(path.join(root,'temp','inline-gate-'));
 try {
  const inline=spawnSync(process.execPath,[file,'--run-windows','修复项目81登录页'],{cwd:workspace,env:{...process.env,ORCH_AGENT:'codex',WORKSPACE_DIR:workspace,ORCH_STATE_DIR:path.join(workspace,'temp','orchestrator')},encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(inline.status,0,inline.stderr);
  assert.match(inline.stdout,/"mode":"inline"/);
  assert.match(inline.stdout,/"reason":"single-block"/);
  assert.doesNotMatch(inline.stdout,/win-launch-/,'single-block preflight must not create a TUI launcher');
 } finally { fs.rmSync(workspace,{recursive:true,force:true}); }
});

// 机器可调用契约（L3 翻转判据）：未知 run 从公开入口出去时，只允许一行
// `[orchestrator] FATAL: Run not found: <id>`——退出码非 0、无栈帧、无 ENOENT 原文、不挂起。
// 走真实入口（cli.mjs → scripts/orchestrate-sdk.mjs），所以它同时守住「入口永不甩裸栈」这条。
test('unknown-run entries fail closed with one clean diagnostic line',{skip:CODEX_CLI_SKIP},()=>{
 const file=fileURLToPath(new URL('../cli.mjs',import.meta.url));
 const root=fileURLToPath(new URL('../',import.meta.url));
 const workspace=fs.mkdtempSync(path.join(root,'temp','missing-run-'));
 try {
  const env={...process.env,ORCH_AGENT:'codex',WORKSPACE_DIR:workspace,ORCH_STATE_DIR:path.join(workspace,'temp','orchestrator'),
   ORCH_WATCH_GRACE_MS:'300',ORCH_MAINTENANCE_LOCK:path.join(workspace,'no-maintenance-lock.json')};
  for(const args of [['--verify-run','nosuch-run-entj'],['--resume-run','nosuch-run-entj'],['--watch','nosuch-run-entj']]){
   const result=spawnSync(process.execPath,[file,...args],{cwd:workspace,env,encoding:'utf8',windowsHide:true,timeout:30000});
   const label=args.join(' '),output=(result.stdout||'')+(result.stderr||'');
   assert.equal(typeof result.status,'number',label+' must exit (spawnSync timeout would leave status null): '+output);
   assert.notEqual(result.status,0,label+' must exit non-zero: '+output);
   assert.match(output,/Run not found: nosuch-run-entj/,label+' must name the missing run: '+output);
   assert.doesNotMatch(output,/^\s+at /m,label+' must not dump Node stack frames: '+output);
   assert.doesNotMatch(output,/ENOENT/,label+' must not leak the raw fs error: '+output);
  }
 } finally { fs.rmSync(workspace,{recursive:true,force:true}); }
});
