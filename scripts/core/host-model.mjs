// 发起窗 model/thinking level 继承：检测「发起本 orchestrator 的那个 TUI 窗口」当前实际使用的
// model 与 thinking effort，让发起的子窗与发起窗保持一致（宿主自适应的延伸：同窗即同 agent，
// 取值逐字透传，无需跨 agent 映射）。
//
// 检测数据源（全部本地只读，任何一步失败都降级而非抛错）：
//   codex    — CODEX_THREAD_ID 定位当日 rollout jsonl，取最后出现的 "model"/"reasoning_effort"；
//              回退 ~/.codex/config.toml 的 model / model_reasoning_effort。
//   kimi     — ~/.kimi-code/sessions/<wd_*>/session_*/state.json 按 cwd 匹配、updatedAt 最新者
//              认定为发起会话，读其 agents/main/wire.jsonl 尾部最后一条 llm.request 的
//              modelAlias/thinkingEffort；回退 config.toml 的 default_model / [thinking].effort。
//   pi       — ~/.pi/agent/settings.json 的 defaultModel / defaultThinkingLevel。
//   opencode — ~/.config/opencode/opencode.json(c) 顶层 model；opencode 无 effort 概念。
//
// 优先级：显式 ORCH_MODEL / ORCH_EFFORT 环境变量 > 本模块检测值 > CLI 自身默认。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadProfile} from './print-profile.mjs';

// 合法 model/effort 值绝不含空白与引号；脏值一律丢弃（下游会拼进 ps1/argv，防注入）。
function clean(v) {
  const s = String(v ?? '').trim();
  return s && !/[\s"']/.test(s) ? s : null;
}

function readTailLines(file, bytes = 262144) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    if (!size) return [];
    fd = fs.openSync(file, 'r');
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8').split(/\r?\n/);
  } catch { return []; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

// 从后往前扫 JSONL 行，返回最后一条满足 test(line) 的可解析记录；末行可能正在写入，解析失败即跳过。
function lastJsonlRecord(lines, test) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !test(line)) continue;
    try { return JSON.parse(line); } catch { /* 半行/坏行跳过 */ }
  }
  return null;
}

function lastMatch(text, re) {
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return clean(last);
}

function parseTomlScalar(text, key) {
  const m = new RegExp('^' + key + '\\s*=\\s*"([^"]+)"', 'm').exec(text);
  return clean(m && m[1]);
}

// ---------------------------------------------------------------- codex ----
function codexRolloutFile(sessionsDir, threadId) {
  // sessions/<YYYY>/<MM>/<DD>/rollout-*<threadId>.jsonl；目录名可字典序倒排，发起会话必在最近几天。
  let years = [];
  try { years = fs.readdirSync(sessionsDir).filter((d) => /^\d{4}$/.test(d)).sort().reverse(); } catch { return null; }
  outer: for (const y of years.slice(0, 1)) {
    let months = [];
    try { months = fs.readdirSync(path.join(sessionsDir, y)).filter((d) => /^\d{2}$/.test(d)).sort().reverse(); } catch { continue; }
    for (const mo of months.slice(0, 2)) {
      let days = [];
      try { days = fs.readdirSync(path.join(sessionsDir, y, mo)).filter((d) => /^\d{2}$/.test(d)).sort().reverse(); } catch { continue; }
      for (const d of days.slice(0, 4)) {
        const dir = path.join(sessionsDir, y, mo, d);
        let files = [];
        try { files = fs.readdirSync(dir); } catch { continue; }
        const hit = files.find((f) => f.includes(threadId) && f.endsWith('.jsonl'));
        if (hit) return path.join(dir, hit);
      }
    }
    break outer; // 只查最近一个年份目录
  }
  return null;
}

