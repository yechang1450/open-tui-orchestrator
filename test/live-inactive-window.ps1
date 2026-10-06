param([string]$Workspace=(Get-Location).Path,[string]$Terminal,[switch]$Legacy,[string]$FixturePath)
$ErrorActionPreference='Stop'

function Convert-LiveEventEvidence {
 param([Parameter(Mandatory=$true)]$Value)
 if($Value -is [string]){
  $parts=[string]$Value -split ':',2
  if($parts.Count -lt 2){return $null}
  return [pscustomobject]@{Hwnd=[long]$parts[0];DwmsEventTime=[long]$parts[1];CallbackForeground=$null}
 }
 $hwnd=$Value.hwnd;if($null -eq $hwnd){$hwnd=$Value.Hwnd}
 $eventTime=$Value.dwmsEventTime;if($null -eq $eventTime){$eventTime=$Value.DwmsEventTime}
 if($null -eq $eventTime){$eventTime=$Value.eventTick}
 if($null -eq $eventTime){$eventTime=$Value.EventTick}
 if($null -eq $hwnd -or $null -eq $eventTime){return $null}
 $callbackForeground=$Value.callbackForeground;if($null -eq $callbackForeground){$callbackForeground=$Value.CallbackForeground}
 return [pscustomobject]@{Hwnd=[long]$hwnd;DwmsEventTime=[long]$eventTime;CallbackForeground=if($null -eq $callbackForeground){$null}else{[long]$callbackForeground}}
}

function Get-LiveEventMetrics {
 # Target evidence is the event hwnd plus its event time; callback foreground is diagnostic only.
 param([object[]]$Events,[object[]]$CallbackForegrounds,[Parameter(Mandatory=$true)][long]$TargetHwnd,[Parameter(Mandatory=$true)][long]$StartedTick,[Parameter(Mandatory=$true)][long]$TeardownStart)
 $records=New-Object System.Collections.Generic.List[object]
 foreach($item in $Events){$record=Convert-LiveEventEvidence $item;if($null -ne $record){[void]$records.Add($record)}}
 $target=@($records | Where-Object {$_.Hwnd -eq $TargetHwnd})
 $live=@($target | Where-Object {$_.DwmsEventTime -lt $TeardownStart})
 $teardown=@($target | Where-Object {$_.DwmsEventTime -ge $TeardownStart})
 $startup=@($target | Where-Object {(($_.DwmsEventTime-$StartedTick) -lt 3000)})
 $callbackValues=New-Object System.Collections.Generic.List[long]
 if($PSBoundParameters.ContainsKey('CallbackForegrounds')){foreach($value in $CallbackForegrounds){if($null -ne $value){[void]$callbackValues.Add([long]$value)}}}
 else{foreach($record in $records){if($null -ne $record.CallbackForeground){[void]$callbackValues.Add([long]$record.CallbackForeground)}}}
 return [pscustomobject]@{TargetEvents=$target.Count;TargetForegroundEvents=$live.Count;TeardownForegroundEvents=$teardown.Count;StartupForegroundEvents=$startup.Count;CallbackForegrounds=$callbackValues.ToArray()}
}

function Test-LiveInactiveWindow {
 param([Parameter(Mandatory=$true)][long]$Hwnd,[Parameter(Mandatory=$true)][bool]$Visible,[Parameter(Mandatory=$true)][bool]$Minimized,[Parameter(Mandatory=$true)][int]$TargetForegroundEvents,[Parameter(Mandatory=$true)][int]$LiveForegroundSamples,[Parameter(Mandatory=$true)][bool]$Receipt,[Parameter(Mandatory=$true)][bool]$Closed,[string]$FailureReason)
 return $Hwnd -ne 0 -and $Visible -and -not $Minimized -and $TargetForegroundEvents -eq 0 -and $LiveForegroundSamples -eq 0 -and $Receipt -and $Closed -and [string]::IsNullOrWhiteSpace($FailureReason)
}

function New-LiveLauncherResult {
 return [pscustomobject][ordered]@{Ok=$false;JobState='NotStarted';ExitCode=$null;Stdout='';Stderr='';JobOutput=@();JobErrors=@();Failure='inactive-window launcher did not start'}
}

