import fs from 'node:fs';
import path from 'node:path';
import {probeCli} from './host-probe.mjs';
const HELP_FLAGS=['--prompt','--output-format','--auto'];
// kimi 的 --help 是 Rich 的等宽盒式渲染：窗口窄时选项名列会被省略成 `--yolo,--yes,--…`，
// 于是 `--auto` 这种"藏在别名组里"的旗标根本不落到文本上，装上真 CLI 也会被判 CLI_MISSING。
// 2026-09-22 本机 kimi 1.50.0 实测：80 列宽缺 `--auto`、COLUMNS=200 三个旗标全在。
// 探测一律显式给宽列——判据不得随调用方控制台宽度变色。
const WIDE_HELP_COLUMNS='200';
// 版本行可能带标签（kimi 1.50.0 打的是 `kimi, version 1.50.0`，不是裸 semver）：取第一段 semver。
const SEMVER=/(\d+\.\d+\.\d+)/;
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
    const help=probeCli(bin,[...prefixArgs,'--help'],{env:{...env,COLUMNS:WIDE_HELP_COLUMNS}});
    const missing=HELP_FLAGS.filter(f=>!help.out.includes(f));
    if(help.status!==0||missing.length){rejected.push(`${label}: --help ${help.error?'probe error '+help.error:'exit '+help.status}${missing.length?'; missing '+missing.join(' '):''}`);continue;}
    const versionResult=probeCli(bin,[...prefixArgs,'--version'],{env});
    const versionRaw=versionResult.stdout.trim();
    const version=(SEMVER.exec(versionRaw)||[])[1]||'';
    if(versionResult.status!==0||!/^\d+\.\d+\.\d+$/.test(version)){rejected.push(`${label}: --version ${versionResult.error?'probe error '+versionResult.error:'exit '+versionResult.status+'; unusable output '+JSON.stringify(versionRaw.slice(0,120))}`);continue;}
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
