import fs from 'node:fs';
import path from 'node:path';
import {probeCli} from './host-probe.mjs';
const HELP_FLAGS=['--prompt','--output-format','--auto'];
export function resolveKimiHost(env=process.env) {
  const explicit=env.ORCH_CLI||env.KIMI_EXE;
  const candidates=explicit?[path.resolve(explicit)]:[
    ...String(env.PATH||env.Path||'').split(path.delimiter).filter(Boolean).flatMap(dir=>['kimi.exe','kimi.cmd','kimi'].map(n=>path.join(dir,n))),
    ...(env.USERPROFILE?[path.join(env.USERPROFILE,'.kimi-code','bin','kimi.exe')]:[]),
  ];
  const rejected=[];
  for(const file of [...new Set(candidates)]) {
    if(!fs.existsSync(file)||!fs.statSync(file).isFile())continue;
    let bin=file,prefixArgs=[];
    if(!/\.exe$/i.test(file)) {
      if(/\.[cm]?js$/i.test(file)) {
        const sibling=path.join(path.dirname(file),'node.exe');bin=fs.existsSync(sibling)?sibling:process.execPath;prefixArgs=[file];
      } else {
        // The extensionless native launcher sits next to kimi.exe; prefer the explicit exe.
        const sibling=path.join(path.dirname(file),'kimi.exe');if(!fs.existsSync(sibling))continue;bin=sibling;
      }
    }
    const label=[bin,...prefixArgs].join(' ');
    const help=probeCli(bin,[...prefixArgs,'--help'],{env});
    const missing=HELP_FLAGS.filter(f=>!help.out.includes(f));
    if(help.status!==0||missing.length){rejected.push(`${label}: --help ${help.error?'probe error '+help.error:'exit '+help.status}${missing.length?'; missing '+missing.join(' '):''}`);continue;}
    const versionResult=probeCli(bin,[...prefixArgs,'--version'],{env});
    const version=versionResult.stdout.trim();
    if(versionResult.status!==0||!/^\d+\.\d+\.\d+$/.test(version)){rejected.push(`${label}: --version ${versionResult.error?'probe error '+versionResult.error:'exit '+versionResult.status+'; unusable output '+JSON.stringify(version.slice(0,120))}`);continue;}
    return {agent:'kimi',config:{id:'kimi',label:'Kimi Code CLI',version,bin,prefixArgs,available:true,native:prefixArgs.length===0,completionMarker:'__ORCH_DONE__',modelEnv:'ORCH_MODEL'}};
  }
  throw new Error(`CLI_MISSING: kimi; no supported installed Kimi Code CLI found. No fallback or automatic install. Tried: ${rejected.join(' | ')||'no candidate found on disk'}`);
}
// Base argv for `kimi -p` (print mode auto-approves routine tool calls per product
// contract; --prompt cannot combine with --auto/--yolo). The prompt itself is
// appended by the caller as the final argv element. `-m` MUST precede `-p`: kimi's
// parser binds `-p`'s value greedily, so `-p -m <model> <prompt>` mis-parses the
// model as a positional subcommand ("unknown command '<model>'").
export function kimiArgs(config,{model}={}) {
  return [...(config.prefixArgs||[]),...(model&&String(model).trim()&&!/\s/.test(String(model))?['-m',String(model).trim()]:[]),'-p'];
}
