import fs from 'node:fs';
import { networkArgs } from './network-policy.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {resolvePiHost,piArgs} from './pi-host.mjs';
import {resolveOpenClawHost} from './openclaw-host.mjs';
import {resolveOpenCodeHost,opencodeArgs} from './opencode-host.mjs';
import {resolveKimiHost,kimiArgs} from './kimi-host.mjs';
import {resolveClaudeHost,claudeArgs} from './claude-host.mjs';

// Adapter contract: resolve a real CLI before any planner/window is started.
// Additional adapters must implement planning, interactive argv and completion
// capture together; a CLI name alone is not proof of compatibility.
export const adapters = Object.freeze({
  openclaw: Object.freeze({id:'openclaw',label:'OpenClaw CLI',native:false}),
  pi: Object.freeze({id:'pi',label:'pi agent',native:false,completionMarker:'__ORCH_DONE__',verified:false}),
  opencode: Object.freeze({id:'opencode',label:'opencode',native:false,completionMarker:'__ORCH_DONE__',verified:false}),
  kimi: Object.freeze({id:'kimi',label:'Kimi Code CLI',native:true,completionMarker:'__ORCH_DONE__',verified:false}),
  claude: Object.freeze({id:'claude',label:'Claude Code CLI',native:true,completionMarker:'__ORCH_DONE__',verified:false}),
  codex: Object.freeze({ id: 'codex', label: 'Codex CLI', native: true,
    modelEnv: 'ORCH_MODEL', effortEnv: 'ORCH_EFFORT',
    completionMarker: '__ORCH_DONE__', verified: false }),
});

