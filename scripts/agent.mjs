// agent.mjs — Agent abstraction + local cache (generic host-agent detection)
// 说明：本模块负责识别【发起对话的宿主 agent】，检测其 CLI，需要时自动安装，并把结果缓存到
//      稳定家目录（.agent-cache.json）。通用本体：用什么 agent 调用，就用哪个 agent 的 CLI 弹窗。
//      没有 CLI 形态的 agent -> 明确报“不支持”，绝不静默回退 codex。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 通用化：agent 配置缓存放稳定家目录（ORCH_STATE_DIR / CODEX_HOME），绝不落插件自身目录（会被 cachebuster 清掉）。
// 优先 ORCH_STATE_DIR，其次 CODEX_HOME/orchestrator，最后回退 ~/.codex/orchestrator。
function cacheDir() {
  return process.env.ORCH_STATE_DIR
    || (process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'orchestrator') : path.join(os.homedir(), '.codex', 'orchestrator'));
}
function cacheFile() { return path.join(cacheDir(), '.agent-cache.json'); }

// agent 描述表：native=true 走内置（codex 用 @openai/codex-sdk）；其余为外部 CLI。
// hasCliForm=true => 有 CLI 形态（未装可自动装）；false => 无 CLI 形态（如 gemini/aichat/workbudy），不支持。
// installCmd 仅在 hasCliForm 且 bin 缺失时执行；verified=true 表示作者实测过（codex/pi/openclaw）。
export const AGENTS = {
  codex:    { id: 'codex',    label: 'Codex CLI',           detectBin: ['codex'],    procName: ['codex'],    modelEnv: 'ORCH_MODEL',    effortEnv: 'ORCH_EFFORT',    completionMarker: '__ORCH_DONE__', native: true,  verified: true,  hasCliForm: true,  installCmd: ['npm', 'install', '-g', '@openai/codex'] },
  claude:   { id: 'claude',   label: 'Claude Code',         detectBin: ['claude'],   procName: ['claude'],   modelEnv: 'ANTHROPIC_MODEL', effortEnv: 'ORCH_CLAUD_EFFORT', completionMarker: '__ORCH_DONE__', native: false, verified: false, hasCliForm: true,  installCmd: ['npm', 'install', '-g', '@anthropic-ai/claude-code'] },
  opencode: { id: 'opencode', label: 'OpenCode',            detectBin: ['opencode'], procName: ['opencode'], modelEnv: 'OPENCODE_MODEL', effortEnv: 'ORCH_OPENCODE_EFFORT', completionMarker: '__ORCH_DONE__', native: false, verified: false, hasCliForm: true,  installCmd: ['npm', 'install', '-g', 'opencode-ai'] },
  cursor:   { id: 'cursor',   label: 'Cursor CLI',          detectBin: ['cursor-agent', 'cursor'], procName: ['cursor-agent', 'cursor'], modelEnv: 'CURSOR_MODEL', effortEnv: 'ORCH_CURSOR_EFFORT', completionMarker: '__ORCH_DONE__', native: false, verified: false, hasCliForm: true,  installCmd: ['npm', 'install', '-g', '@cursor-ai/cursor-agent'] },
  qwen:     { id: 'qwen',     label: 'Qwen Code',           detectBin: ['qwen'],     procName: ['qwen'],     modelEnv: 'QWEN_MODEL',    effortEnv: 'ORCH_QWEN_EFFORT',    completionMarker: '__ORCH_DONE__', native: false, verified: false, hasCliForm: true,  installCmd: ['npm', 'install', '-g', '@qwen-code/cli'] },
  pi:       { id: 'pi',       label: 'Pi (pi-coding-agent)', detectBin: ['pi'],     procName: ['pi'],       modelEnv: 'PI_MODEL',     effortEnv: 'ORCH_PI_EFFORT',     completionMarker: '__ORCH_DONE__', native: false, verified: true,  hasCliForm: true,  installCmd: ['npm', 'install', '-g', 'pi-coding-agent'] },
  zcode:    { id: 'zcode',    label: 'ZCode CLI',           detectBin: ['zcode-cli', 'zcode'], procName: ['zcode-cli', 'zcode'], modelEnv: 'ZCODE_MODEL', effortEnv: 'ORCH_ZCODE_EFFORT', completionMarker: '__ORCH_DONE__', native: false, verified: false, hasCliForm: true,  installCmd: ['npm', 'install', '-g', '@zcode/cli'] },
  aider:    { id: 'aider',    label: 'Aider',               detectBin: ['aider'],    procName: ['aider'],    modelEnv: 'AIDER_MODEL',  effortEnv: 'ORCH_AIDER_EFFORT',  completionMarker: '__ORCH_DONE__', native: false, verified: false, hasCliForm: true,  installCmd: ['pip', 'install', 'aider-chat'] },
  codebuddy:{ id: 'codebuddy',label: 'CodeBuddy (WorkBuddy)', detectBin: ['codebuddy'], procName: ['codebuddy'], modelEnv: 'CODEBUDDY_MODEL', effortEnv: 'ORCH_CODEBUDDY_EFFORT', completionMarker: '__ORCH_DONE__', native: false, verified: false, hasCliForm: true,  installCmd: ['npm', 'install', '-g', 'codebuddy'] },
  openclaw: { id: 'openclaw', label: 'OpenClaw (gateway)', detectBin: ['openclaw'], procName: ['openclaw'], modelEnv: 'OPENCLAW_MODEL', effortEnv: 'ORCH_OPENCLAW_EFFORT', completionMarker: '__ORCH_DONE__', native: false, verified: true,  hasCliForm: true,  installCmd: ['npm', 'install', '-g', 'openclaw'] },
};

