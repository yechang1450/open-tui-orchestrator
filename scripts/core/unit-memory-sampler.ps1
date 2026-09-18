# unit-memory-sampler.ps1 -- generic per-unit peak-memory sampler (0.9.17). ASCII only.
# One sampler per unit; snapshots the unit's process tree once, then polls a light-weight
# WorkingSet sum and records the peak. Host-agnostic: it only needs the unit's root pid.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File unit-memory-sampler.ps1 -RootPid <pid> -OutFile <json> [-IntervalMs 12000] [-RescanEvery 5] [-MaxMs 3600000]
param(
  [Parameter(Mandatory=$true)][int]$RootPid,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [int]$IntervalMs = 12000,
  [int]$RescanEvery = 5,
  [int]$MaxMs = 3600000
)
$ErrorActionPreference = 'SilentlyContinue'

function Get-TreeIds([int]$root) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $ids = @($root)
  $frontier = @($root)
  while ($frontier.Count -gt 0) {
    $next = @($all | Where-Object { $frontier -contains $_.ParentProcessId } | Select-Object -ExpandProperty ProcessId)
    $next = @($next | Where-Object { $ids -notcontains $_ })
    if ($next.Count -eq 0) { break }
    $ids += $next
    $frontier = $next
  }
  return $ids
}

$start = Get-Date
$tree = @(Get-TreeIds -root $RootPid)
$peak = [int64]0
$loops = 0
while ((((Get-Date) - $start).TotalMilliseconds) -lt $MaxMs) {
  $alive = $false
  $sum = [int64]0
  foreach ($procId in $tree) {
    $procObj = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($procObj) {
      $alive = $true
      $sum += [int64]$procObj.WorkingSet64
    }
  }
  if ($sum -gt $peak) { $peak = $sum }
  if (-not $alive) { break }
  $loops += 1
  if (($RescanEvery -gt 0) -and (($loops % $RescanEvery) -eq 0)) {
    $tree = @($tree + (Get-TreeIds -root $RootPid)) | Select-Object -Unique
  }
  Start-Sleep -Milliseconds $IntervalMs
}
$peakMb = [int][math]::Round($peak / 1MB, 0)
$stamp = (Get-Date).ToString('s')
$json = '{"schema":1,"rootPid":' + $RootPid + ',"peakMB":' + $peakMb + ',"sampledAt":"' + $stamp + '","loops":' + $loops + '}'
Set-Content -Path $OutFile -Value $json -Encoding ascii