// Host markers on the Windows ancestor chain: the initiating agent is the
// NEAREST ancestor process matching a known CLI (a nested window that starts
// its own orchestration therefore binds to its own agent, not the outer one).
const HOST_CHAIN_MATCHERS = Object.freeze([
  ['kimi', Object.freeze({ name: /^kimi\.exe$/i })],
  ['claude', Object.freeze({ name: /^claude\.exe$/i, cmd: /[\\/]@anthropic-ai[\\/]claude-code[\\/]/i })],
  ['codex', Object.freeze({ name: /^codex\.exe$/i, cmd: /[\\/]codex\.js([\s"']|$)|[\\/]@openai[\\/]codex[\\/]/i })],
  ['pi', Object.freeze({ cmd: /[\\/]pi-coding-agent[\\/]/i })],
  ['opencode', Object.freeze({ name: /^opencode\.exe$/i, cmd: /[\\/]opencode-ai[\\/]/i })],
  ['openclaw', Object.freeze({ name: /^openclaw(\.exe)?$/i, cmd: /[\\/]openclaw[\\/]openclaw\.mjs/i })],
]);

export function detectHostFromChain(chain) {
  for (const proc of chain || []) {
    const name = String(proc?.name || '');
    const cmd = String(proc?.cmdline ?? proc?.commandLine ?? '');
    for (const [id, m] of HOST_CHAIN_MATCHERS) {
      if ((m.name && m.name.test(name)) || (m.cmd && m.cmd.test(cmd))) return id;
    }
  }
  return null;
}

// One CIM snapshot walked in memory (a single PowerShell call, ~1s). Only runs
// when no env marker identified the host; failure degrades to an empty chain.
export function hostProcessChain({ platform = process.platform, startPid = process.ppid, env = process.env, spawn = spawnSync } = {}) {
  if (platform !== 'win32') return [];
  const script = '$a=@{};Get-CimInstance Win32_Process|ForEach-Object{$a[[string]$_.ProcessId]=$_};$p=$a[[string]' + (Number(startPid) || 0) + '];$g=0;while($p -and $g -lt 16){$c=if($p.CommandLine){$p.CommandLine}else{""};("{0}`t{1}`t{2}" -f $p.ProcessId,$p.Name,$c);$p=$a[[string]$p.ParentProcessId];$g++}';
  let r;
  try {
    const ps = path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    r = spawn(fs.existsSync(ps) ? ps : 'powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 8000 });
  } catch { return []; }
  if (r?.status !== 0) return [];
  return String(r.stdout || '').split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, name, ...rest] = line.split('\t');
    return { pid: Number(pid), name, cmdline: rest.join('\t') };
  });
}

export function detectHostAgent(env = process.env, { chain } = {}) {
  const explicit = String(env.ORCH_AGENT || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return 'codex';
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  const detected = detectHostFromChain(chain ?? hostProcessChain({ env }));
  if (detected) return detected;
  throw new Error('HOST_UNKNOWN: set ORCH_AGENT to the initiating agent; no Codex fallback.');
}

export function cliCandidates(env = process.env, platform = process.platform, {where = spawnSync} = {}) {
  const explicit = env.ORCH_CLI || env.CODEX_EXE;
  if (explicit) return [path.resolve(explicit)];
  const found = [];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    found.push(path.join(dir, platform === 'win32' ? 'codex.exe' : 'codex'));
    // npm shims are not native executables; the SDK must receive the packaged binary.
    const modules = path.join(dir, 'node_modules', '@openai');
    for (const base of [path.join(modules, 'codex', 'vendor'),
      path.join(modules, 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor'),
      path.join(modules, 'codex-win32-x64', 'vendor'),
      path.join(modules, 'codex', 'node_modules', '@openai', 'codex-win32-arm64', 'vendor')]) {
      for (const triple of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']) {
        found.push(path.join(base, triple, 'codex', 'codex.exe'));
      }
    }
  }
  // Some desktop hosts expose neither PATH nor Path to a child process even
  // though the native Codex installation is registered. Ask the Windows
  // resolver for codex.exe in that case; this never installs or selects a shim.
  if (platform === 'win32' && !found.some(file => { try { return fs.existsSync(file); } catch { return false; } })) {
    try {
      const whereExe = path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'where.exe');
      const result = where(whereExe, ['codex.exe'], {encoding:'utf8', windowsHide:true, shell:false, timeout:8000});
      if (result?.status === 0) for (const line of String(result.stdout || '').split(/\r?\n/)) {
        const candidate = line.trim();
        if (candidate) found.push(candidate);
      }
    } catch { /* resolveHost reports CLI_MISSING if the native resolver is unavailable */ }
  }
  return [...new Set(found)];
}

export function resolveHost({ env = process.env, agent, candidates = cliCandidates,
  probe = (file) => {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    const result = spawnSync(file, ['--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 8000, shell: false,
    });
    return result.status === 0 && /^codex-cli\s/m.test(result.stdout || '');
  } } = {}) {
  const id = agent || detectHostAgent(env);
  if(id==='pi')return resolvePiHost(env);
  if(id==='openclaw')return resolveOpenClawHost(env);
  if(id==='opencode')return resolveOpenCodeHost(env);
  if(id==='kimi')return resolveKimiHost(env);
  if(id==='claude')return resolveClaudeHost(env);
  const adapter = adapters[id];
  if (!adapter) throw new Error(`ADAPTER_UNSUPPORTED: ${id}; no CLI adapter implemented; no fallback or automatic install.`);
  const bin = candidates(env).find(probe);
  if (!bin) throw new Error(`CLI_MISSING: ${id}; install its CLI yourself or set ORCH_CLI to its native executable. No fallback or automatic install.`);
  return { agent: id, config: { ...adapter, bin, available: true } };
}

export function launchArgs(config, options = {}) {
  if(config?.id==='openclaw'){
    if(options.sandbox&&options.sandbox!=='danger-full-access')throw new Error('OPENCLAW_SANDBOX_UNSUPPORTED');
    return [];
  }
  if(config?.id==='pi'){
    if(options.sandbox&&options.sandbox!=='danger-full-access')throw new Error('PI_SANDBOX_UNSUPPORTED: pi does not implement the requested sandbox');
    return piArgs(config,{model:process.env.ORCH_MODEL,effort:process.env.ORCH_EFFORT});
  }
  if(config?.id==='opencode'){
    if(options.sandbox&&options.sandbox!=='danger-full-access')throw new Error('OPENCODE_SANDBOX_UNSUPPORTED: opencode does not implement the requested sandbox');
    return opencodeArgs(config,{model:process.env.ORCH_MODEL,effort:process.env.ORCH_EFFORT,cwd:options.cwd||process.cwd()});
  }
  if(config?.id==='kimi'){
    if(options.sandbox&&options.sandbox!=='danger-full-access')throw new Error('KIMI_SANDBOX_UNSUPPORTED: kimi does not implement the requested sandbox');
    return kimiArgs(config,{model:process.env.ORCH_MODEL});
  }
  if(config?.id==='claude'){
    if(options.sandbox&&options.sandbox!=='danger-full-access')throw new Error('CLAUDE_SANDBOX_UNSUPPORTED: claude does not implement the requested sandbox');
    return claudeArgs(config,{model:process.env.ORCH_MODEL,effort:process.env.ORCH_EFFORT});
  }
  if (!adapters[config?.id]) throw new Error('ADAPTER_UNSUPPORTED: refusing Codex argv for another agent.');
  const cwd = options.cwd || process.cwd();
  const sandbox = options.sandbox || 'danger-full-access';
  // Codex treats --dangerously-bypass-approvals-and-sandbox as a complete
  // authorization envelope and rejects it when -a/--ask-for-approval is also
  // supplied. Keep the explicit no-approval flag only for restricted modes.
  const args = ['--cd', cwd];
  if (sandbox === 'danger-full-access') args.push('--sandbox', sandbox);
  else args.push('-a', 'never', '--sandbox', sandbox);
  // The orchestrator has already received the initiating window's effective
  // authorization and normalizes it to never + danger-full-access. Carry that
  // envelope into Codex so project trust and command confirmations cannot stop
  // an authorized TUI window at startup. Restricted callers keep their policy.
  if (sandbox === 'danger-full-access') args.push('--dangerously-bypass-approvals-and-sandbox');
  args.push('-c', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`, ...networkArgs());
  return args;
}
