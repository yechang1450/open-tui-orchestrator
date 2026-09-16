# orch-level-patrol install / uninstall (L10 machine-ization, open-tui-orchestrator line).
# Generates the hidden-window VBS launcher, then registers the Windows Scheduled Task
# 'orch-level-patrol' (every 15 minutes, hidden, exit code lands in task history).
# Registration uses schtasks /Create (single-slash flags): the PS-native Register-ScheduledTask
# gets refused unelevated on this machine (0x80070005) - same workaround as 83-level-patrol.
# Pattern copied from 83-level-patrol (same machine, proven 2026-09-15):
#   -WindowStyle Hidden is NOT enough; SW_HIDE at CreateProcess time is (window delta = 0).
# ASCII-only on purpose (PS 5.1 reads BOM-less files as ANSI; keep this file pure ASCII).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/orch-patrol-install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/orch-patrol-install.ps1 -Uninstall
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$repo      = Join-Path $HOME '.tools\open-tui-orchestrator'
$python    = Join-Path $HOME 'AppData\Local\Programs\Python\Python312\python.exe'
$launchers = Join-Path $HOME '.tools\launchers'
$vbsPath   = Join-Path $launchers 'orch-level-patrol.vbs'
$task      = 'orch-level-patrol'

if ($Uninstall) {
  schtasks.exe /Delete /TN $task /F
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
py = sh.ExpandEnvironmentStrings("%USERPROFILE%\AppData\Local\Programs\Python\Python312\python.exe")
sc = sh.ExpandEnvironmentStrings("%USERPROFILE%\.tools\open-tui-orchestrator\tools\orch-patrol.py")
rc = sh.Run("""" & py & """" & " -B -u " & """" & sc & """", 0, True)
WScript.Quit rc
'@
Set-Content -Path $vbsPath -Value $vbs -Encoding Ascii

$tr = 'wscript.exe //nologo //B "' + $vbsPath + '"'
schtasks.exe /Create /TN $task /SC MINUTE /MO 15 /TR $tr /F
if ($LASTEXITCODE -ne 0) { throw ('schtasks /Create failed rc=' + $LASTEXITCODE) }
$t = Get-ScheduledTaskInfo -TaskName $task
'OK task=' + $task
'next=' + $t.NextRunTime
'trigger=MINUTE/15  action=' + $tr
