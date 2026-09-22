param([string]$Directory,[string]$Ticket,[int]$Owner,[string]$Started)
$ErrorActionPreference='Stop'
# Mutex wait is tunable: on a loaded machine many contenders legitimately queue past 20s
# (nine parents contending for eight slots blew the old hard-coded wait under full-suite load).
$waitMs=60000
try { if ($env:ORCH_MUTEX_WAIT_MS) { $waitMs=[int]$env:ORCH_MUTEX_WAIT_MS } } catch { }
if ($waitMs -lt 1000) { $waitMs=1000 }
# 持锁上限（2026-09-22）：属主被杀/卡死时别让内核互斥被无主占住——到点主动放锁并留下状态票，
# 排队者据此立刻拿到真因，而不是干等满自己的等待预算。
$holdMaxMs=120000
try { if ($env:ORCH_MUTEX_HOLD_MAX_MS) { $holdMaxMs=[int]$env:ORCH_MUTEX_HOLD_MAX_MS } } catch { }
if ($holdMaxMs -lt 1000) { $holdMaxMs=1000 }
$hash=[Security.Cryptography.SHA256]::Create()
$name='Local\TuiOrchestrator.Leases.'+[BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Directory.ToLowerInvariant()))).Replace('-','')
$mutex=[Threading.Mutex]::new($false,$name)
$held=$false
$reason=''
$acquiredAt=$null
# 属主还在不在？只把**确定不在**当"不在"：读失败（权限/竞态）一律当活着——宁可多等一轮，
# 也绝不因为一次查询失败就把锁丢掉、让调用方白等满（旧实现用 Get-CimInstance 全表查询，
# 满载机器上几秒一次，而且它是**持锁**执行的：排队者的预算就是这么被吃光的）。
function Test-OwnerGone([int]$OwnPid,[string]$OwnStarted){
  try { $p=[Diagnostics.Process]::GetProcessById($OwnPid) } catch { return $true }
  try { if ($p.HasExited) { return $true } } catch [System.InvalidOperationException] { return $true } catch { return $false }
  try { $start=$p.StartTime.ToUniversalTime() } catch [System.InvalidOperationException] { return $true } catch { return $false }
  try {
    $expected=[datetime]::Parse($OwnStarted,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AdjustToUniversal)
    if ([Math]::Abs(($start-$expected).TotalSeconds) -gt 2) { return $true }   # PID 被复用：属主已换人
  } catch { }
  return $false
}
try {
  try {$held=$mutex.WaitOne($waitMs)} catch [Threading.AbandonedMutexException] {$held=$true}
  if(-not $held){$reason='busy-timeout'}
  else {
    $acquiredAt=Get-Date
    [IO.File]::WriteAllText($Ticket+'.ready','ready')
    $reason='released'
    $poll=0;$gone=0
    while(-not [IO.File]::Exists($Ticket+'.release')) {
      # 放锁文件的轮询保持 100ms（调用方一放，票就在 ~100ms 内清掉，不留可见残渣）；
      # 活性探针每 ~1s 一次即可，且必须连读三次"确定不在"才认账（一次抽风不算）。
      if (($poll % 10) -eq 0) {
        if (Test-OwnerGone $Owner $Started) { $gone++; if ($gone -ge 3) { $reason='owner-gone'; break } } else { $gone=0 }
      }
      $poll++
      if (((Get-Date)-$acquiredAt).TotalMilliseconds -gt $holdMaxMs) { $reason='hold-ceiling'; break }
      Start-Sleep -Milliseconds 100
    }
  }
} catch {
  $reason='error: '+$_.Exception.Message
} finally {
  try { if($held){$mutex.ReleaseMutex()} } catch { }
  try { $mutex.Dispose() } catch { }
  foreach($suffix in @('.ready','.release')){ try { [IO.File]::Delete($Ticket+$suffix) } catch { } }
  # 只有异常收场才留状态票：正常放锁不留任何票（"事务结束不留票"判据仍然绿），
  # 异常时调用方读它就能立刻失败并报出真因（busy-timeout / owner-gone / hold-ceiling / error:...）。
  if ($reason -ne 'released' -and $reason -ne '') { try { [IO.File]::WriteAllText($Ticket+'.status',$reason) } catch { } }
}