function readCache() {
  try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { return {}; }
}
function writeCache(c) {
  try { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(cacheFile(), JSON.stringify(c, null, 2) + '\n', 'utf8'); } catch {}
}

function binAvailable(bin) {
  if (!bin) return false;
  try {
    const attempt = (shell) => spawnSync(bin, ['--version'], { shell, encoding: 'utf8', timeout: 8000, windowsHide: true });
    const r0 = attempt(false);
    if (!r0.error && r0.status === 0) return true;
    if (process.platform === 'win32') {
      const r1 = attempt(true);
      if (!r1.error && r1.status === 0) return true;
    }
    return false;
  } catch { return false; }
}

function procNameAvailable(pat) {
  try {
    // 探测宿主进程树前先做轻量进程表快照（Windows 用 wmic/tasklist；Unix 用 ps）。仅用于识别宿主 agent。
    let text = '';
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      text = (r.stdout || '') + (r.stderr || '');
    } else {
      const r = spawnSync('ps', ['-e', '-o', 'comm='], { encoding: 'utf8', timeout: 8000 });
      text = (r.stdout || '') + (r.stderr || '');
    }
    return new RegExp(pat, 'i').test(text);
  } catch { return false; }
}

// 自动安装 CLI（仅 hasCliForm 且 bin 缺失时）。返回是否成功。
function autoInstall(desc) {
  if (!desc.hasCliForm || !desc.installCmd || !desc.installCmd.length) return false;
  try {
    const [cmd, ...rest] = desc.installCmd;
    const r = spawnSync(cmd, rest, { encoding: 'utf8', timeout: 300000, windowsHide: true });
    return !r.error && r.status === 0;
  } catch { return false; }
}

