// Loaded before the actual installed CLI. Credentials stay in memory.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isolatedConfig,protectSecrets} from './openclaw-config.mjs';
// Node on Windows can reject recursive mkdir of an existing drive root.
// Only an already-existing root directory qualifies; all other errors propagate.
if(process.platform==='win32'){
 const mkdir=fs.promises.mkdir.bind(fs.promises);
 fs.promises.mkdir=async function(target,options){
  if(typeof target==='string'&&options?.recursive&&path.resolve(target)===path.parse(path.resolve(target)).root&&fs.statSync(target).isDirectory())return undefined;
  return mkdir(target,options);
 };
}
const spec=JSON.parse(fs.readFileSync(process.env.ORCH_OPENCLAW_SPEC,'utf8'));
const runtime=await import(pathToFileURL(path.join(spec.packageRoot,'dist','plugin-sdk','config-runtime.js')));
const source=runtime.loadConfig();
process.env.OPENCLAW_STATE_DIR=spec.state;
process.env.OPENCLAW_CONFIG_PATH=path.join(spec.state,'runtime-config.json');
process.env.TEMP=spec.state;process.env.TMP=spec.state;process.env.TMPDIR=spec.state;
runtime.clearConfigCache();
const cfg=isolatedConfig(source,spec.workspace,spec.state,spec.planner);
fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify(protectSecrets(cfg,process.env)),{encoding:'utf8',mode:0o600});
runtime.setRuntimeConfigSnapshot(cfg,cfg);
process.chdir(spec.workspace);
