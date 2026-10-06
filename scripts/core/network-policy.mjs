// OpenAI-authenticated Responses over HTTPS, without the failing WebSocket probe.
// Keep the configured model and login. No third-party endpoint or credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isMachineReadableEntry} from './contracts.mjs';
export const networkConfig = Object.freeze({
  model_provider: 'orchestrator-openai-https',
  model_providers: {
    'orchestrator-openai-https': {
      name: 'OpenAI', wire_api: 'responses', requires_openai_auth: true,
      supports_websockets: false, supports_standalone_web_search: true,
    },
  },
});

export function networkArgs() {
  const provider = networkConfig.model_providers[networkConfig.model_provider];
  return ['-c', `model_provider=${JSON.stringify(networkConfig.model_provider)}`,
    ...Object.entries(provider).flatMap(([key, value]) =>
      ['-c', `model_providers.${networkConfig.model_provider}.${key}=${JSON.stringify(value)}`])];
}

// 2026-09-18（用户令：codex 改用 DeepSeek provider）：本策略原本**无条件**把 codex 钉到
// orchestrator-openai-https（ChatGPT 认证 + 关掉会超时的 WebSocket 探测）。当用户在 config.toml
// 里显式配了自家 provider（如 deepseek）时，这个注入会把用户配置顶掉，表现为
// 「API key login is required, but ChatGPT is currently being used」。现在按 auto 语义门控：
// 只当有效 provider 仍是默认 openai 时才注入。ORCH_CODEX_NETWORK_POLICY=auto|on|off 可强制。
export function codexProviderMode({ env = process.env } = {}) {
  const raw = String(env.ORCH_CODEX_NETWORK_POLICY || 'auto').toLowerCase();
  if (raw === 'off' || raw === 'on') return raw;
  let text = '';
  try {
    const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
    text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  } catch { /* no config: keep the default OpenAI behaviour */ }
  let provider = 'openai';
  let root = true;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) { root = false; continue; }
    if (!root) continue;
    const match = /^model_provider\s*=\s*(['"])([^'"]+)\1(?:\s*#.*)?$/.exec(line);
    if (match) { provider = match[2]; break; }
  }
  return provider === 'openai' ? 'on' : 'off';
}
export function codexNetworkArgs(options) {
  const mode = codexProviderMode(options);
  if (mode === 'on') return networkArgs();
  // 机器可读入口（--doctor/--tasks/--plan/--status/--watch/…）的 stdout 必须是纯数据：
  // 这行"策略跳过"属于诊断，改走 stderr，别把 JSON 打断（2026-09-22 第 3 轮全表面扫描实测）。
  const note = '[orchestrator] codex network policy skipped: config.toml declares a custom model_provider (ORCH_CODEX_NETWORK_POLICY=auto)';
  if (isMachineReadableEntry()) console.error(note); else console.log(note);
  return [];
}
export function codexNetworkConfig(options) {
  return codexProviderMode(options) === 'on' ? networkConfig : {};
}
