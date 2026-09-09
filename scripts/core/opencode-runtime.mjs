import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {opencodeArgs, opencodePlannerArgs} from './opencode-host.mjs';
import {nativeArgumentLines} from './native-argv.mjs';

const quote = (s) => "'" + String(s).replaceAll("'", "''") + "'";

// Parse `opencode run --format json` event stream: return the last assistant text part.
export function opencodeAssistantText(raw) {
  let final = '';
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'error') throw new Error('OPENCODE_RESPONSE_FAILED: ' + String(ev.error || ev.message || ''));
      const part = ev.part;
      if (ev.type === 'text' && part && part.type === 'text' && part.text && String(part.text).trim()) {
        final = String(part.text);
      }
    } catch (error) {
      if (error.message && error.message.startsWith('OPENCODE_RESPONSE_FAILED')) throw error;
      // ignore non-JSON lines / partial events
    }
  }
  return final;
}

export async function runOpenCodePlanner(config, prompt, cwd) {
  const args = [...opencodePlannerArgs(config, {model: process.env.ORCH_MODEL, cwd}), '--', prompt];
  return new Promise((resolve, reject) => {
    const child = spawn(config.bin, args, {cwd, env: process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    let raw = '', errorText = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, Number(process.env.ORCH_DECOMPOSE_TIMEOUT_MS || 90000));
    child.stdout.on('data', (b) => { raw += b; if (raw.length > 8000000) child.kill(); });
    child.stderr.on('data', (b) => { errorText += b; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      try {
        if (timedOut || code !== 0) throw new Error(timedOut ? 'OPENCODE_PLANNER_TIMEOUT' : 'OPENCODE_PLANNER_FAILED: exit ' + code);
        const final = opencodeAssistantText(raw);
        if (!final) throw new Error('OPENCODE_PLANNER_EMPTY_RESPONSE' + (errorText ? ': ' + String(errorText).slice(0, 300) : ''));
        resolve({final});
      } catch (e) { reject(e); }
    });
  });
}

export function writeOpenCodeLauncher(config, {key, prompt, suffix, workspace, temp}) {
  const stem = String(key + '-' + suffix).replace(/[^a-zA-Z0-9_-]/g, '-');
  const token = /【本块唯一标识】\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(prompt)?.[1];
  if (!token) throw new Error('OpenCode window requires a completion token');
  fs.mkdirSync(temp, {recursive: true});
  const lp = path.join(temp, 'win-launch-' + stem + '.ps1');
  const pidf = path.join(temp, 'window-' + stem + '.pid');
  const pf = path.join(temp, 'agent-win-' + stem + '.md');
  const rf = path.join(temp, 'win-' + stem + '.result.json');
  const log = path.join(temp, 'win-' + stem + '.out.log');
  fs.writeFileSync(pf, prompt, 'utf8');
  const args = opencodeArgs(config, {model: process.env.ORCH_MODEL, effort: process.env.ORCH_EFFORT, cwd: workspace});
  const body = [
    "$ErrorActionPreference = 'Continue'",
    'trap { exit 0 }',
    `$PID | Set-Content -LiteralPath ${quote(pidf)} -Encoding UTF8`,
    '$env:TERM = "xterm-256color"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    'chcp 65001 | Out-Null',
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    'Write-Host "============================================="',
    'Write-Host "  OPENCODE TASK RUNNING - closes automatically on completion"',
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
    // The prompt rides as the final argv element: fold it into the array BEFORE the
    // Windows PowerShell 5.1 native-argv fix-up so embedded quotes/newlines survive.
    "$agentArgs = @(" + args.map(quote).join(',') + ') + @($p)',
    ...nativeArgumentLines(),
    // 与 kimi 窗同款外观修复：opencode 诊断走 stderr，2>&1 合并时 PS5.1 会刷红色
    // NativeCommandError 块；ErrorRecord 还原后以普通文本进日志，完成 token 不受影响。
    `& ${quote(config.bin)} @agentArgs 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.TargetObject } else { $_ } } | Tee-Object -FilePath $log`,
    "$code = $LASTEXITCODE",
    "# opencode run -i exits on its own after the turn; capture the tail containing the token.",
    "$report = ''",
    "if (Test-Path -LiteralPath $log) {",
    "  $lines = Get-Content -LiteralPath $log -Encoding UTF8 -ErrorAction SilentlyContinue",
    "  $hit = $lines | Where-Object { $_.Contains($token) } | Select-Object -Last 1",
    "  if ($hit) { $report = $hit } else { $report = ($lines | Select-Object -Last 3) -join \"`n\" }",
    "}",
    "Write-Result $code $report",
    'exit 0',
  ].join('\r\n');
  fs.writeFileSync(lp, '\ufeff' + body, 'utf8');
  return {lp, pidf, pf, rf, log};
}

export async function waitOpenCodeResult(rf, timeoutMs, pidf) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(rf)) {
      try {
        // Write-Result appends a human-readable `__EXIT__=N` trailer line (read by
        // readExitCode); only the first line is the JSON record.
        const r = JSON.parse(fs.readFileSync(rf, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0]);
        return {done: true, exitCode: r.__EXIT__, text: r.__REPORT__ || ''};
      } catch {}
    }
    if (fs.existsSync(pidf)) {
      const pid = Number(fs.readFileSync(pidf, 'utf8').replace(/^\uFEFF/, ''));
      try { process.kill(pid, 0); } catch { return {done: true, exitCode: 1, text: 'OpenCode launcher exited without result'}; }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return {done: false, exitCode: null, text: 'OpenCode completion timeout'};
}