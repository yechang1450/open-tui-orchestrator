import fs from 'node:fs';
import path from 'node:path';
import {probeCli} from './host-probe.mjs';
export function resolveOpenClawHost(env=process.env) {
 const explicit=env.ORCH_CLI||env.OPENCLAW_EXE;
 const paths=explicit?[path.resolve(explicit)]:String(env.PATH||env.Path||'').split(path.delimiter).flatMap(d=>['openclaw.cmd','openclaw'].map(n=>path.join(d,n)));
 const rejected=[];
 for(const file of [...new Set(paths)]){
  if(!fs.existsSync(file))continue;
  let entry=/\.mjs$/.test(file)?file:null;
  if(!entry&&/node_modules[\\/]openclaw[\\/]openclaw\.mjs/.test(fs.readFileSync(file,'utf8')))entry=path.join(path.dirname(file),'node_modules','openclaw','openclaw.mjs');
  if(!entry||!fs.existsSync(entry))continue;
  const packageRoot=path.dirname(entry),pkg=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8'));
  // Runtime snapshot + transcript schema are version-sensitive: expand after acceptance.
  if(pkg.name!=='openclaw'||pkg.version!=='2026.9.2')throw new Error('OPENCLAW_VERSION_UNTESTED: supported version is 2026.9.2');
  const bin=fs.existsSync(path.join(path.dirname(file),'node.exe'))?path.join(path.dirname(file),'node.exe'):process.execPath;
  const help=probeCli(bin,[entry,'tui','--help'],{env,timeoutMs:15000});
  if(help.status!==0||!['--local','--session','--message'].every(x=>help.stdout.includes(x))){rejected.push(`${bin} ${entry}: tui --help ${help.error?'probe error '+help.error:'exit '+help.status+'; flags mismatch'}`);continue;}
  const ptyEntry=path.join(packageRoot,'node_modules','@lydell','node-pty','index.js');
  if(!fs.existsSync(ptyEntry))throw new Error('OPENCLAW_PTY_MISSING');
  return {agent:'openclaw',config:{id:'openclaw',bin,entry,packageRoot,ptyEntry,version:pkg.version,available:true}};
 }
 throw new Error(`CLI_MISSING: no supported installed OpenClaw CLI; no fallback or automatic install. Tried: ${rejected.join(' | ')||'no candidate found on disk'}`);
}
