import test from 'node:test';
import assert from 'node:assert/strict';
import {completionText, isolatedConfig,protectSecrets} from '../scripts/core/openclaw-config.mjs';
import {resolveOpenClawHost} from '../scripts/core/openclaw-host.mjs';
test('installed OpenClaw is resolved as its own versioned CLI',()=>{
 try{
  const host=resolveOpenClawHost();
  assert.equal(host.agent,'openclaw');
  assert.equal(host.config.version,'2026.9.2');
  assert.match(host.config.entry,/openclaw\.mjs$/);
 }catch(e){
  // 环境里的 openclaw 高于钉版（现状 2026.9.3）时必须 fail-closed：扩版需逐版实机验收
  // （2026-09-10 首次尝试因环境 gateway 密钥条件未闭环，见 memory/2026-09-10.md）。
  assert.match(e.message,/OPENCLAW_VERSION_UNTESTED|CLI_MISSING/);
 }
});
test('explicit missing OpenClaw CLI cannot fall back to another agent',()=>{
 assert.throws(()=>resolveOpenClawHost({...process.env,ORCH_CLI:'D:/missing-openclaw-cli-for-test.mjs'}),/CLI_MISSING/);
});
test('OpenClaw completion accepts only a final assistant marker for the exact token',()=>{
 const e=(role,text,stopReason='stop')=>({type:'message',message:{role,stopReason,content:[{type:'text',text}]}});
 assert.equal(completionText([e('user','__ORCH_DONE__ abc')],'abc'),null);
 assert.equal(completionText([e('assistant','__ORCH_DONE__ abcd')],'abc'),null);
 assert.equal(completionText([e('assistant','__ORCH_DONE__ abc','error')],'abc'),null);
 assert.equal(completionText([e('assistant','__ORCH_DONE__ abc')],'abc'),'__ORCH_DONE__ abc');
 assert.equal(completionText([e('assistant','Finished and checked.\n\n__ORCH_DONE__ abc')],'abc'),'__ORCH_DONE__ abc');
 assert.equal(completionText([e('assistant','__ORCH_DONE__ abc\nMore work remains')],'abc'),null);
 assert.equal(completionText([e('assistant','__ORCH_DONE__ abc'),e('user','more')],'abc'),null);
});
test('temporary config serializes environment references instead of credentials',()=>{
 const env={},source={models:{providers:{p:{apiKey:'secret-for-test'}}},gateway:{auth:{token:'other-test-secret'}}};
 const encoded=JSON.stringify(protectSecrets(source,env));assert.ok(!encoded.includes('secret-for-test'));assert.ok(!encoded.includes('other-test-secret'));
 assert.deepEqual(Object.values(env),['secret-for-test','other-test-secret']);assert.equal(source.models.providers.p.apiKey,'secret-for-test');
});
test('worker disables inherited Weixin without disabling provider plugins or changing main settings',()=>{
 const source={plugins:{entries:{'openclaw-weixin':{enabled:true,config:{account:'main'}},provider:{enabled:true}},load:{paths:['provider-path']}}};
 const cfg=isolatedConfig(source,'D:\\','D:\\temp\\oc');
 assert.deepEqual(cfg.plugins.entries['openclaw-weixin'],{enabled:false});
 assert.equal(cfg.plugins.entries.provider.enabled,true);
 assert.equal(source.plugins.entries['openclaw-weixin'].enabled,true);
 assert.deepEqual(cfg.plugins.load.paths,['provider-path']);
});
test('isolated OpenClaw config binds workspace and state without modifying original config',()=>{
 const source={agents:{defaults:{workspace:'old',sandbox:{mode:'all'}},list:[{id:'other'}]},models:{providers:{example:{apiKey:'test-only'}}},tools:{exec:{mode:'ask'}},channels:{example:{enabled:true}}};
 const original=JSON.stringify(source),cfg=isolatedConfig(source,'D:\\','D:\\temp\\oc',false);
 assert.equal(JSON.stringify(source),original);assert.equal(cfg.agents.defaults.workspace,'D:\\');
 assert.equal(cfg.agents.entries.main.agentDir,'D:\\temp\\oc\\agents\\main\\agent');
 assert.equal(cfg.tools.exec.mode,'ask');assert.equal(cfg.agents.defaults.sandbox.mode,'all');
 assert.deepEqual(cfg.channels,{});assert.equal(cfg.agents.defaults.skipBootstrap,true);
 assert.equal(cfg.plugins.entries['openclaw-weixin'].enabled,false);
 assert.deepEqual(isolatedConfig(source,'D:\\','D:\\temp\\oc',true).tools.deny,['*']);
});
