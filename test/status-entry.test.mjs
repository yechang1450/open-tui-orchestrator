import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('public SDK status dispatch returns an actual read-only status, not usage',()=>{
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