function detectCodex({ env, codexHome }) {
  const home = codexHome || env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const tid = clean(env.CODEX_THREAD_ID) || clean(env.CODEX_SESSION_ID);
  let model = null, effort = null, source = null;
  if (tid) {
    const file = codexRolloutFile(path.join(home, 'sessions'), tid);
    if (file) {
      const tail = readTailLines(file).join('\n');
      model = lastMatch(tail, /"model":"([^"]+)"/g);
      effort = lastMatch(tail, /"reasoning_effort":"([^"]+)"/g);
      if (model || effort) source = 'codex-rollout';
    }
  }
  if (!model || !effort) {
    try {
      const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
      if (!model) model = parseTomlScalar(toml, 'model');
      if (!effort) effort = parseTomlScalar(toml, 'model_reasoning_effort');
      if ((model || effort) && !source) source = 'codex-config';
    } catch { /* 无 config.toml 就算了 */ }
  }
  return model || effort ? { model, effort, source } : null;
}

// ----------------------------------------------------------------- kimi ----
function kimiHostSession(sessionsRoot, cwd) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const want = norm(cwd);
  let best = null;
  let wds = [];
  try { wds = fs.readdirSync(sessionsRoot); } catch { return null; }
  for (const wd of wds) {
    const wdDir = path.join(sessionsRoot, wd);
    let sessions = [];
    try { sessions = fs.readdirSync(wdDir); } catch { continue; }
    for (const s of sessions) {
      const stateFile = path.join(wdDir, s, 'state.json');
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (norm(state.cwd) !== want) continue;
        const at = Number(state.updatedAt) || 0;
        if (!best || at > best.at) best = { at, dir: path.join(wdDir, s) };
      } catch { /* 坏 state.json 跳过 */ }
    }
  }
  return best && best.dir;
}

function detectKimi({ cwd, kimiHome, env = process.env }) {
  const home = kimiHome || env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  let model = null, effort = null, source = null;
  const sessionDir = cwd && kimiHostSession(path.join(home, 'sessions'), cwd);
  if (sessionDir) {
    const rec = lastJsonlRecord(
      readTailLines(path.join(sessionDir, 'agents', 'main', 'wire.jsonl')),
      (line) => line.includes('"llm.request"'),
    );
    if (rec) {
      model = clean(rec.modelAlias) || clean(rec.model);
      effort = clean(rec.thinkingEffort);
      if (model || effort) source = 'kimi-wire';
    }
  }
  if (!model || !effort) {
    try {
      const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
      if (!model) model = parseTomlScalar(toml, 'default_model');
      if (!effort) {
        const sec = /\[thinking\]([^\[]*)/.exec(toml);
        if (sec) effort = parseTomlScalar(sec[1], 'effort');
      }
      if ((model || effort) && !source) source = 'kimi-config';
    } catch { /* ignore */ }
  }
  return model || effort ? { model, effort, source } : null;
}

// ------------------------------------------------------------------- pi ----
function detectPi({ piHome }) {
  const home = piHome || path.join(os.homedir(), '.pi');
  try {
    const s = JSON.parse(fs.readFileSync(path.join(home, 'agent', 'settings.json'), 'utf8'));
    const raw = clean(s.defaultModel);
    const provider = clean(s.defaultProvider);
    // pi 的模型规格是 `provider/model`；settings 把两者分开存。只把裸名递给 pi，多 provider 同时
    // authenticated 时它会报 "Model "x" is ambiguous across providers" 并 exit 1（2026-09-17 实测：
    // defaultProvider=opencode-go-0 + defaultModel=deepseek-flash，窗口里 pi 直接退出、块判失败）。
    const model = raw && provider && !raw.includes('/') ? `${provider}/${raw}` : raw;
    const effort = clean(s.defaultThinkingLevel);
    return model || effort ? { model, effort, source: 'pi-settings' } : null;
  } catch { return null; }
}

// ------------------------------------------------------------- opencode ----
function parseJsonc(text) {
  try { return JSON.parse(text); } catch { /* 继续走清洗 */ }
  const stripped = String(text)
    .split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n')
    .replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(stripped); } catch { return null; }
}

function detectOpenCode({ configHome }) {
  const dir = configHome || path.join(os.homedir(), '.config', 'opencode');
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    try {
      const cfg = parseJsonc(fs.readFileSync(path.join(dir, name), 'utf8'));
      const model = clean(cfg && cfg.model);
      if (model) return { model, effort: null, source: 'opencode-config' };
    } catch { /* 尝试下一个文件名 */ }
  }
  return null;
}

