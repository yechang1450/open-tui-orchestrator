# orch-level-patrol install / uninstall (L10 machine-ization, open-tui-orchestrator line).
# Generates the hidden-window VBS launcher, then registers the Windows Scheduled Task
# 'orch-level-patrol' (every 15 minutes, hidden, exit code lands in task history).
# Pattern copied from 83-level-patrol (same machine, proven 2026-09-15):
#   -WindowStyle Hidden is NOT enough; SW_HIDE at CreateProcess time is (window delta = 0).
# ASCII-only on purpose (PS 5.1 reads BOM-less files as ANSI; keep this file pure ASCII).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/orch-patrol-install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/orch-patrol-install.ps1 -Uninstall
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$repo      = 'C:\Users\yecha\.tools\open-tui-orchestrator'
$python    = 'C:\Users\yecha\AppData\Local\Programs\Python\Python312\python.exe'
$launchers = 'C:\Users\yecha\.tools\launchers'
$vbsPath   = Join-Path $launchers 'orch-level-patrol.vbs'
$task      = 'orch-level-patrol'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $task -Confirm:$false
  'OK unregistered ' + $task
  exit 0
}

if (-not (Test-Path $python)) { throw 'python not found: ' + $python }
if (-not (Test-Path (Join-Path $repo 'tools\orch-patrol.py'))) { throw 'patrol script not found under ' + $repo }

New-Item -ItemType Directory -Force -Path $launchers | Out-Null
$vbs = @'
' Hidden launcher for Scheduled Task "orch-level-patrol" (runs every 15 minutes).
' Same pattern as 83-level-patrol.vbs: SW_HIDE at CreateProcess time keeps the task
' windowless (plain -WindowStyle Hidden leaves a blank Terminal behind).
' Exit code is propagated so the task history carries the verdict:
'   0 = tick green/skip, 1 = tick red, 2 = internal error.
Set sh = CreateObject("WScript.Shell")
rc = sh.Run("""C:\Users\yecha\AppData\Local\Programs\Python\Python312\python.exe"" -B -u ""C:\Users\yecha\.tools\open-tui-orchestrator\tools\orch-patrol.py""", 0, True)
WScript.Quit rc
'@
Set-Content -Path $vbsPath -Value $vbs -Encoding Ascii

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//nologo //B "' + $vbsPath + '"')
$rep = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 15)
$lg = New-ScheduledTaskTrigger -AtLogOn
$st = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$pr = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $task -Action $action -Trigger @($lg, $rep) -Settings $st -Principal $pr -Description 'orch patrol (L10): tick observations + commit gate (auto gate.mjs --all per new clean HEAD). Ledger <repo>\logs\patrol\. Exit 0=green 1=red 2=internal.' -Force | Out-Null
$t = Get-ScheduledTask -TaskName $task
'OK state=' + $t.State
'action=' + $t.Actions[0].Execute + ' ' + $t.Actions[0].Arguments
'triggers=' + (($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ',')