function Invoke-InactiveWindowLauncher {
 param([Parameter(Mandatory=$true)][string]$LaunchScript,[Parameter(Mandatory=$true)][string]$Payload,[Parameter(Mandatory=$true)][string]$PowerShellPath,[switch]$PumpMessages)
 $job=$null;$jobOutput=@();$jobErrors=@();$jobState='NotStarted';$exitCode=$null;$stdout='';$stderr='';$failure=$null;$ok=$false
 try {
  $job=Start-Job -ScriptBlock {
   param($pwshPath,$scriptPath,$encodedPayload)
   try {
    $startInfo=[System.Diagnostics.ProcessStartInfo]::new();$startInfo.FileName=$pwshPath;$startInfo.UseShellExecute=$false;$startInfo.CreateNoWindow=$true;$startInfo.RedirectStandardOutput=$true;$startInfo.RedirectStandardError=$true
    [void]$startInfo.ArgumentList.Add('-NoProfile');[void]$startInfo.ArgumentList.Add('-NonInteractive');[void]$startInfo.ArgumentList.Add('-File');[void]$startInfo.ArgumentList.Add($scriptPath);[void]$startInfo.ArgumentList.Add('-Payload');[void]$startInfo.ArgumentList.Add($encodedPayload)
    $process=[System.Diagnostics.Process]::Start($startInfo);if($null -eq $process){throw 'Cannot start inactive-window helper process'}
    $stdoutTask=$process.StandardOutput.ReadToEndAsync();$stderrTask=$process.StandardError.ReadToEndAsync();$process.WaitForExit()
    [pscustomobject]@{type='helper-result';exitCode=[int]$process.ExitCode;stdout=$stdoutTask.Result;stderr=$stderrTask.Result}
   } catch {[pscustomobject]@{type='runner-error';exitCode=$null;stdout='';stderr=$_.Exception.ToString()}}
  } -ArgumentList $PowerShellPath,$LaunchScript,$Payload
  while($job.State -in @('NotStarted','Running')){if($PumpMessages){[Windows.Forms.Application]::DoEvents()};Start-Sleep -Milliseconds 5}
  $receiveErrors=@();$jobOutput=@(Receive-Job -Job $job -ErrorAction Continue -ErrorVariable receiveErrors);$jobErrors=@($receiveErrors | ForEach-Object {[string]$_.ToString()});$jobState=[string]$job.State
  $record=$jobOutput | Where-Object {$null -ne $_ -and $null -ne $_.PSObject.Properties['type']} | Select-Object -Last 1
  if($jobState -eq 'Failed'){$reason=$job.ChildJobs[0].JobStateInfo.Reason;$failure='inactive-window launcher job failed: '+(if($null -eq $reason){'unknown job failure'}else{$reason.ToString()})}
  elseif($jobErrors.Count -gt 0){$failure='inactive-window launcher job error: '+($jobErrors -join ' | ')}
  elseif($null -eq $record){$failure='inactive-window launcher produced no result'}
  else {
   if($null -ne $record.exitCode){$exitCode=[int]$record.exitCode};$stdout=[string]$record.stdout;$stderr=[string]$record.stderr
   if($record.type -eq 'runner-error'){$failure='inactive-window launcher runner failed: '+$stderr}
   elseif($exitCode -ne 0){$failure='inactive-window helper exited with code '+$exitCode+': '+$stderr.Trim()}
   elseif(-not [string]::IsNullOrWhiteSpace($stderr)){$failure='inactive-window helper wrote stderr: '+$stderr.Trim()}
   elseif([string]::IsNullOrWhiteSpace($stdout)){$failure='inactive-window helper produced no verdict'}
   else {
    $verdict=$null;try{$verdict=$stdout.Trim() | ConvertFrom-Json -ErrorAction Stop}catch{$failure='inactive-window helper produced invalid verdict: '+$_.Exception.Message}
    if($null -eq $failure){$hasOk=$null -ne $verdict -and $null -ne $verdict.PSObject.Properties['ok'];if(-not $hasOk){$failure='inactive-window helper verdict is missing ok'}elseif(-not [bool]$verdict.ok){$failure='inactive-window helper verdict reported ok=false'}else{$ok=$true}}
   }
  }
 } catch {$failure='inactive-window launcher setup failed: '+$_.Exception.Message}
 finally {if($job){try{if($job.State -in @('NotStarted','Running')){Stop-Job -Job $job -ErrorAction SilentlyContinue}}catch{};try{Remove-Job -Job $job -Force -ErrorAction SilentlyContinue}catch{}}}
 if($null -eq $failure -and -not $ok){$failure='inactive-window launcher failed without a reason'}
 return [pscustomobject][ordered]@{Ok=$ok;JobState=$jobState;ExitCode=$exitCode;Stdout=$stdout;Stderr=$stderr;JobOutput=@($jobOutput | ForEach-Object {try{$_ | ConvertTo-Json -Compress -Depth 8}catch{[string]$_}});JobErrors=$jobErrors;Failure=$failure}
}

