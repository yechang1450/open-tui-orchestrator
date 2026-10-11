import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveHost,launchArgs} from '../scripts/core/host-cli.mjs';

const family=path.join(fileURLToPath(new URL('..',import.meta.url)),'temp');
// 与 pi-adapter.test.mjs 同款：宿主的 CLI 没装时这条用例的前提不成立，按仓库既有惯例 skip；
// CLI 在装时照旧跑全部断言（宿主不在本机 ≠ 编排器适配坏了）。
let kimiAvailable = false;
try {
  kimiAvailable = Boolean(resolveHost({env:{...process.env, ORCH_AGENT:'kimi'}}));
} catch (error) {
  if (!(error?.code === 'CLI_MISSING' || /CLI_MISSING/.test(String(error?.message)))) throw error;
}
const kimiOnly = {skip: kimiAvailable ? false : 'kimi CLI is not installed'};
test('installed kimi resolves its own CLI and never receives Codex flags',kimiOnly,()=>{
 const host=resolveHost({env:{...process.env,ORCH_AGENT:'kimi'}});
 assert.equal(host.agent,'kimi');assert.match(host.config.bin,/kimi\.(exe|cmd)$/i,'installed kimi may be an .exe (native installer) or a .cmd shim (npm global)');
 assert.match(host.config.version,/^\d+\.\d+\.\d+$/);
 const args=launchArgs(host.config,{cwd:process.cwd()});
 assert.deepEqual(args,['-p']);
 assert.ok(!args.includes('--sandbox'));assert.ok(!args.includes('--cd'));
});
test('an explicit missing kimi CLI never falls back to PATH or Codex',()=>{
 assert.throws(()=>resolveHost({env:{...process.env,ORCH_AGENT:'kimi',ORCH_CLI:'D:/temp/no-such-kimi-orchestrator-test.exe'}}),/CLI_MISSING/);
 assert.throws(()=>launchArgs({id:'kimi'},{sandbox:'read-only'}),/KIMI_SANDBOX_UNSUPPORTED/);
});
test('kimi model argv precedes -p so the parser never eats the model as a subcommand',()=>{
  const pm=process.env.ORCH_MODEL;process.env.ORCH_MODEL='kimi-k3';
  try{
   const args=launchArgs({id:'kimi',prefixArgs:[]},{cwd:process.cwd()});
   assert.deepEqual(args,['-m','kimi-k3','-p']);
 }finally{if(pm===undefined)delete process.env.ORCH_MODEL;else process.env.ORCH_MODEL=pm;}
});

// 反例（2026-09-22 必红）：探测 --help 时不指定列宽 ⇒ 这个假 CLI 按 Rich 的方式把别名列截断
// （80 列下 `--auto` 藏在 `--yolo,--yes,--…` 里根本不出现）⇒ 真装好的 kimi 被判 CLI_MISSING。
// 本机 kimi 1.50.0 实测：80 列缺 `--auto`、COLUMNS=200 三个旗标全在；版本行也带标签
// （`kimi, version 1.50.0`），旧解析要求裸 semver，同样会误拒。
const FAKE_KIMI = `const args = process.argv.slice(2);
const wide = Number(process.env.COLUMNS || 0) >= 120;
if (args.includes('--help')) {
  const flags = wide
    ? '--prompt,--command  --output-format  --auto,--auto-approve  --print'
    : '--prompt,--comm…  --output-format  --print,--qui…';
  console.log('Usage: kimi [OPTIONS] [COMMAND] [ARGS]...');
  console.log(flags);
  process.exit(0);
}
if (args.includes('--version')) { console.log('kimi, version 7.7.7'); process.exit(0); }
process.exit(1);
`;

test('a width-truncated kimi help is still detected and the labelled version is parsed',()=>{
  fs.mkdirSync(family,{recursive:true});
  const dir=fs.mkdtempSync(path.join(family,'kimi-fake-'));
  try{
    const fake=path.join(dir,'kimi-fake.mjs');
    fs.writeFileSync(fake,FAKE_KIMI,'utf8');
    const host=resolveHost({env:{...process.env,ORCH_AGENT:'kimi',ORCH_CLI:fake,COLUMNS:''}});
    assert.equal(host.agent,'kimi');
    assert.equal(host.config.bin,process.execPath);
    assert.deepEqual(host.config.prefixArgs,[fake]);
    assert.equal(host.config.version,'7.7.7','the labelled version line must be parsed down to the semver');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

// npm 全局安装形态（2026-10-11 实测 kimi 2.1.1：~/.npm-global 下只有 .cmd/.ps1/无扩展名 shim、
// 没有 kimi.exe）：旧逻辑对 .cmd 落进"找伴生 kimi.exe"分支并被跳过 ⇒ 装好也被判 CLI_MISSING
// （连 --cli 显式指向 .cmd 也一样）。红例：去掉 resolveKimiHost 的 .cmd 分支时本用例必红。
test('an npm-installed kimi .cmd shim resolves directly (no kimi.exe sibling)',()=>{
  fs.mkdirSync(family,{recursive:true});
  const dir=fs.mkdtempSync(path.join(family,'kimi-cmd-'));
  try{
    const shim=path.join(dir,'kimi.cmd');
    fs.writeFileSync(shim,'@echo off\r\nif "%~1"=="--help" echo --prompt --output-format --auto\r\nif "%~1"=="--version" echo kimi, version 3.3.3\r\nexit /b 0\r\n');
    const host=resolveHost({env:{ORCH_AGENT:'kimi',PATH:dir,ComSpec:process.env.ComSpec||'cmd.exe'}});
    assert.equal(host.agent,'kimi');
    assert.match(host.config.bin,/kimi\.cmd$/i,'the .cmd shim itself must be adopted when no kimi.exe sibling exists');
    assert.equal(host.config.version,'3.3.3');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
