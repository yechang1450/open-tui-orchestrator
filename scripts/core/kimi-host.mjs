import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
export function resolveKimiHost(env=process.env) {
  const explicit=env.ORCH_CLI||env.KIMI_EXE;
  const candidates=explicit?[path.resolve(explicit)]:[
    ...String(env.PATH||env.Path||'').split(path.delimiter).filter(Boolean).flatMap(dir=>['kimi.exe','kimi.cmd','kimi'].map(n=>path.join(dir,n))),
    ...(env.USERPROFILE?[path.join(env.USERPROFILE,'.kimi-code','bin','kimi.exe')]:[]),
  ];
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
    const help=spawnSync(bin,[...prefixArgs,'--help'],{env,encoding:'utf8',windowsHide:true,shell:false,timeout:10000});
    const helpOut=String((help.stdout||'')+(help.stderr||''));
    if(help.status!==0||!['--prompt','--output-format','--auto'].every(f=>helpOut.includes(f)))continue;
    const versionResult=spawnSync(bin,[...prefixArgs,'--version'],{env,encoding:'utf8',windowsHide:true,shell:false,timeout:10000});
    const version=String(versionResult.stdout||'').trim();if(versionResult.status!==0||!/^\d+\.\d+\.\d+$/.test(version))continue;
    return {agent:'kimi',config:{id:'kimi',label:'Kimi Code CLI',version,bin,prefixArgs,available:true,native:prefixArgs.length===0,completionMarker:'__ORCH_DONE__',modelEnv:'ORCH_MODEL'}};
  }
  throw new Error('CLI_MISSING: kimi; no supported installed Kimi Code CLI found. No fallback or automatic install.');
}
// Base argv for `kimi -p` (print mode auto-approves routine tool calls per product
// contract; --prompt cannot combine with --auto/--yolo). The prompt itself is
// appended by the caller as the final argv element.
export function kimiArgs(config,{model}={}) {
  return [...(config.prefixArgs||[]),'-p',...(model&&String(model).trim()&&!/\s/.test(String(model))?['-m',String(model).trim()]:[])];
}