// --------------------------------------------------------------- claude ----
// Claude Code settings: ~/.claude/settings.json 顶层 model（别名或完整 id）；effort 读取
// settings 的 "effort"（存在时）。本机以 env 块接网关时模型在 settings.env.ANTHROPIC_MODEL，
// 一并读取。缺失即 null，绝不猜。
function detectClaude({ claudeHome, env = process.env }) {
  const home = claudeHome || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  for (const name of ['settings.json', path.join('..', '.claude.json')]) {
    try {
      const file = path.join(home, name);
      if (!fs.existsSync(file)) continue;
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const model = clean(cfg && cfg.model) || clean(cfg && cfg.env && cfg.env.ANTHROPIC_MODEL);
      const effort = clean(cfg && cfg.effort);
      if (model || effort) return { model: model || null, effort: effort || null, source: 'claude-settings' };
    } catch { /* try next */ }
  }
  return null;
}

// ------------------------------------------------------------- openclaw ----
// OpenClaw config: ~/.openclaw/openclaw.json 的 agents.defaults.model.primary
// （provider/model 引用）。配置为 JSON5 形态——按 jsonc 预处理后精确读键，缺失即 null。
function detectOpenClaw({ env = process.env } = {}) {
  try {
    const file = env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), '.openclaw', 'openclaw.json');
    if (!fs.existsSync(file)) return null;
    const cfg = parseJsonc(fs.readFileSync(file, 'utf8'));
    const model = clean(cfg && cfg.agents && cfg.agents.defaults && cfg.agents.defaults.model && cfg.agents.defaults.model.primary);
    return model ? { model, effort: null, source: 'openclaw-config' } : null;
  } catch { return null; }
}

// --------------------------------------------------------------- profile ----
// print-class 画像 agent 的 model/effort 探测：由画像的可选 modelDetection 规格描述
// （adapt 自动做精确候选发现，也可手填）。规格形态：
//   modelDetection: { env:["<ID>_MODEL"], config:[{file:"~/.x.conf.yml", modelKey:"model", effortKey:"effort"}] }
// 只读精确键名，绝不猜测；缺失即 null（回退该 CLI 自身默认，或用 ORCH_MODEL/ORCH_EFFORT 显式指定）。
export function readProfileKey(file, key, jsonc) {
  let text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (/\.jsonc$/i.test(file) || jsonc) text = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (/\.jsonc?$/i.test(file) || jsonc) {
    const value = JSON.parse(text)?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  }
  const re = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*["\']?([^"\'#\\r\\n]+)', 'm');
  const m = re.exec(text);
  return m && m[1].trim() ? m[1].trim() : '';
}
// YAML 风格「节内键」读取：model: 节下的 default / reasoning_effort 等嵌套键（JSON 亦支持）。
// 只读精确节点名与精确键名，绝不猜测。
export function readSectionKey(file, section, key, jsonc) {
  let text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/\.jsonc?$/i.test(file) || jsonc) {
    let obj = null;
    try { obj = JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')); } catch { obj = null; }
    const v = obj && obj[section] && obj[section][key];
    return typeof v === 'string' && v.trim() ? v.trim() : '';
  }
  const lines = text.split(/\r?\n/);
  const secRe = new RegExp('^(\\s*)' + esc(section) + '\\s*:\\s*$');
  for (let i = 0; i < lines.length; i++) {
    const m = secRe.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const ind = /^(\s*)/.exec(line)[1].length;
      if (ind <= indent) break;
      const hit = new RegExp('^\\s*' + esc(key) + '\\s*:\\s*["\']?([^"\'#\\r\\n]+)').exec(line);
      if (hit && hit[1].trim()) return hit[1].trim();
    }
  }
  return '';
}

