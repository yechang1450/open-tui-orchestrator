import fs from 'node:fs';
import path from 'node:path';
import {probeCli} from './host-probe.mjs';

// OpenClaw adapter (print-class): drives the official headless agent surface
// `openclaw agent --local` — one agent turn per unit on the embedded runtime,
// no gateway daemon involved. Interface self-proof comes first: the
// `agent --help` probe must answer with the flags this adapter drives.
// The recorded version is "last fully verified on", NOT a hard gate — a
// mismatching probe still fails closed with its result attached.
export const OPENCLAW_LAST_VERIFIED = '2026.10.1';

export function resolveOpenClawHost(env=process.env) {
  const explicit=env.ORCH_CLI||env.OPENCLAW_EXE;
  const paths=explicit?[path.resolve(explicit)]:String(env.PATH||env.Path||'').split(path.delimiter).flatMap(d=>['openclaw.cmd','openclaw'].map(n=>path.join(d,n)));
  const rejected=[];
  for(const file of [...new Set(paths)]){
    try{if(!fs.statSync(file).isFile())continue;}catch{continue;}
    let entry=/\.mjs$/.test(file)?file:null;
    if(!entry){
      let shim='';
      try{shim=fs.readFileSync(file,'utf8');}catch(error){rejected.push(`${file}: unreadable candidate (${error.message})`);continue;}
      if(/node_modules[\\/]openclaw[\\/]openclaw\.mjs/.test(shim))entry=path.join(path.dirname(file),'node_modules','openclaw','openclaw.mjs');
    }
    try{if(!entry||!fs.statSync(entry).isFile())continue;}catch{continue;}
    const packageRoot=path.dirname(entry);
    let pkg;
    try{pkg=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8'));}catch(error){rejected.push(`${file}: invalid package metadata (${error.message})`);continue;}
    if(pkg.name!=='openclaw'){rejected.push(`${file}: package identity ${JSON.stringify(String(pkg.name||'unknown'))}`);continue;}
    const bin=fs.existsSync(path.join(path.dirname(file),'node.exe'))?path.join(path.dirname(file),'node.exe'):process.execPath;
    const help=probeCli(bin,[entry,'agent','--help'],{env,timeoutMs:30000});
    const probeOk=help.status===0&&['--local','--message','--message-file','--json'].every(x=>String(help.stdout||'').includes(x));
    if(!probeOk){rejected.push(`${bin} ${entry}: agent --help ${help.error?'probe error '+help.error:'exit '+help.status+'; flags mismatch'}`);continue;}
    return {agent:'openclaw',config:{id:'openclaw',label:'OpenClaw CLI',bin,entry,packageRoot,version:pkg.version,lastVerified:OPENCLAW_LAST_VERIFIED,prefixArgs:[entry],available:true,native:false,completionMarker:'__ORCH_DONE__',modelEnv:'ORCH_MODEL'}};
  }
  throw new Error(`CLI_MISSING: openclaw; no supported installed OpenClaw CLI found. No fallback or automatic install. Tried: ${rejected.join(' | ')||'no candidate found on disk'}`);
}

// Base argv for `openclaw agent --local` (one headless turn; the prompt is
// appended by the caller via -m/--message or --message-file, and --model
// carries the orchestrator's inherited/detected model).
export function openclawArgs(config,{model}={}) {
  return [...(config.prefixArgs||[]),'agent','--local',
    ...(model&&String(model).trim()&&!/\s/.test(String(model))?['--model',String(model).trim()]:[])];
}
