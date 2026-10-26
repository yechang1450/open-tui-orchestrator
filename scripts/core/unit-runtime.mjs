import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {expandUnitArgs} from './unit-command.mjs';
import {nativeArgumentLines} from './native-argv.mjs';
import {psKillDescendantsLines,powershellExe} from './contracts.mjs';

// 调用方自助通道（caller-driven）第二半：单元运行时。
// 与 print-class 画像同构的启动器契约（tee 日志 + token 行抓取 + result 文件 + self-closed 标记），
// 但 argv 完全来自调用方给的命令模板：不 probe、不解析版本、不做任何适配断言。
// 完成判定仍由主控按 token + checkpoint + 验收复检执行，绝不依赖该 CLI 的输出格式。

const quote = (s) => "'" + String(s).replaceAll("'", "''") + "'";
const TOKEN_RE = /【本块唯一标识】\s*([A-Za-z0-9][A-Za-z0-9_-]*)/;

// 2026-10-26（P1）：超时只 child.kill() 在 Windows 上等于 TerminateProcess 直接子进程。planner 的
// unit.bin 若自身带子进程（MCP server / shell 工具 / node 壳），孙进程会成孤儿继续写 workspace；
// 下一次 attempt 再起一个 planner ⇒ 两个 planner 同改一批文件，而对外只报「超时」。
// 复用 orchestrate-sdk 那套「按 ParentProcessId 树逐个 taskkill」的走法（已下沉到 contracts.mjs）：
// 它不依赖 taskkill /T（/T 会连带杀掉不相干的重用 pid），并用 CreationDate/CommandLine 复核防 pid 复用。
function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  try {
    const script = ['$root=' + pid, ...psKillDescendantsLines()].join('\r\n');
    const r = spawnSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', script],
      {windowsHide: true, encoding: 'utf8', timeout: 20000});
    const n = Number(String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop());
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