// 该 agent 是否具备「档位继承探测」能力（原生适配器或带 modelDetection 的画像）。
// 用于「无记录 → 宿主自身配置兜底」时打印明确声明（禁止静默换档）；未知 agent/纯自定义单元不适用。
export function hasModelDetector(agent, env = process.env) {
  if (['codex', 'kimi', 'pi', 'opencode', 'claude', 'openclaw'].includes(String(agent || ''))) return true;
  try { return !!(loadProfile(agent, env) || {}).modelDetection; } catch { return false; }
}

function detectProfile({ id, env = process.env }) {
  const profile = loadProfile(id, env);
  const md = profile && profile.modelDetection;
  if (!md) return null;
  let model = '', effort = '';
  for (const name of md.env || []) { if (!model && env[name]) model = String(env[name]).trim(); }
  for (const name of md.effortEnv || []) { if (!effort && env[name]) effort = String(env[name]).trim(); }
  for (const c of md.config || []) {
    try {
      const home = env.USERPROFILE || env.HOME || os.homedir();
      const raw = String(c.file || '');
      // ~ 展开 + $VAR/${VAR} 环境变量展开（如 $HERMES_HOME/config.yaml）；变量未定义时保持字面量、文件不存在即跳过。
      const expanded = raw.startsWith('~') ? path.join(home, raw.slice(1))
        : raw.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => env[name] || m);
      const file = path.resolve(expanded);
      if (!expanded || !fs.existsSync(file)) continue;
      const readIn = (sec, k) => (sec ? readSectionKey(file, sec, k) : readProfileKey(file, k));
      if (!model && c.modelKey) model = readIn(c.section, c.modelKey);
      if (!effort && c.effortKey) effort = readIn(c.effortSection || c.section, c.effortKey);
    } catch { /* try next */ }
  }
  return model || effort ? { model: model || null, effort: effort || null, source: 'profile:' + id } : null;
}

// --------------------------------------------------------------- 调度 ------
export function detectHostModelEffort(agent, { cwd, env = process.env, homes = {} } = {}) {
  try {
    switch (String(agent || '')) {
      case 'codex': return detectCodex({ env, codexHome: homes.codex });
      case 'kimi': return detectKimi({ cwd, kimiHome: homes.kimi, env });
      case 'pi': return detectPi({ piHome: homes.pi });
      case 'opencode': return detectOpenCode({ configHome: homes.opencode });
      case 'claude': return detectClaude({ claudeHome: homes.claude, env });
      case 'openclaw': return detectOpenClaw({ env });
      default: {
        const profiled = detectProfile({ id: String(agent || ''), env });
        if (profiled) return profiled;
        return null; // 未知 agent：不检测
      }
    }
  } catch { return null; } // 检测绝不让引擎崩
}

// 引擎初始化时调用一次：把检测到的发起窗 model/effort 写回 env，下游所有适配器
// （codex -m/-c 注入、kimi -m、pi --model/--thinking、opencode --model）都消费
// ORCH_MODEL/ORCH_EFFORT，一次写回处处生效。显式 env 优先，只补空缺。
export function inheritHostModelEffort(agent, { cwd, env = process.env, homes = {} } = {}) {
  if (env.NODE_TEST_CONTEXT) return null; // 测试确定性：node --test 下不碰真实宿主状态
  if (env.ORCH_MODEL && env.ORCH_EFFORT) return null;
  const detected = detectHostModelEffort(agent, { cwd, env, homes });
  if (!detected) return null;
  if (!env.ORCH_MODEL && detected.model) env.ORCH_MODEL = detected.model;
  if (!env.ORCH_EFFORT && detected.effort) env.ORCH_EFFORT = detected.effort;
  // kimi CLI 无 effort 旗标；官方按进程渠道是 KIMI_MODEL_THINKING_EFFORT（kimi provider 生效，
  // 其它 provider 类型读取与否由 CLI 决定，不生效时窗回退 config.toml [thinking].effort）。
  if (agent === 'kimi' && detected.effort && !env.KIMI_MODEL_THINKING_EFFORT) {
    env.KIMI_MODEL_THINKING_EFFORT = detected.effort;
  }
  return detected;
}
