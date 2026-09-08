import path from 'node:path';
export function isolatedConfig(source,workspace,state,planner=false) {
 const cfg=structuredClone(source);
 cfg.agents={...cfg.agents,defaults:{...cfg.agents?.defaults,workspace,skipBootstrap:true,heartbeat:{every:'0m'}},entries:{main:{workspace,agentDir:path.join(state,'agents','main','agent')}}};
 delete cfg.agents.list;delete cfg.agents.defaults.memorySearch;
 cfg.memory={...cfg.memory,search:{enabled:false}};
 cfg.channels={};cfg.hooks={enabled:false};cfg.cron={enabled:false};
 // Channel plugins can discover saved accounts even without a channels entry.
 // Explicitly disable Weixin in workers while retaining model provider plugins.
 cfg.plugins={...cfg.plugins,entries:{...cfg.plugins?.entries,'openclaw-weixin':{enabled:false}}};
 cfg.logging={...cfg.logging,file:path.join(state,'openclaw.log')};
 cfg.tools={...cfg.tools,...(planner?{deny:['*']}:{})};
 return cfg;
}
export function completionText(events,token) {
 const last=events.filter(e=>e.type==='message'&&e.message).at(-1)?.message;
 if(last?.role!=='assistant'||!['stop','end_turn'].includes(last.stopReason))return null;
 const content=Array.isArray(last.content)?last.content:[{type:'text',text:last.content||''}];
 if(content.some(c=>['toolCall','tool_use'].includes(c.type)))return null;
 const text=content.filter(c=>c.type==='text').map(c=>c.text).join('').trim();
 const lastLine=text.split(/\r?\n/).at(-1).trim();
 return lastLine===`__ORCH_DONE__ ${token}`?lastLine:null;
}
export function protectSecrets(config,env) {
 let index=0;
 const visit=(value,key='')=>{
  if(typeof value==='string'&&/(api.?key|token|password|secret|authorization|private.?key)/i.test(key)&&value&&!value.startsWith('${')){
   const name='ORCH_OC_SECRET_'+index++;env[name]=value;return '${'+name+'}';
  }
  if(Array.isArray(value))return value.map(v=>visit(v,key));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v,k)]));
  return value;
 };
 return visit(config);
}