export async function runUnitPlanner(config, prompt, cwd) {
  const unit = config?.unit || config;   // 宿主 config 里画像挂在 unit 下；直连测试可直接传画像
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-unit-plan-'));
  const pf = path.join(planDir, 'planner-prompt.md');
  fs.writeFileSync(pf, String(prompt), 'utf8');
  const args = expandUnitArgs(unit, { prompt: String(prompt), promptFile: pf, workspace: cwd });
  const useStdin = unit.promptDelivery === 'stdin';
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(unit.bin, args, { cwd, env: process.env, windowsHide: true, shell: false, stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      if (useStdin && child.stdin) { try { child.stdin.end(String(prompt)); } catch { /* stdin closed early */ } }
      let raw = '', errorText = '', timedOut = false, oversized = false, settled = false;
      let exitCode = null, timer = null, killTimer = null, graceTimer = null;
      const MAX_OUTPUT_BYTES = 8000000;
      const timeoutMs = (() => { const v = Number(process.env.ORCH_DECOMPOSE_TIMEOUT_MS); return Number.isFinite(v) && v > 0 ? v : 240000; })();
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); if (killTimer) clearTimeout(killTimer); if (graceTimer) clearTimeout(graceTimer);
        try {
          if (oversized) throw new Error('PLANNER_OUTPUT_TOO_LARGE: unit output exceeded ' + MAX_OUTPUT_BYTES + ' bytes');
          if (timedOut) throw new Error('PLANNER_TIMEOUT' + (errorText ? ': ' + String(errorText).slice(0, 300) : ''));
          if (code !== 0) throw new Error('PLANNER_FAILED: exit ' + code + (errorText ? ': ' + String(errorText).slice(0, 300) : ''));
          const final = String(raw || '').trim();
          if (!final) throw new Error('PLANNER_EMPTY_RESPONSE' + (errorText ? ': ' + String(errorText).slice(0, 300) : ''));
          resolve({ final });
        } catch (e) { reject(e); }
      };
      timer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        timedOut = true;
        // 先温柔一次，再连整棵树一起收（P1）。
        try { child.kill(); } catch { /* already gone */ }
        killTimer = setTimeout(() => {
          const reaped = killProcessTree(child.pid);
          if (reaped > 0) errorText += '[runtime] reaped ' + reaped + ' descendant process(es) of planner ' + child.pid + '\n';
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          killTimer = setTimeout(() => finish(exitCode), 5000);
        }, 5000);
      }, unit.timeoutMs ? Math.min(unit.timeoutMs, timeoutMs) : timeoutMs);
      const decoder = new StringDecoder('utf8');
      let outputBytes = 0;
      child.stdout.on('data', (b) => {
        outputBytes += b.length;
        raw += decoder.write(b);
        if (!oversized && outputBytes > MAX_OUTPUT_BYTES) { oversized = true; try { child.kill(); } catch { /* already gone */ } }
      });
      child.stdout.on('end', () => { raw += decoder.end(); });
      // 2026-10-26（P7）：stderr 原来只 `errorText += b` —— 逐块隐式 toString('utf8')，中文诊断
      // 跨块会被切碎成乱码，而且完全没有上限（8MB 的闸只加在 stdout 上）。planner 大量写 stderr
      // （node 弃用告警、MCP 日志刷屏）时引擎内存无界增长，最后 OOM；而这段正是唯一回给调用方的失败文本。
      // 改用独立 StringDecoder + 只保留尾部 64KB（错误信息在末尾，前面多半是刷屏噪音）。
      const errDecoder = new StringDecoder('utf8');
      const ERR_MAX_CHARS = 65536;
      child.stderr.on('data', (b) => {
        errorText += errDecoder.write(b);
        if (errorText.length > ERR_MAX_CHARS) errorText = errorText.slice(-ERR_MAX_CHARS);
      });
      child.stderr.on('end', () => { errorText += errDecoder.end(); });
      child.on('error', (e) => { if (settled) return; settled = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer); if (graceTimer) clearTimeout(graceTimer); reject(e); });
      child.on('exit', (code) => {
        exitCode = code;
        if (!settled) graceTimer = setTimeout(() => finish(exitCode), 2000);
      });
      child.on('close', (code) => { finish(exitCode !== null ? exitCode : code); });
    });
  } finally {
    try { fs.rmSync(planDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export function writeUnitLauncher(config, { key, prompt, suffix, workspace, temp }) {
  const unit = config?.unit || config;   // 宿主 config 里画像挂在 unit 下；直连测试可直接传画像
  const stem = String(key + '-' + suffix).replace(/[^a-zA-Z0-9_-]/g, '-');
  const token = TOKEN_RE.exec(prompt)?.[1];
  if (!token) throw new Error((unit.label || unit.id) + ' unit requires a completion token');
  const sanctionToken = crypto.randomBytes(18).toString('hex');
  fs.mkdirSync(temp, { recursive: true });
  const lp = path.join(temp, 'win-launch-' + stem + '.ps1');
  const pidf = path.join(temp, 'window-' + stem + '.pid');
  const pf = path.join(temp, 'agent-win-' + stem + '.md');
  const rf = path.join(temp, 'win-' + stem + '.result.json');
  const log = path.join(temp, 'win-' + stem + '.out.log');
  fs.writeFileSync(pf, prompt, 'utf8');
  const args = expandUnitArgs(unit, { prompt, promptFile: pf, workspace });
  const useStdin = unit.promptDelivery === 'stdin';
  const invoke = useStdin
    ? `$p | & ${quote(unit.bin)} @agentArgs 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.TargetObject } else { $_ } } | Tee-Object -FilePath $log`
    : `& ${quote(unit.bin)} @agentArgs 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.TargetObject } else { $_ } } | Tee-Object -FilePath $log`;
  const body = [
    "$ErrorActionPreference = 'Continue'",
    'trap { try { Write-Result 3 $_.Exception.Message } catch { }; exit 0 }',
    `$PID | Set-Content -LiteralPath ${quote(pidf)} -Encoding UTF8`,
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    'chcp 65001 | Out-Null',
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    'Write-Host "============================================="',
    'Write-Host ' + quote('  ' + String(unit.label || unit.id).toUpperCase() + ' TASK RUNNING - closes automatically on completion'),
    'Write-Host "============================================="',
    `Set-Location -LiteralPath ${quote(workspace)}`,
    `$env:ORCH_WINDOW = '1'`,
    `$env:ORCH_WINDOW_TOKEN = ${quote(sanctionToken)}`,
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
    "$agentArgs = @(" + args.map(quote).join(',') + ')',
    ...nativeArgumentLines(),
    invoke,
    // 2026-10-26（P2）：& <bad bin> 在 Continue 下只是非终止错误，$LASTEXITCODE 仍是 $null，
    // 而 param([int]$code) 会把它化成 0 —— 于是"bin 不存在"被写成 __EXIT__:0 的成功结果。
    '$code = $LASTEXITCODE; if ($null -eq $code) { $code = -1 }',
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
  return { lp, pidf, pf, rf, log, sanctionToken };
}
