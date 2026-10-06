import fs from 'node:fs';
import path from 'node:path';
import {probeCli} from './host-probe.mjs';
// pi formats --help with ANSI bold when FORCE_COLOR/PTY is inherited. Host
// detection must not change when the caller is attached to a colored terminal.
const ANSI_ESCAPE=new RegExp(String.fromCharCode(27)+'[[]'+'[0-?]*'+'[ -/]*'+'[@-~]','g');
const plain=value=>String(value||'').replace(ANSI_ESCAPE,'');
export function resolvePiHost(env=process.env) {
  const explicit=env.ORCH_CLI||env.PI_EXE;
  const candidates=explicit?[path.resolve(explicit)]:String(env.PATH||env.Path||'').split(path.delimiter).flatMap(dir=>['pi.exe','pi.cmd','pi'].map(n=>path.join(dir,n)));
  const rejected=[];
  for(const file of [...new Set(candidates)]) {
    if(!fs.existsSync(file)||!fs.statSync(file).isFile())continue;
    let bin=file,prefixArgs=[];
    if(!/\.exe$/i.test(file)) {
      let entry=/\.[cm]?js$/i.test(file)?file:null;
      if(!entry){const shim=fs.readFileSync(file,'utf8');const match=shim.match(/node_modules[\\/](@(?:earendil-works|mariozechner))[\\/]pi-coding-agent[\\/](dist[\\/](?:bundle[\\/])?cli\.js)/);if(match)entry=path.join(path.dirname(file),'node_modules',match[1],'pi-coding-agent',...match[2].split(/[\\/]/));}
      if(!entry||!fs.existsSync(entry))continue;
      const sibling=path.join(path.dirname(file),'node.exe');bin=fs.existsSync(sibling)?sibling:process.execPath;prefixArgs=[entry];
    }
    const label=[bin,...prefixArgs].join(' ');
    const help=probeCli(bin,[...prefixArgs,'--help'],{env});
    const helpText=plain(help.out);
    if(help.status!==0||!helpText.includes('pi - AI coding assistant')||!['--session','--extension','--approve'].every(flag=>helpText.includes(flag))){rejected.push(`${label}: --help ${help.error?'probe error '+help.error:'exit '+help.status+'; banner/flags mismatch'}`);continue;}
    const versionResult=probeCli(bin,[...prefixArgs,'--version'],{env});
    const version=plain(versionResult.out).trim();if(versionResult.status!==0||!/^\d+\.\d+\.\d+$/.test(version)){rejected.push(`${label}: --version ${versionResult.error?'probe error '+versionResult.error:'exit '+versionResult.status+'; unusable output '+JSON.stringify(version.slice(0,120))}`);continue;}
    const [major,minor,patch]=version.split('.').map(Number);if(major===0&&(minor<84||(minor===84&&patch<4))){rejected.push(`${label}: version ${version} below floor 0.84.4`);continue;}
    return {agent:'pi',config:{id:'pi',label:'pi agent',version,bin,prefixArgs,available:true,native:prefixArgs.length===0,modelEnv:'ORCH_MODEL',effortEnv:'ORCH_EFFORT'}};
  }
  throw new Error(`CLI_MISSING: pi; no supported installed pi CLI found. No fallback or automatic install. Tried: ${rejected.join(' | ')||'no candidate found on disk'}`);
}
export function piArgs(config,{model,effort}={}) {
  return [...(config.prefixArgs||[]),'--approve','--offline',...(model?['--model',model]:[]),...(effort?['--thinking',effort]:[])];
}
