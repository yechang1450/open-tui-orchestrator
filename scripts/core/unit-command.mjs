import fs from 'node:fs';
import path from 'node:path';
import { normalizeUnitCarrier } from './unit-carrier.mjs';

// 调用方自助通道（caller-driven / delegate 模式）第一半：单元命令画像的解析与展开。
//
// 调用方（任意 agent）给出"一个执行单元怎么跑"的命令模板，编排器只负责确定性机制
// （载具/身份/租约/看板/守护/恢复/验收）。与 print-class 画像（探测 + 解析自检 + 活验的
// 富路径）不同，这里是"自证"的瘦路径：不 probe、不解析 --help/--version、无名单限制。
//
// 画像 schema（v1）：
//   { schema:1, id, label, bin,
//     args:[...],                     // 模板；占位符 {promptFile} / {prompt} / {workspace}
//     promptDelivery:"file"|"arg"|"stdin",
//     modelArgs:["--model"]|null,     // 可选：按 ORCH_MODEL 注入
//     effortArgs:["--effort"]|null,   // 可选：按 ORCH_EFFORT 注入
//     carrier:"pty"|"stdio"|null,     // 可选：单元载体覆盖（默认按 agent 画像；TUI 类 CLI 用 pty）
//     timeoutMs:number|null }         // 可选：单单元超时（当前由轮询/调度统一控制）
//
// 规则：file=提示词落文件并把路径代入 {promptFile}；arg=提示词作为最后一个 argv 元素；
//       stdin=提示词写进程 stdin。三者互斥，缺占位符时以 promptDelivery 为准。

const UNIT_PROMPT_FILE_TOKEN = '{promptFile}';
const UNIT_PROMPT_TOKEN = '{prompt}';
const UNIT_WORKSPACE_TOKEN = '{workspace}';

export function normalizeUnitProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('UNIT_CMD_INVALID: profile must be a JSON object');
  }
  const bin = String(input.bin || '').trim();
  if (!bin) throw new Error('UNIT_CMD_INVALID: bin (executable path or name) is required');
  if (/\.(cmd|bat)$/i.test(bin)) {
    throw new Error('UNIT_CMD_INVALID: bin must be a real executable (Windows cannot spawn .cmd/.bat directly without a shell); point to the underlying .exe');
  }
  const id = String(input.id || 'custom').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '') || 'custom';
  const label = String(input.label || id);
  const args = (Array.isArray(input.args) ? input.args : []).map((a) => String(a));
  const modelArgs = Array.isArray(input.modelArgs) && input.modelArgs.length ? input.modelArgs.map(String) : null;
  const effortArgs = Array.isArray(input.effortArgs) && input.effortArgs.length ? input.effortArgs.map(String) : null;
  const rawTimeout = Number(input.timeoutMs);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : null;

  const hasFile = args.some((a) => a.includes(UNIT_PROMPT_FILE_TOKEN));
  const hasPrompt = args.some((a) => a.includes(UNIT_PROMPT_TOKEN));
  if (hasFile && hasPrompt) throw new Error('UNIT_CMD_INVALID: args must not use both {promptFile} and {prompt}');
  const requested = String(input.promptDelivery || '').trim().toLowerCase();
  const promptDelivery = requested || (hasFile ? 'file' : hasPrompt ? 'arg' : '');
  if (!['file', 'arg', 'stdin'].includes(promptDelivery)) {
    throw new Error('UNIT_CMD_INVALID: promptDelivery must be file|arg|stdin, or thread the prompt through {promptFile}/{prompt} in args');
  }
  if (promptDelivery === 'file' && !hasFile) throw new Error('UNIT_CMD_INVALID: promptDelivery=file requires {promptFile} in args');
  if (promptDelivery === 'arg' && hasFile) throw new Error('UNIT_CMD_INVALID: promptDelivery=arg must not use {promptFile}');
  if (promptDelivery === 'stdin' && (hasFile || hasPrompt)) throw new Error('UNIT_CMD_INVALID: promptDelivery=stdin must not use prompt placeholders');

  // carrier 是文档化 schema 的可选字段（pty|stdio|null）；必须 normalize 后回传——host-cli 会读
  // unit.carrier 决定载体，丢失它会让声明 pty 的 TUI 单元静默退回 stdio、无控制台秒退。
  const carrier = normalizeUnitCarrier(input.carrier);
  return { schema: 1, id, label, bin, args, promptDelivery, modelArgs, effortArgs, timeoutMs, carrier, source: 'caller' };
}

export function loadUnitProfile(env = process.env) {
  const file = String(env.ORCH_UNIT_CMD_FILE || '').trim();
  const inline = String(env.ORCH_UNIT_CMD || '').trim();
  if (!file && !inline) return null;
  if (file && inline) throw new Error('UNIT_CMD_INVALID: provide --unit-cmd or --unit-cmd-file, not both');
  let raw = inline;
  if (file) {
    const resolved = path.resolve(file);
    try { raw = fs.readFileSync(resolved, 'utf8'); }
    catch (error) { throw new Error('UNIT_CMD_UNREADABLE: ' + resolved + ' (' + (error?.message || String(error)) + ')'); }
  }
  let parsed;
  try { parsed = JSON.parse(String(raw).replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error('UNIT_CMD_INVALID: not valid JSON (' + (error?.message || String(error)) + ')'); }
  return normalizeUnitProfile(parsed);
}

// 展开单元 argv：占位符代入 + 可选的 model/effort 注入；arg 投递时提示词固定为最后一个 argv 元素。
export function expandUnitArgs(config, { prompt = '', promptFile = '', workspace = '' } = {}) {
  const flagValue = (flag, value) => (Array.isArray(flag) && flag.length && value && String(value).trim() && !/\s/.test(String(value).trim()) ? [...flag, String(value).trim()] : []);
  const out = [];
  for (const arg of config.args || []) {
    if (config.promptDelivery === 'arg' && String(arg).includes(UNIT_PROMPT_TOKEN)) continue;
    out.push(String(arg)
      .replaceAll(UNIT_PROMPT_FILE_TOKEN, promptFile)
      .replaceAll(UNIT_PROMPT_TOKEN, prompt)
      .replaceAll(UNIT_WORKSPACE_TOKEN, workspace));
  }
  out.push(...flagValue(config.modelArgs, process.env.ORCH_MODEL), ...flagValue(config.effortArgs, process.env.ORCH_EFFORT));
  if (config.promptDelivery === 'arg') out.push(prompt);
  return out;
}

