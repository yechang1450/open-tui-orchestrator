import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

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
    const help = spawnSync(bin, [...prefixArgs, '--help'], {env, encoding:'utf8', windowsHide:true, shell:false, timeout:10000});
    const helpOut = String((help.stdout || '') + (help.stderr || ''));
    if (help.status !== 0 || !/run opencode with a message/.test(helpOut)) continue;
    const runHelp = spawnSync(bin, [...prefixArgs, 'run', '--help'], {env, encoding:'utf8', windowsHide:true, shell:false, timeout:10000});
    const runHelpOut = String((runHelp.stdout || '') + (runHelp.stderr || ''));
    if (runHelp.status !== 0 || !['--interactive', '--auto', '--dir'].every((f) => runHelpOut.includes(f))) continue;
    const versionResult = spawnSync(bin, [...prefixArgs, '--version'], {env, encoding:'utf8', windowsHide:true, shell:false, timeout:10000});
    const version = String((versionResult.stdout || '') + (versionResult.stderr || '')).trim().split(/\s+/)[0];
    if (versionResult.status !== 0 || !version) continue;
    return {agent:'opencode', config:{id:'opencode', label:'opencode', version, bin, prefixArgs, available:true, native:prefixArgs.length===0, completionMarker:'__ORCH_DONE__', modelEnv:'ORCH_MODEL', effortEnv:'ORCH_EFFORT'}};
  }
  throw new Error('CLI_MISSING: opencode; no supported installed opencode CLI found. No fallback or automatic install.');
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