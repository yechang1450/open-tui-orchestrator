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
const specPath=process.env.ORCH_OPENCLAW_SPEC;
if(!specPath)throw new Error('OPENCLAW_BOOTSTRAP_REJECTED: missing spec path');
const spec=JSON.parse(fs.readFileSync(specPath,'utf8'));
const trustedRoot=process.env.ORCH_OPENCLAW_PACKAGE_ROOT;
if(!trustedRoot)throw new Error('OPENCLAW_BOOTSTRAP_REJECTED: missing trusted package root');
const real=target=>{try{return fs.realpathSync.native(target);}catch{throw new Error('OPENCLAW_BOOTSTRAP_REJECTED: path is not readable: '+target);}};
const packageRoot=real(spec.packageRoot),trustedPackageRoot=real(trustedRoot);
const fold=value=>process.platform==='win32'?String(value).toLowerCase():String(value);
if(fold(packageRoot)!==fold(trustedPackageRoot))throw new Error('OPENCLAW_BOOTSTRAP_REJECTED: package root does not match the trusted host resolution');
const entry=real(spec.entry),expectedEntry=real(path.join(packageRoot,'openclaw.mjs'));
if(fold(entry)!==fold(expectedEntry))throw new Error('OPENCLAW_BOOTSTRAP_REJECTED: entry is not the resolved OpenClaw entry');
const runtimePath=real(path.join(packageRoot,'dist','plugin-sdk','config-runtime.js'));
const pkg=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8'));
if(pkg.name!=='openclaw')throw new Error('OPENCLAW_BOOTSTRAP_REJECTED: package identity mismatch');
const runtime=await import(pathToFileURL(runtimePath));
const source=runtime.loadConfig();
process.env.OPENCLAW_STATE_DIR=spec.state;
process.env.OPENCLAW_CONFIG_PATH=path.join(spec.state,'runtime-config.json');
process.env.TEMP=spec.state;process.env.TMP=spec.state;process.env.TMPDIR=spec.state;
runtime.clearConfigCache();
const cfg=isolatedConfig(source,spec.workspace,spec.state,spec.planner);
fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify(protectSecrets(cfg,process.env)),{encoding:'utf8',mode:0o600});
runtime.setRuntimeConfigSnapshot(cfg,cfg);
process.chdir(spec.workspace);
