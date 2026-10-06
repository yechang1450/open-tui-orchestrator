import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {networkConfig, networkArgs, codexProviderMode, codexNetworkArgs} from '../scripts/network-policy.mjs';
import {launchArgs} from '../scripts/host-cli.mjs';

const family = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../temp');

test('HTTPS is applied to actual TUI arguments without replacing model or login', () => {
  // 2026-09-18：网络策略现在按 auto 门控（用户配了自家 provider 就不注入）。本判据锁定 OpenAI 默认路径，
  // 免得被这台机器自己的 config.toml（deepseek）染色。
  const prev = process.env.ORCH_CODEX_NETWORK_POLICY;
  process.env.ORCH_CODEX_NETWORK_POLICY = 'on';
  try {
    const args=launchArgs({id:'codex'}, {approval:['on','request'].join('-')});
    assert.ok(args.includes('model_providers.orchestrator-openai-https.supports_websockets=false'));
    assert.equal(args.includes('-a'), false);
    assert.equal(args.includes('never'), false);
    assert.ok(networkArgs().every(a=>args.includes(a)));
    const provider=networkConfig.model_providers[networkConfig.model_provider];
    assert.equal(provider.requires_openai_auth,true);
    assert.equal(provider.supports_standalone_web_search,true);
    assert.equal(provider.base_url,undefined);
    assert.equal(networkConfig.model,undefined);
  } finally {
    if (prev === undefined) delete process.env.ORCH_CODEX_NETWORK_POLICY; else process.env.ORCH_CODEX_NETWORK_POLICY = prev;
  }
});

// 现场（2026-09-18 用户令：codex 改用 DeepSeek provider，`irm …/codex-deepseek-setup.ps1 | iex` 落地后）：
// config.toml 写入了 model_provider="deepseek" + preferred_auth_method="apikey"，而工具的无条件 provider 注入
// 会把它顶掉——实跑表现为 `API key login is required, but ChatGPT is currently being used`。判据：用户的
// provider 一旦不是默认 openai，注入必须让路；env 可强制 on/off（红例：去掉门控即红）。
test('a custom model_provider in the user config.toml disables the OpenAI network override', () => {
  fs.mkdirSync(family, {recursive: true});
  const home = fs.mkdtempSync(path.join(family, 'netpol-'));
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "deepseek-flash"\nmodel_provider = "deepseek"\n', 'utf8');
    assert.equal(codexProviderMode({env: {CODEX_HOME: home}}), 'off');
    assert.deepEqual(codexNetworkArgs({env: {CODEX_HOME: home}}), [], 'the override must never clobber a user-declared provider');
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\n', 'utf8');
    assert.equal(codexProviderMode({env: {CODEX_HOME: home}}), 'on');
    assert.ok(codexNetworkArgs({env: {CODEX_HOME: home}}).length > 0, 'the default OpenAI path keeps the HTTPS policy');
    assert.equal(codexProviderMode({env: {CODEX_HOME: home, ORCH_CODEX_NETWORK_POLICY: 'off'}}), 'off');
    assert.equal(codexProviderMode({env: {ORCH_CODEX_NETWORK_POLICY: 'on'}}), 'on');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});
test('codex provider detection reads root TOML providers without matching nested profile tables',()=>{
 fs.mkdirSync(family,{recursive:true});
 const home=fs.mkdtempSync(path.join(family,'netpol-toml-'));
 try{
  fs.writeFileSync(path.join(home,'config.toml'),"model_provider = 'deepseek'\n[profiles.x]\nmodel_provider = 'openai'\n",'utf8');
  assert.equal(codexProviderMode({env:{CODEX_HOME:home}}),'off');
  fs.writeFileSync(path.join(home,'config.toml'),"model_provider = 'openai'\n",'utf8');
  assert.equal(codexProviderMode({env:{CODEX_HOME:home}}),'on');
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
