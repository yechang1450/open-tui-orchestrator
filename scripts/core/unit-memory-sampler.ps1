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
Set-Content -Path ($OutFile + '.start') -Value ((Get-Date).ToString('s')) -Encoding ascii
try {

function Get-TreeIds([int]$root) {
  # 2026-09-18：全表 Get-CimInstance 在忙机器上会卡死（实测采样器刚起就被拖住 ✗）⇒ 改成按父进程过滤的递归查询。
  $ids = @($root)
  $frontier = @($root)
  while ($frontier.Count -gt 0) {
    $next = @()
    foreach ($parent in $frontier) {
      $next += @(Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $parent) -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId | Where-Object { $_ })
    }
    $next = @($next | Where-Object { $_ -and ($ids -notcontains $_) })
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
  foreach ($procId in @($tree | Where-Object { $_ })) {
    if (-not $procId) { continue }
    $procObj = Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
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
} catch {
  Set-Content -Path ($OutFile + '.error') -Value ($_ | Out-String) -Encoding ascii
  exit 1
}
