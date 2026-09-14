param([string]$Directory,[string]$Ticket,[int]$Owner,[string]$Started)
$ErrorActionPreference='Stop'
# Mutex wait is tunable: on a loaded machine many contenders legitimately queue past 20s
# (nine parents contending for eight slots blew the old hard-coded wait under full-suite load).
$waitMs=60000
try { if ($env:ORCH_MUTEX_WAIT_MS) { $waitMs=[int]$env:ORCH_MUTEX_WAIT_MS } } catch { }
if ($waitMs -lt 1000) { $waitMs=1000 }
$hash=[Security.Cryptography.SHA256]::Create()
$name='Local\TuiOrchestrator.Leases.'+[BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Directory.ToLowerInvariant()))).Replace('-','')
$mutex=[Threading.Mutex]::new($false,$name)
$held=$false
try {
  try {$held=$mutex.WaitOne($waitMs)} catch [Threading.AbandonedMutexException] {$held=$true}
  if(-not $held){exit 2}
  [IO.File]::WriteAllText($Ticket+'.ready','ready')
  while(-not [IO.File]::Exists($Ticket+'.release')) {
    $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$Owner) -ErrorAction SilentlyContinue
    if(-not $p -or $p.CreationDate.ToUniversalTime().ToString('o') -ne $Started){break}
    Start-Sleep -Milliseconds 100
  }
} finally {
  if($held){$mutex.ReleaseMutex()}
  $mutex.Dispose()
  foreach($suffix in @('.ready','.release')){[IO.File]::Delete($Ticket+$suffix)}
}
