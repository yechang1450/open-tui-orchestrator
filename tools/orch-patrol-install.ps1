# orch-level-patrol install / uninstall (L10 machine-ization, open-tui-orchestrator line).
# Generates the hidden-window VBS launcher, then registers the Windows Scheduled Task
# 'orch-level-patrol' (every 15 minutes, hidden, exit code lands in task history).
# Registration uses schtasks /Create (single-slash flags): the PS-native Register-ScheduledTask
# gets refused unelevated on this machine (0x80070005) - same workaround as an earlier local patrol.
# Pattern proven on this machine (2026-09-15):
#   -WindowStyle Hidden is NOT enough; SW_HIDE at CreateProcess time is (window delta = 0).
# 2026-10-13: repo and python are resolved at install time - the script self-locates to the
#   repository it lives in (tools/..) and `python` comes from PATH; the retired ~/.tools
#   layout is no longer referenced. The VBS launcher lives under %LOCALAPPDATA%\orch-patrol.
#   Keep the repo path ASCII-only: the VBS embeds it literally (Set-Content -Encoding Ascii).
# ASCII-only on purpose (PS 5.1 reads BOM-less files as ANSI; keep this file pure ASCII).
#
# Usage:
#   pwsh -NoProfile -ExecutionPolicy Bypass -File tools/orch-patrol-install.ps1
#   pwsh -NoProfile -ExecutionPolicy Bypass -File tools/orch-patrol-install.ps1 -Uninstall
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$repo      = Split-Path -Parent $PSScriptRoot
$python    = (Get-Command python -ErrorAction Stop).Source
$launchers = Join-Path $env:LOCALAPPDATA 'orch-patrol'
$vbsPath   = Join-Path $launchers 'orch-level-patrol.vbs'
$task      = 'orch-level-patrol'

if ($Uninstall) {
  schtasks.exe /Delete /TN $task /F
  if (Test-Path -LiteralPath $vbsPath) { Remove-Item -LiteralPath $vbsPath -Force }
  'OK unregistered ' + $task
  exit 0
}

if (-not (Test-Path -LiteralPath $python)) { throw 'python not found: ' + $python }
$patrol = Join-Path $repo 'tools\orch-patrol.py'
if (-not (Test-Path -LiteralPath $patrol)) { throw 'patrol script not found: ' + $patrol }

New-Item -ItemType Directory -Force -Path $launchers | Out-Null
$vbs = @'
' Hidden launcher for Scheduled Task "orch-level-patrol" (runs every 15 minutes).
' Same pattern as an earlier local patrol VBS: SW_HIDE at CreateProcess time keeps the task
' windowless (plain -WindowStyle Hidden leaves a blank Terminal behind).
' Exit code is propagated so the task history carries the verdict:
'   0 = tick green/skip, 1 = tick red, 2 = internal error.
Set sh = CreateObject("WScript.Shell")
py = "__PY__"
sc = "__SC__"
rc = sh.Run("""" & py & """" & " -B -u " & """" & sc & """", 0, True)
WScript.Quit rc
'@
$vbs = $vbs.Replace('__PY__', $python).Replace('__SC__', $patrol)
Set-Content -Path $vbsPath -Value $vbs -Encoding Ascii

$tr = 'wscript.exe //nologo //B "' + $vbsPath + '"'
schtasks.exe /Create /TN $task /SC MINUTE /MO 15 /TR $tr /F
if ($LASTEXITCODE -ne 0) { throw ('schtasks /Create failed rc=' + $LASTEXITCODE) }
$t = Get-ScheduledTaskInfo -TaskName $task
'OK task=' + $task
'next=' + $t.NextRunTime
'trigger=MINUTE/15  action=' + $tr
