#!/usr/bin/env node
/**
 * install-deps.mjs — 公开安装路径的「补依赖」引导实现（node-pty + codex-sdk）。
 *
 * 关键约束：它**不能依赖引擎**。引擎在 ORCH_AGENT=codex 时会顶层导入 @openai/codex-sdk，
 * 缺依赖时连「装依赖」的入口都进不去（鸡生蛋）。所以本模块只依赖 node 内置模块，并且由
 * 壳层在加载引擎**之前**调用（CLI 直接调用核内分发时也走这里，实现只有一份）。
 *
 * 语义：幂等（已装则回 already-present、不联网）、stdout 纯数据（进度与失败原因走 stderr）、
 * 失败时指名手工兜底命令、只装本包自己的锁定依赖、永不触碰任何 agent CLI。
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const tail = (text) => String(text || '').trim().split(/\r?\n/).slice(-12).join('\n');

export function installDepsCli(pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const scriptsDir = path.join(pkgRoot, 'scripts');
  const shim = (name) => path.join(scriptsDir, 'node_modules', name, 'package.json');
  // 每次现算：装前算一次的常量会把「刚装成功」误判成失败（2026-09-14 真机回归抓到）。
  const shimPresent = () => fs.existsSync(shim('@openai/codex-sdk')) && fs.existsSync(shim('@lydell/node-pty'));
  if (shimPresent()) {
    console.log(JSON.stringify({ok: true, action: 'already-present', scriptsDir}));
    return 0;
  }
  if (!fs.existsSync(path.join(scriptsDir, 'package-lock.json'))) {
    console.error('[orchestrator] FATAL: package-lock.json is missing from ' + scriptsDir + '; reinstall the package');
    return 1;
  }
  console.error('[orchestrator] installing locked SDK dependencies into ' + scriptsDir + ' (npm ci; network required)');
  // 优先用随 node 一起装好的 npm-cli.js 直启：避免 shell:true 带来的 DEP0190 噪音，
  // 也避免把路径交给 shell 拼接（scriptsDir 可能含空格）。找不到才回落到 npm.cmd + shell。
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const useCli = fs.existsSync(npmCli);
  // 企业镜像/自定义 npm：ORCH_NPM_BIN 显式指定优先（.cmd/.exe/路径皆可）。
  const npmBin = String(process.env.ORCH_NPM_BIN || '').trim();
  // .cmd/.bat 不能直接 spawn（CreateProcess 无法执行批处理，实测 EINVAL）——走 cmd /s 的 verbatim 形态。
  const npm = npmBin
    ? (process.platform === 'win32' && /\.(cmd|bat)$/i.test(npmBin)
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '""' + npmBin + '" ci --prefix "' + scriptsDir + '""'], {cwd: scriptsDir, encoding: 'utf8', windowsHide: true, timeout: 900000, windowsVerbatimArguments: true})
      : spawnSync(npmBin, ['ci', '--prefix', scriptsDir], {cwd: scriptsDir, encoding: 'utf8', windowsHide: true, timeout: 900000}))
    : (useCli
      ? spawnSync(process.execPath, [npmCli, 'ci', '--prefix', scriptsDir], {cwd: scriptsDir, encoding: 'utf8', windowsHide: true, timeout: 900000})
      : (process.platform === 'win32'
        // 回落也避开 shell:true（DEP0190）：镜像 Node 官方的 shell 形态——整条命令外加一对引号
        // （cmd /s 语义）+ windowsVerbatimArguments（不让 libuv 按 C-runtime 规则二次转义，
        // 否则引号会进入路径、npm 收到坏 argv）。旧的无外层引号形态在含空格路径上实测必败。
        ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"npm ci --prefix "' + scriptsDir + '""'], {cwd: scriptsDir, encoding: 'utf8', windowsHide: true, timeout: 900000, windowsVerbatimArguments: true})
        : spawnSync('npm', ['ci', '--prefix', scriptsDir], {cwd: scriptsDir, encoding: 'utf8', windowsHide: true, timeout: 900000})));
  if (npm.status !== 0 || !shimPresent()) {
    const missingToolchain = npm.error && ['ENOENT', 'EINVAL'].includes(npm.error.code);
    console.error('[orchestrator] FATAL: dependency install failed (npm exit ' + (npm.status ?? 'null') + (npm.error ? ', ' + npm.error.message : '') + ')');
    if (tail(npm.stderr)) console.error(tail(npm.stderr));
    console.error('[orchestrator] hint: ' + (missingToolchain ? 'install Node.js 22+ so npm is on PATH (or point ORCH_NPM_BIN at your npm), or ' : '') + 'run it manually: npm ci --prefix "' + scriptsDir + '"');
    return 1;
  }
  console.log(JSON.stringify({ok: true, action: 'installed', scriptsDir}));
  return 0;
}

export default installDepsCli;
