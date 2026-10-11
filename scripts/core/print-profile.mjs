import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {probeCli} from './host-probe.mjs';

// print-class 通用适配：任何"一次性提示词 → stdout 终文本 → 自行退出"形态的 agent CLI
// 都可以用一份 JSON 画像（profile）接入，不必手写专用适配器。画像由 `node adapt.mjs`
// 探测生成（scripts/core/agent-profiles/<id>.json），也可以在适配目录里手写。
//
// 画像 schema（v1）:
//   { schema:1, id, label, bin:[候选名...], helpFlags:[必须出现在 --help 的旗标...],
//     versionPattern:'正则(含捕获组)', probePrompt:'探活提示词',
//     args:{ approve:[自动批准旗标...], extra:[附加旗标...], model:['--model']|null,
//            effort:['--effort']|null, prompt:['--message']|null,
//            subcommand:['run'] 可选——子命令型 CLI（如 opencode）的一次性调用子命令词，置于 argv 最前 } }
//   prompt 旗标取值为提示词本身（提示词跟在旗标之后，作为最后一个 argv 元素）。

const DEFAULT_PROFILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-profiles');

export function profilesDir(env = process.env) {
  const override = String(env.ORCH_AGENT_PROFILES_DIR || '').trim();
  return override ? path.resolve(override) : DEFAULT_PROFILE_DIR;
}

export function loadProfile(id, env = process.env) {
  const requested = String(id || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requested) || requested.includes('..')) return null;
  const file = path.join(profilesDir(env), requested + '.json');
  try {
    const profile = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (profile && profile.schema === 1 && profile.id === requested && Array.isArray(profile.bin) && profile.bin.length) return profile;
    return null;
  } catch { return null; }
}

export function listProfiles(env = process.env) {
  try {
    return fs.readdirSync(profilesDir(env)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch { return []; }
}

export function profileArgs(config, {model, effort, mode} = {}) {
  const p = config?.profile || {};
  const a = p.args || {};
  const flagValue = (flag, value) => (Array.isArray(flag) && flag.length && value && String(value).trim() && !/\s/.test(String(value)) ? [...flag, String(value).trim()] : []);
  // window 模式（2026-09-18）：画像可选提供 windowPrefix（子命令+TUI 旗标，置于最前）与 windowPrompt
  // （末位提示词旗标；提示词仍由调用方追加为最后一个 argv）。未提供 ⇒ 行为与从前完全一致。
  const windowMode = String(mode || '') === 'window';
  const useWindow = windowMode && Array.isArray(a.windowPrefix) && a.windowPrefix.length && Array.isArray(a.windowPrompt) && a.windowPrompt.length;
  return [
    // 子命令型画像（2026-10-11）：一次性提示调用所需的子命令词放在最前（如 `run`）；
    // 若同时提供 windowPrefix，由画像作者自行避免词项重复（docs/adapt.md 已注明）。
    ...(a.subcommand || []),
    ...(useWindow ? a.windowPrefix : []),
    ...(config.prefixArgs || []),
    ...(a.approve || []),
    ...(a.extra || []),
    ...flagValue(a.model, model),
    ...flagValue(a.effort, effort),
    ...(useWindow ? a.windowPrompt : (a.prompt || ['-p'])),
  ];
}

export function resolveProfileHost(env = process.env, id) {
  const profile = loadProfile(id, env);
  if (!profile) return null;
  const explicit = env.ORCH_CLI || env[String(id).toUpperCase() + '_EXE'];
  const names = profile.bin;
  const candidates = explicit
    ? [path.resolve(explicit)]
    : String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).flatMap((dir) => names.map((n) => path.join(dir, n)));
  const rejected = [];
  for (const file of [...new Set(candidates)]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    // .mjs/.cjs 形态：以 node + 脚本运行（本地 Node CLI 的常见发布形态）。
    let bin = file, prefixArgs = [];
    if (/\.m?js$/i.test(file)) {
      const sibling = path.join(path.dirname(file), 'node.exe');
      bin = fs.existsSync(sibling) ? sibling : process.execPath; prefixArgs = [file];
    }
    const help = probeCli(bin, [...prefixArgs, '--help'], {env});
    // 子命令型画像（2026-10-11）：旗标可能在子命令帮助里（如 `run --help`）；有 args.subcommand
    // 时把其帮助文本并入校验面（顶层 --help 仍必须可用）。
    let helpOut = help.out;
    if (Array.isArray(profile.args?.subcommand) && profile.args.subcommand.length) {
      const subHelp = probeCli(bin, [...prefixArgs, ...profile.args.subcommand, '--help'], {env});
      if (subHelp.status === 0) helpOut = helpOut + '\n' + subHelp.out;
    }
    const missing = (profile.helpFlags || []).filter((f) => !helpOut.includes(f));
    if (help.status !== 0 || missing.length) { rejected.push(`${file}: --help ${help.error ? 'probe error ' + help.error : 'exit ' + help.status}${missing.length ? '; missing ' + missing.join(' ') : ''}`); continue; }
    const versionResult = probeCli(bin, [...prefixArgs, '--version'], {env});
    const version = new RegExp(profile.versionPattern || '(\\d+\\.\\d+\\.\\d+)').exec(String(versionResult.stdout || ''))?.[1];
    if (versionResult.status !== 0 || !version) { rejected.push(`${file}: --version ${versionResult.error ? 'probe error ' + versionResult.error : 'exit ' + versionResult.status + '; unusable output ' + JSON.stringify(String(versionResult.stdout || '').trim().slice(0, 120))}`); continue; }
    return { agent: id, config: { id, label: profile.label || id, version, bin, prefixArgs, available: true, native: prefixArgs.length === 0, completionMarker: '__ORCH_DONE__', modelEnv: 'ORCH_MODEL', effortEnv: 'ORCH_EFFORT', carrier: profile.carrier || null, profile, profileFile: path.join(profilesDir(env), id + '.json'), reusable: true } };
  }
  throw new Error(`CLI_MISSING: ${id}; no supported installed ${id} CLI found (print-class profile ${path.join(profilesDir(env), id + '.json')}). No fallback or automatic install. Tried: ${rejected.join(' | ') || 'no candidate found on disk'}`);
}