function Write-LiveReport {
 param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)]$Report)
 $json=$Report | ConvertTo-Json -Depth 12 -Compress;[IO.File]::WriteAllText((Join-Path $Root 'report.json'),$json,[Text.UTF8Encoding]::new($false));return $json
}

if($FixturePath){
 $fixtureRoot=(Split-Path -Parent (Convert-Path -LiteralPath $FixturePath));$fixture=$null;$launcher=New-LiveLauncherResult;$metrics=[pscustomobject]@{TargetEvents=0;TargetForegroundEvents=0;TeardownForegroundEvents=0;StartupForegroundEvents=0;CallbackForegrounds=@()};$passed=$false;$failure=$null;$report=$null
 try {
  $fixture=Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json;$targetHwnd=[long]$fixture.targetHwnd;$startedTick=[long]$fixture.startedTick;$teardownStart=[long]$fixture.teardownStart;$payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('fixture'));$pwshPath=Join-Path $PSHOME 'pwsh.exe';if(-not (Test-Path -LiteralPath $pwshPath)){$pwshPath=(Get-Process -Id $PID).Path}
  $launcher=Invoke-InactiveWindowLauncher -LaunchScript ([string]$fixture.launcherScript) -Payload $payload -PowerShellPath $pwshPath;$metrics=Get-LiveEventMetrics -Events @($fixture.events) -TargetHwnd $targetHwnd -StartedTick $startedTick -TeardownStart $teardownStart;$failure=$launcher.Failure
  $passed=Test-LiveInactiveWindow -Hwnd $targetHwnd -Visible ([bool]$fixture.visible) -Minimized ([bool]$fixture.minimized) -TargetForegroundEvents $metrics.TargetForegroundEvents -LiveForegroundSamples ([int]$fixture.liveForegroundSamples) -Receipt ([bool]$fixture.receipt) -Closed ([bool]$fixture.closed) -FailureReason $failure
  if(-not $passed -and [string]::IsNullOrWhiteSpace($failure)){$failure='Inactive window acceptance failed'};$endTick=[Environment]::TickCount64;if($null -ne $fixture.endTick){$endTick=[long]$fixture.endTick}
  $report=[ordered]@{passed=$passed;root=$fixtureRoot;startedTick=$startedTick;endTick=$endTick;goneTick=0;baseline=0;visible=[bool]$fixture.visible;minimized=[bool]$fixture.minimized;startupForegroundEvents=$metrics.StartupForegroundEvents;foregroundEvents=$metrics.TargetEvents;targetForegroundEvents=$metrics.TargetForegroundEvents;teardownForegroundEvents=$metrics.TeardownForegroundEvents;callbackForegrounds=@($metrics.CallbackForegrounds);foregroundSamples=([int]$fixture.foregroundSamples);liveForegroundSamples=([int]$fixture.liveForegroundSamples);samples=([int]$fixture.samples);events=@($fixture.events);eventEvidence=@($fixture.events);hwnd=$targetHwnd;closed=[bool]$fixture.closed;launcherJobState=$launcher.JobState;launcherExitCode=$launcher.ExitCode;launcherStdout=$launcher.Stdout;launcherStderr=$launcher.Stderr;launcherJobOutput=@($launcher.JobOutput);launcherJobErrors=@($launcher.JobErrors);failure=$failure}
 } catch {$failure='inactive-window fixture failed: '+$_.Exception.Message;$passed=$false;if($null -eq $report){$report=[ordered]@{passed=$false;root=$fixtureRoot;events=@();eventEvidence=@();launcherJobState=$launcher.JobState;launcherExitCode=$launcher.ExitCode;launcherStdout=$launcher.Stdout;launcherStderr=$launcher.Stderr;launcherJobOutput=@($launcher.JobOutput);launcherJobErrors=@($launcher.JobErrors);failure=$failure}}else{$report.failure=$failure;$report.passed=$false}}
 $writeFailure=$null;try{$report.failure=$failure;$report.passed=$passed;$reportText=Write-LiveReport -Root $fixtureRoot -Report $report;Write-Output $reportText}catch{$writeFailure='inactive-window report write failed: '+$_.Exception.Message}
 if($writeFailure){[Console]::Error.WriteLine($writeFailure);exit 1};if(-not $passed){if($failure){[Console]::Error.WriteLine($failure)};exit 1};exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class InactiveWindowProbe {
 public delegate void EventProc(IntPtr h,uint e,IntPtr w,int o,int c,uint t,uint ms);
 public delegate bool EnumProc(IntPtr w,IntPtr p);
 // EventEvidence is event-time evidence; CallbackForegrounds is a separate diagnostic sample.
 public static List<long> Events=new List<long>();
 public static List<string> EventEvidence=new List<string>();
 public static List<long> CallbackForegrounds=new List<long>();
 public static List<string> Details=new List<string>();
 public static long EventTick(uint ms){long now=Environment.TickCount64;long candidate=(now & ~0xffffffffL)|ms;long delta=candidate-now;if(delta>2147483647L)candidate-=4294967296L;else if(delta<-2147483648L)candidate+=4294967296L;return candidate;}
 public static EventProc Callback=(h,e,w,o,c,t,ms)=>{long hwnd=w.ToInt64();long eventTick=EventTick(ms);long actual=GetForegroundWindow().ToInt64();Events.Add(hwnd);EventEvidence.Add(hwnd+":"+eventTick);CallbackForegrounds.Add(actual);Details.Add(hwnd+":"+eventTick+":actual="+actual);};
 [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint a,uint b,IntPtr m,EventProc p,uint process,uint thread,uint flags);
 [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr h);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr w,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr w,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr w);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr w);
 public static IntPtr Find(string title){IntPtr found=IntPtr.Zero;EnumWindows((w,p)=>{var s=new StringBuilder(1024);var c=new StringBuilder(256);GetWindowText(w,s,1024);GetClassName(w,c,256);if(s.ToString().Contains(title)&&(c.ToString()=="CASCADIA_HOSTING_WINDOW_CLASS"||c.ToString()=="ConsoleWindowClass"))found=w;return true;},IntPtr.Zero);return found;}
}
'@
$root=Join-Path $Workspace ('temp\inactive-window-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$title='ORCH-INACTIVE-'+[Guid]::NewGuid().ToString('N')
$probe=Join-Path $root 'probe.ps1'
$receipt=Join-Path $root 'receipt.json'
$escaped=$receipt.Replace("'","''")
[IO.File]::WriteAllText($probe,"`$Host.UI.RawUI.WindowTitle='$title'; [IO.File]::WriteAllText('$escaped','{`"executed`":true}'); Start-Sleep -Seconds 8",[Text.UTF8Encoding]::new($false))
$repo=Split-Path $PSScriptRoot -Parent
$wt=Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'
if($Terminal){$wt=$Terminal}
$request=@{file=$wt;parameters=('-w "'+$title+'" new-tab --title "'+$title+'" --suppressApplicationTitle pwsh.exe -NoProfile -File "'+$probe+'"');cwd=$Workspace} | ConvertTo-Json -Compress
if($Legacy){$request=@{file='pwsh.exe';parameters=('-NoProfile -File "'+$probe+'"');cwd=$Workspace} | ConvertTo-Json -Compress}
$payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($request))
$hook=[IntPtr]::Zero;$launcher=New-LiveLauncherResult
$seen=[IntPtr]::Zero;$visible=$false;$minimized=$false;$samples=0;$foregroundSamples=0;$startedTick=[Environment]::TickCount64;$baseline=[InactiveWindowProbe]::GetForegroundWindow().ToInt64()
$fgSampleTicks=New-Object System.Collections.Generic.List[long];$goneTick=0;$teardownStart=[long]::MaxValue;$eventMetrics=$null;$passed=$false;$failureReason=$null;$reportWriteFailure=$null
try {
 $hook=[InactiveWindowProbe]::SetWinEventHook(3,3,[IntPtr]::Zero,[InactiveWindowProbe]::Callback,0,0,0)
 if($hook -eq [IntPtr]::Zero){throw 'Cannot monitor foreground events'}
 $launchScript=Join-Path $repo 'scripts\core\inactive-window.ps1'
 $launcherPowerShell=Join-Path $PSHOME 'pwsh.exe'
 if(-not (Test-Path -LiteralPath $launcherPowerShell)){$launcherPowerShell=(Get-Process -Id $PID).Path}
 $launcher=Invoke-InactiveWindowLauncher -LaunchScript $launchScript -Payload $payload -PowerShellPath $launcherPowerShell -PumpMessages
 if(-not $launcher.Ok){throw $launcher.Failure}
 $until=[DateTime]::UtcNow.AddSeconds(20)
 while([DateTime]::UtcNow -lt $until){
  [Windows.Forms.Application]::DoEvents()
  $window=[InactiveWindowProbe]::Find($title)
  if($window -ne [IntPtr]::Zero){$seen=$window;$visible=$visible -or [InactiveWindowProbe]::IsWindowVisible($window);$minimized=$minimized -or [InactiveWindowProbe]::IsIconic($window);if([InactiveWindowProbe]::GetForegroundWindow() -eq $window){$foregroundSamples++;$fgSampleTicks.Add([long][Environment]::TickCount64)}}
  elseif($seen -ne [IntPtr]::Zero){$goneTick=[Environment]::TickCount64;break}
  $samples++;Start-Sleep -Milliseconds 5
 }
 [Windows.Forms.Application]::DoEvents()
 # Windows Terminal >= 1.24 may raise a closing tab during teardown. Keep that
 # short-lived external raise separate from the live acceptance window.
 $teardownStart=if($goneTick -gt 0){[long]$goneTick-400}else{[long]::MaxValue}
 $eventMetrics=Get-LiveEventMetrics -Events @([InactiveWindowProbe]::EventEvidence) -CallbackForegrounds @([InactiveWindowProbe]::CallbackForegrounds) -TargetHwnd $seen.ToInt64() -StartedTick $startedTick -TeardownStart $teardownStart
 $liveForegroundSamples=@($fgSampleTicks | Where-Object {$_ -lt $teardownStart}).Count
 $closed=([InactiveWindowProbe]::Find($title) -eq [IntPtr]::Zero)
 $passed=Test-LiveInactiveWindow -Hwnd $seen.ToInt64() -Visible $visible -Minimized $minimized -TargetForegroundEvents $eventMetrics.TargetForegroundEvents -LiveForegroundSamples $liveForegroundSamples -Receipt (Test-Path -LiteralPath $receipt) -Closed $closed
 if(-not $passed){$failureReason='Inactive window acceptance failed'}
} catch {
 $failureReason=$_.Exception.Message
 $passed=$false
} finally {
 $cleanupFailure=$null
 if($hook -ne [IntPtr]::Zero){try{[InactiveWindowProbe]::UnhookWinEvent($hook) | Out-Null}catch{$cleanupFailure=$_.Exception.Message}}
 if($cleanupFailure -and [string]::IsNullOrWhiteSpace($failureReason)){$failureReason='inactive-window cleanup failed: '+$cleanupFailure;$passed=$false}
 try {
  $teardownStart=if($goneTick -gt 0){[long]$goneTick-400}else{[long]::MaxValue}
  if($null -eq $eventMetrics){$eventMetrics=[pscustomobject]@{TargetEvents=0;TargetForegroundEvents=0;TeardownForegroundEvents=0;StartupForegroundEvents=0;CallbackForegrounds=@()}}
  $closed=([InactiveWindowProbe]::Find($title) -eq [IntPtr]::Zero)
  $report=[ordered]@{
   passed=$passed;root=$root;startedTick=$startedTick;endTick=[Environment]::TickCount64;goneTick=$goneTick;baseline=$baseline;visible=$visible;minimized=$minimized;
   startupForegroundEvents=$eventMetrics.StartupForegroundEvents;foregroundEvents=$eventMetrics.TargetEvents;targetForegroundEvents=$eventMetrics.TargetForegroundEvents;teardownForegroundEvents=$eventMetrics.TeardownForegroundEvents;
   callbackForegrounds=@($eventMetrics.CallbackForegrounds);foregroundSamples=$foregroundSamples;liveForegroundSamples=@($fgSampleTicks | Where-Object {$_ -lt $teardownStart}).Count;samples=$samples;
   events=@([InactiveWindowProbe]::Details);eventEvidence=@([InactiveWindowProbe]::EventEvidence);hwnd=$seen.ToInt64();closed=$closed;
   launcherJobState=$launcher.JobState;launcherExitCode=$launcher.ExitCode;launcherStdout=$launcher.Stdout;launcherStderr=$launcher.Stderr;launcherJobOutput=@($launcher.JobOutput);launcherJobErrors=@($launcher.JobErrors);failure=$failureReason
  }
  $reportText=Write-LiveReport -Root $root -Report $report
  Write-Output $reportText
 } catch {$reportWriteFailure='inactive-window report write failed: '+$_.Exception.Message}
}
if($reportWriteFailure){throw $reportWriteFailure}
if(-not $passed){throw $failureReason}
