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
  const bin=fs.existsSync(path.join(path.dirname(file),'node.exe'))?path.join(path.dirname(file),'node.exe'):process.execPath;
  const ptyEntry=path.join(packageRoot,'node_modules','@lydell','node-pty','index.js');
  // 接口自证先于版本门：版本常量只记「最后验证于」，不是准入门槛；未验证版本必须带探针实测结果 fail-closed。
  // 运行时快照与 transcript 模式逐版敏感：扩版 = 逐版实机验收（见 docs/openclaw-adapter.md）。
  const help=probeCli(bin,[entry,'tui','--help'],{env,timeoutMs:30000});
  const probeOk=help.status===0&&['--local','--session','--message'].every(x=>String(help.stdout||'').includes(x));
  if(pkg.name!=='openclaw'||pkg.version!=='2026.9.2'){
    if(pkg.name==='openclaw')throw new Error('OPENCLAW_VERSION_UNTESTED: installed '+pkg.version+' (tui interface probe '+(probeOk?'OK':'mismatch')+', node-pty '+(fs.existsSync(ptyEntry)?'present':'missing')+'); last fully verified 2026.9.2. Expansion requires per-version acceptance of the config/transcript/TUI interfaces (docs/openclaw-adapter.md).');
    throw new Error('OPENCLAW_VERSION_UNTESTED: supported version is 2026.9.2');
  }
  if(!probeOk){rejected.push(`${bin} ${entry}: tui --help ${help.error?'probe error '+help.error:'exit '+help.status+'; flags mismatch'}`);continue;}
  if(!fs.existsSync(ptyEntry))throw new Error('OPENCLAW_PTY_MISSING');
  return {agent:'openclaw',config:{id:'openclaw',bin,entry,packageRoot,ptyEntry,version:pkg.version,available:true}};
 }
 throw new Error(`CLI_MISSING: no supported installed OpenClaw CLI; no fallback or automatic install. Tried: ${rejected.join(' | ')||'no candidate found on disk'}`);
}
