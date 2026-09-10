import fs from 'node:fs';
import path from 'node:path';
import {probeCli} from './host-probe.mjs';

// opencode adapter: resolve the real opencode binary and build window/planner argv.
// Window mode is interactive `opencode run -i --auto` (auto-approves permissions like
// pi's --approve; the orchestrator has already normalized authorization).
export function resolveOpenCodeHost(env = process.env) {
  const explicit = env.ORCH_CLI || env.OPENCODE_EXE;
  const candidates = explicit
    ? [path.resolve(explicit)]
    : String(env.PATH || env.Path || '')
        .split(path.delimiter)
        .flatMap((dir) => ['opencode.exe', 'opencode.cmd', 'opencode'].map((n) => path.join(dir, n)));
  const rejected = [];
  for (const file of [...new Set(candidates)]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    let bin = file;
    let prefixArgs = [];
    if (!/\.exe$/i.test(file)) {
      // npm shim (opencode / opencode.cmd) -> resolve the packaged opencode-ai binary.
      let entry = /\.[cm]?js$/i.test(file) ? file : null;
      if (!entry) {
        try {
          const shim = fs.readFileSync(file, 'utf8');
          const match = shim.match(/node_modules[\\/]opencode-ai[\\/]bin[\\/](opencode\.exe|opencode)/);
          if (match) entry = path.join(path.dirname(file), 'node_modules', 'opencode-ai', 'bin', match[1]);
        } catch {
          /* not a text shim */
        }
      }
      const packaged = path.join(path.dirname(file), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
      entry = [entry, packaged].find((p) => p && fs.existsSync(p));
      if (!entry) continue;
      if (/\.exe$/i.test(entry)) {
        bin = entry;
      } else {
        const sibling = path.join(path.dirname(file), 'node.exe');
        bin = fs.existsSync(sibling) ? sibling : process.execPath;
        prefixArgs = [entry];
      }
    }
    const label = [bin, ...prefixArgs].join(' ');
    const help = probeCli(bin, [...prefixArgs, '--help'], {env});
    if (help.status !== 0 || !/run opencode with a message/.test(help.out)) { rejected.push(`${label}: --help ${help.error ? 'probe error ' + help.error : 'exit ' + help.status + '; banner mismatch'}`); continue; }
    const runHelp = probeCli(bin, [...prefixArgs, 'run', '--help'], {env});
    if (runHelp.status !== 0 || !['--interactive', '--auto', '--dir'].every((f) => runHelp.out.includes(f))) { rejected.push(`${label}: run --help ${runHelp.error ? 'probe error ' + runHelp.error : 'exit ' + runHelp.status + '; flags mismatch'}`); continue; }
    const versionResult = probeCli(bin, [...prefixArgs, '--version'], {env});
    const version = versionResult.out.trim().split(/\s+/)[0];
    if (versionResult.status !== 0 || !version) { rejected.push(`${label}: --version ${versionResult.error ? 'probe error ' + versionResult.error : 'exit ' + versionResult.status + '; unusable output'}`); continue; }
    return {agent:'opencode', config:{id:'opencode', label:'opencode', version, bin, prefixArgs, available:true, native:prefixArgs.length===0, completionMarker:'__ORCH_DONE__', modelEnv:'ORCH_MODEL', effortEnv:'ORCH_EFFORT'}};
  }
  throw new Error(`CLI_MISSING: opencode; no supported installed opencode CLI found. No fallback or automatic install. Tried: ${rejected.join(' | ') || 'no candidate found on disk'}`);
}

// Base argv for an opencode run. The interactive window uses `run -i --auto --dir <cwd>`.
export function opencodeArgs(config, {model, effort, cwd} = {}) {
  return [
    ...(config.prefixArgs || []),
    'run',
    '-i',
    '--auto',
    '--dir',
    cwd || process.cwd(),
    ...(model && String(model).trim() && !/\s/.test(String(model)) ? ['--model', String(model).trim()] : []),
  ];
}

// Planner argv: headless, JSON events, no interactive mode.
export function opencodePlannerArgs(config, {model, cwd} = {}) {
  return [
    ...(config.prefixArgs || []),
    'run',
    '--format',
    'json',
    '--dir',
    cwd || process.cwd(),
    ...(model && String(model).trim() && !/\s/.test(String(model)) ? ['--model', String(model).trim()] : []),
  ];
}