// 识别宿主 agent：ORCH_AGENT env 优先；否则遍历父进程树匹配已知 agent 的可执行名；否则缺省 codex。
function detectHostAgent() {
  const requested = String(process.env.ORCH_AGENT || '').trim().toLowerCase();
  if (requested && AGENTS[requested]) return requested;
  // 父进程树探测：向上遍历，匹配 detBin/procName
  let pid = process.pid;
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    if (seen.has(pid)) break;
    seen.add(pid);
    let info = null;
    try {
      if (process.platform === 'win32') {
        const r = spawnSync('wmic', ['process', 'where', 'processid=' + pid, 'get', 'parentprocessid,name,commandline', '/format:csv'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
        const csv = r.stdout || '';
        // csv: Node,ParentProcessId,Name,CommandLine,ProcessId
        const line = csv.split(/\r?\n/).find((l) => l && !/^Node|ParentProcessId|processid|^$/i.test(l.trim()));
        if (line) {
          const parts = line.split(',');
          const name = parts.length > 2 ? parts[2] : '';
          const cmd = parts.length > 3 ? parts[3] : '';
          const ppid = parts.length > 1 ? parts[1] : '';
          info = { name, cmd, ppid };
        }
      } else {
        const r = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 8000 });
        const m = (r.stdout || '').trim().split(/\s+/);
        if (m.length) info = { ppid: m[0], name: m[1] || '', cmd: '' };
      }
    } catch { /* ignore */ }
    // 匹配已知 agent
    const hay = (info ? (info.name + ' ' + (info.cmd || info.ppid || '')) : '').toLowerCase();
    for (const [key, desc] of Object.entries(AGENTS)) {
      const hit = desc.procName.some((n) => hay.includes(n.toLowerCase()));
      if (hit) return key;
    }
    if (info && info.ppid) pid = Number(info.ppid); else break;
  }
  return 'codex';
}

/** 解析生效的 agent：优先 ORCH_AGENT，否则自动探测宿主；bin 缺失且 hasCliForm 则自动装，装不上 fail-closed 明确报错；
 *  无 CLI 形态则明确报“不支持”。绝不回退 codex。 */
export function resolveAgent() {
  const id = detectHostAgent();
  const desc = AGENTS[id];
  const cache = readCache();
  const key = 'agent:' + id;
  const prev = cache[key] || {};
  let bin = prev.bin && binAvailable(prev.bin) ? prev.bin : desc.detectBin.find(binAvailable) || null;

  // 无 CLI 形态：明确不支持（fail-closed）
  if (!desc.hasCliForm && !bin) {
    const msg = '[orchestrator] agent "' + id + '" (' + desc.label + ') 无可用 CLI 形态，不支持 open-tui-orchestrator。';
    console.error(msg);
    process.exitCode = 1;
    return { agent: id, config: { ...desc, bin: null, available: false, error: 'no-cli-form' } };
  }

  // 有 CLI 形态但没装：尝试自动安装
  if (!bin && desc.hasCliForm) {
    console.log('[orchestrator] ' + desc.label + ' CLI 未找到，尝试自动安装 ' + (desc.installCmd || []).join(' ') + ' ...');
    const ok = autoInstall(desc);
    bin = ok ? (desc.detectBin.find(binAvailable) || desc.detectBin[0]) : null;
    if (!bin) {
      // 装不上，fail-closed 明确报错，绝不回退 codex
      const msg = '[orchestrator] ' + desc.label + ' CLI 缺失且自动安装失败，该 agent 暂不支持 open-tui-orchestrator（无回退）。';
      console.error(msg);
      process.exitCode = 1;
      return { agent: id, config: { ...desc, bin: null, available: false, error: 'install-failed' } };
    }
  }

  const resolved = { ...desc, bin, available: !!bin, resolvedAt: prev.resolvedAt || new Date().toISOString() };
  cache[key] = resolved;
  writeCache(cache);
  return { agent: id, config: resolved };
}

export function agentCacheFile() { return cacheFile(); }

// 主流 agent 通用启动参数（按 agent 各自 CLI 拼装；codex 保持原样）。
export function launchArgs(agentConfig, o = {}) {
  const cwd = o.cwd || "";
  const approval = o.approval || "never";
  const sandbox = o.sandbox || "danger-full-access";
  switch (String(agentConfig.id || "")) {
    case "claude": return ["--cwd", cwd];
    case "cursor": return ["--cwd", cwd];
    case "qwen": return ["--cwd", cwd];
    case "pi": return [];
    case "zcode": return ["--cwd", cwd];
    case "aider": return ["--cwd", cwd];
    case "opencode": return ["--cwd", cwd];
    case "codebuddy": return [];
    case "openclaw": return ["agent", "--local"];
    case "codex":
    default: return ["--cd", cwd, "-a", approval, "--sandbox", sandbox];
  }
}
