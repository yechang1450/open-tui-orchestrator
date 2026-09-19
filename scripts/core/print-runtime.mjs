import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {profileArgs} from './print-profile.mjs';
import {nativeArgumentLines} from './native-argv.mjs';

// print-class 通用运行时：与 kimi/claude 适配器同构的启动器契约（tee 日志 + token 行抓取 +
// result 文件 + self-closed 标记），供任何带画像的 agent 使用。

const quote = (s) => "'" + String(s).replaceAll("'", "''") + "'";

export async function runProfilePlanner(config, prompt, cwd) {
  const args = [...profileArgs(config, {model: process.env.ORCH_MODEL, effort: process.env.ORCH_EFFORT}), prompt];
  return new Promise((resolve, reject) => {
    const child = spawn(config.bin, args, { cwd, env: process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let raw = '', errorText = '', timedOut = false;
    const timeoutMs = (() => { const v = Number(process.env.ORCH_DECOMPOSE_TIMEOUT_MS); return Number.isFinite(v) && v > 0 ? v : 240000; })();
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (b) => { raw += b; if (raw.length > 8000000) child.kill(); });
    child.stderr.on('data', (b) => { errorText += b; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      try {
        if (timedOut || code !== 0) throw new Error((timedOut ? 'PLANNER_TIMEOUT' : 'PLANNER_FAILED: exit ' + code) + (errorText ? ': ' + String(errorText).slice(0, 300) : ''));
        const final = String(raw || '').trim();
        if (!final) throw new Error('PLANNER_EMPTY_RESPONSE' + (errorText ? ': ' + String(errorText).slice(0, 300) : ''));
        resolve({ final });
      } catch (e) { reject(e); }
    });
  });
}

export function writeProfileLauncher(config, { key, prompt, suffix, workspace, temp }) {
  const stem = String(key + '-' + suffix).replace(/[^a-zA-Z0-9_-]/g, '-');
  const token = /【本块唯一标识】\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(prompt)?.[1];
  if (!token) throw new Error((config.label || config.id) + ' window requires a completion token');
  fs.mkdirSync(temp, { recursive: true });
  const lp = path.join(temp, 'win-launch-' + stem + '.ps1');
  const pidf = path.join(temp, 'window-' + stem + '.pid');
  const pf = path.join(temp, 'agent-win-' + stem + '.md');
  const rf = path.join(temp, 'win-' + stem + '.result.json');
  const log = path.join(temp, 'win-' + stem + '.out.log');
  fs.writeFileSync(pf, prompt, 'utf8');
  const args = profileArgs(config, { model: process.env.ORCH_MODEL, effort: process.env.ORCH_EFFORT, mode: process.env.ORCH_SPAWN_MODE });
  const body = [
    "$ErrorActionPreference = 'Continue'",
    'trap { exit 0 }',
    `$PID | Set-Content -LiteralPath ${quote(pidf)} -Encoding UTF8`,
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    'chcp 65001 | Out-Null',
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    'Write-Host "============================================="',
    'Write-Host "  ' + String(config.label || config.id).toUpperCase() + ' TASK RUNNING - closes automatically on completion"',
    'Write-Host "============================================="',
    `Set-Location -LiteralPath ${quote(workspace)}`,
    `$env:ORCH_WINDOW = '1'`,
    `$token = ${quote(token)}`,
    `$log = ${quote(log)}`,
    `$resultFile = ${quote(rf)}`,
    "function Write-Result {",
    "  param([int]$code,[string]$report)",
    "  try {",
    "    $json = '{\"__EXIT__\":' + $code + ',\"__DONE__\":true,\"__REPORT__\":' + (ConvertTo-Json $report -Compress) + '}'",
    "    $d = Split-Path -Parent $resultFile; if ($d -and -not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }",
    "    Set-Content -LiteralPath $resultFile -Value ($json + \"`r`n__EXIT__=\" + $code) -Encoding UTF8",
    "    try { Set-Content -LiteralPath ($resultFile + '.self-closed') -Value '1' -Encoding ASCII } catch { }",
    "  } catch { }",
    "}",
    "$p = (Get-Content -Raw -Encoding UTF8 '" + String(pf).replace(/'/g, "''") + "').Trim()",
    "if ([string]::IsNullOrWhiteSpace($p)) { Write-Result 2 ''; exit 0 }",
    "$agentArgs = @(" + args.map(quote).join(',') + ') + @($p)',
    ...nativeArgumentLines(),
    // 2026-09-19：窗口模式让 CLI 裸跑 —— 不接管道（管道会剥掉 ANSI 颜色并把真 TTY 变假，
    // 表现是整窗单色）。收口靠"盘上验收"，不依赖 stdout 捕获；headless 行为逐字不变。
    String(process.env.ORCH_SPAWN_MODE||'').toLowerCase()==='window'
      ? `& ${quote(config.bin)} @agentArgs`
      : `& ${quote(config.bin)} @agentArgs 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.TargetObject } else { $_ } } | Tee-Object -FilePath $log`,
    '$code = $LASTEXITCODE',
    "$report = ''",
    "if (Test-Path -LiteralPath $log) {",
    "  $lines = Get-Content -LiteralPath $log -Encoding UTF8 -ErrorAction SilentlyContinue",
    "  $hit = $lines | Where-Object { $_.Contains($token) } | Select-Object -Last 1",
    "  if ($hit) { $report = $hit } else { $report = ($lines | Select-Object -Last 3) -join \"`n\" }",
    "}",
    'Write-Result $code $report',
    'exit 0',
  ].join('\r\n');
  fs.writeFileSync(lp, '\uFEFF' + body, 'utf8');
  return { lp, pidf, pf, rf, log };
}

export async function waitProfileResult(rf, timeoutMs, pidf) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(rf)) {
      try {
        const r = JSON.parse(fs.readFileSync(rf, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0]);
        return { done: true, exitCode: r.__EXIT__, text: r.__REPORT__ || '' };
      } catch { /* keep polling */ }
    }
    if (fs.existsSync(pidf)) {
      const pid = Number(fs.readFileSync(pidf, 'utf8').replace(/^\uFEFF/, ''));
      try { process.kill(pid, 0); } catch { return { done: true, exitCode: 1, text: 'Launcher exited without result' }; }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { done: false, exitCode: null, text: 'Completion timeout' };
}
