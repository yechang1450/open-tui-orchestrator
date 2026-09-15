param([Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE '.tools'
$j = Join-Path $root 'node24-fresh\node_modules\open-tui-orchestrator'
$t = Join-Path $root ("releases\$Version\open-tui-orchestrator")
if (-not (Test-Path $t)) { throw "release target missing: $t" }
if (Test-Path $j) {
  $cur = (Get-Item $j).Target
  Write-Output "current -> $cur"
  if ($cur -eq $t) { Write-Output 'already on target (no-op)'; exit 0 }
  cmd /c "rmdir `"$j`"" | Out-Null
}
if (Test-Path $j) { throw 'junction still present after rmdir' }
cmd /c "mklink /J `"$j`" `"$t`"" | Out-Null
$now = (Get-Item $j).Target
Write-Output "now     -> $now"
if ($now -ne $t) { throw 'junction target mismatch' }
Write-Output "OK junction -> $Version"
