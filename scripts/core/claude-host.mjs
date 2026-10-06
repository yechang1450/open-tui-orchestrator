import fs from 'node:fs';
import path from 'node:path';
import {probeCli} from './host-probe.mjs';
const HELP_FLAGS=['--print','--dangerously-skip-permissions','--model','--effort'];
export function resolveClaudeHost(env=process.env) {
  const explicit=env.ORCH_CLI||env.CLAUDE_EXE;
  const candidates=explicit?[path.resolve(explicit)]:[
    ...String(env.PATH||env.Path||'').split(path.delimiter).filter(Boolean).flatMap(dir=>['claude.exe','claude.cmd','claude'].map(n=>path.join(dir,n))),
  ];
  const rejected=[];
  for(const file of [...new Set(candidates)]) {
    if(!fs.existsSync(file)||!fs.statSync(file).isFile())continue;
    let bin=file,prefixArgs=[];
    if(!/\.exe$/i.test(file)) {
      if(/\.[cm]?js$/i.test(file)) {
        const sibling=path.join(path.dirname(file),'node.exe');bin=fs.existsSync(sibling)?sibling:process.execPath;prefixArgs=[file];
      } else {
        // npm/shell shim (`claude`, `claude.cmd`) -> resolve the packaged claude.exe.
        let entry=null;
        try {
          const shim=fs.readFileSync(file,'utf8');
          const match=shim.match(/node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]bin[\\/]claude\.exe/i);
          if(match)entry=path.join(path.dirname(file),match[0]);
        } catch { /* not a text shim */ }
        if(!entry||!fs.existsSync(entry))continue;
        bin=entry;
      }
    }
    const label=[bin,...prefixArgs].join(' ');
    const help=probeCli(bin,[...prefixArgs,'--help'],{env});
    const missing=HELP_FLAGS.filter(f=>!help.out.includes(f));
    if(help.status!==0||missing.length){rejected.push(`${label}: --help ${help.error?'probe error '+help.error:'exit '+help.status}${missing.length?'; missing '+missing.join(' '):''}`);continue;}
    const versionResult=probeCli(bin,[...prefixArgs,'--version'],{env});
    const version=/^(\d+\.\d+\.\d+)/.exec(versionResult.stdout.trim())?.[1];
    if(versionResult.status!==0||!version){rejected.push(`${label}: --version ${versionResult.error?'probe error '+versionResult.error:'exit '+versionResult.status+'; unusable output '+JSON.stringify(versionResult.stdout.trim().slice(0,120))}`);continue;}
    return {agent:'claude',config:{id:'claude',label:'Claude Code CLI',version,bin,prefixArgs,available:true,native:prefixArgs.length===0,completionMarker:'__ORCH_DONE__',modelEnv:'ORCH_MODEL',effortEnv:'ORCH_EFFORT'}};
  }
  throw new Error(`CLI_MISSING: claude; no supported installed Claude Code CLI found. No fallback or automatic install. Tried: ${rejected.join(' | ')||'no candidate found on disk'}`);
}
// Base argv for `claude -p` (print mode, non-interactive; the orchestrator has
// already normalized authorization, so permission prompts are skipped). The
// prompt is appended by the caller right after -p, mirroring the kimi adapter.
export function claudeArgs(config,{model,effort}={}) {
  const hasEffort=effort&&String(effort).trim()&&!/\s/.test(String(effort));
  return [...(config.prefixArgs||[]),
    '--dangerously-skip-permissions',
    ...(model&&String(model).trim()&&!/\s/.test(String(model))?['--model',String(model).trim()]:[]),
    ...(hasEffort?['--effort',String(effort).trim()]:[]),
    '-p'];
}
