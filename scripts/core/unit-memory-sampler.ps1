# unit-memory-sampler.ps1 -- generic per-unit peak-memory sampler (0.9.17). ASCII only.
# One sampler per unit; snapshots the unit's process tree once, then polls a light-weight
# WorkingSet sum and records the peak. Host-agnostic: it only needs the unit's root pid.
# Identity (2026-09-22): a bare pid is NOT an identity. Windows recycles pids, so "a process with
# this pid exists" can be a stranger that inherited the slot after our unit died -- the old loop then
# kept polling a foreign process until -MaxMs (an hour), leaving a stranded powershell behind.
# Every tree member is therefore pinned to its creation time; a slot whose creation time changed
# counts as dead. -RootStarted (the engine's verified launcher creation time, ISO-8601 UTC) pins the
# root even for the first poll, where its slot may already have been recycled.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File unit-memory-sampler.ps1 -RootPid <pid> -OutFile <json> [-RootStarted <iso>] [-IntervalMs 12000] [-RescanEvery 5] [-MaxMs 3600000]
param(
  [Parameter(Mandatory=$true)][int]$RootPid,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [string]$RootStarted = '',
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

# 身份：pid -> 该实例的启动时刻（UTC）。pid 复用（同槽位换了别的进程）即视为原进程已死。
function Get-StartUtc([int]$procId) {
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  try { return $p.StartTime.ToUniversalTime() } catch { return $null }
}
function Is-SameInstance($expected,$actual) {
  if (-not $expected -or -not $actual) { return $false }
  return ([math]::Abs(($actual - $expected).TotalMilliseconds) -le 1000)
}

$start = Get-Date
$tree = @{}
$pinnedRoot = $null
if ($RootStarted) {
  try { $pinnedRoot = [datetime]::Parse($RootStarted, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal) } catch { $pinnedRoot = $null }
}
if (-not $pinnedRoot) { $pinnedRoot = Get-StartUtc -procId $RootPid }
if ($pinnedRoot) { $tree[[int]$RootPid] = $pinnedRoot }
$peak = [int64]0
$loops = 0
$stopped = 'root-gone'
while ($true) {
  if ((((Get-Date) - $start).TotalMilliseconds) -ge $MaxMs) { $stopped = 'max-ms'; break }
  $alive = $false
  $sum = [int64]0
  $gone = @()
  foreach ($procId in @($tree.Keys)) {
    $procObj = Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
    if (-not $procObj) { $gone += $procId; continue }
    if (-not (Is-SameInstance $tree[[int]$procId] $procObj.StartTime.ToUniversalTime())) { $gone += $procId; continue }
    $alive = $true
    $sum += [int64]$procObj.WorkingSet64
  }
  foreach ($procId in $gone) { $tree.Remove([int]$procId) }
  if ($sum -gt $peak) { $peak = $sum }
  if (-not $alive) { $stopped = 'root-gone'; break }
  $loops += 1
  if (($RescanEvery -gt 0) -and (($loops % $RescanEvery) -eq 0)) {
    foreach ($procId in @(Get-TreeIds -root $RootPid)) {
      $key = [int]$procId
      # 根身份只由 -RootStarted/首钉决定：被驱逐后绝不由重扫把"现在占用该槽位的陌生进程"重新收养。
      if ($key -eq $RootPid) { continue }
      if ($tree.ContainsKey($key)) { continue }
      $when = Get-StartUtc -procId $key
      if ($when) { $tree[$key] = $when }
    }
  }
  Start-Sleep -Milliseconds $IntervalMs
}
$peakMb = [int][math]::Round($peak / 1MB, 0)
$stamp = (Get-Date).ToString('s')
$json = '{"schema":1,"rootPid":' + $RootPid + ',"peakMB":' + $peakMb + ',"sampledAt":"' + $stamp + '","loops":' + $loops + ',"stopped":"' + $stopped + '"}'
Set-Content -Path $OutFile -Value $json -Encoding ascii
} catch {
  Set-Content -Path ($OutFile + '.error') -Value ($_ | Out-String) -Encoding ascii
  exit 1
}
