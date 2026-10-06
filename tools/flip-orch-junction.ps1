param([Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}$') {
  throw 'invalid release version: only a single safe path segment is allowed'
}
if (-not $env:USERPROFILE) { throw 'USERPROFILE is required' }
function Normalize-Path([string]$Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}
function Get-SafeDirectory([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Label missing: $Path" }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $item.PSIsContainer) { throw "$Label is not a directory: $Path" }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label is a reparse point: $Path" }
  return $item
}
function Get-OptionalItem([string]$Path) {
  try { return Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
  catch [System.Management.Automation.ItemNotFoundException] { return $null }
}
function Is-Descendant([string]$Parent, [string]$Child) {
  $prefix = (Normalize-Path $Parent) + [IO.Path]::DirectorySeparatorChar
  return (Normalize-Path $Child).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}
$root = Normalize-Path (Join-Path $env:USERPROFILE '.tools')
$nodeFresh = Join-Path $root 'node24-fresh'
$jParent = Join-Path $nodeFresh 'node_modules'
$j = Join-Path $jParent 'open-tui-orchestrator'
$releases = Join-Path $root 'releases'
$versionRoot = Join-Path $releases $Version

# Validate the complete release ancestry before touching the current junction.
$null = Get-SafeDirectory $root 'tools root'
$null = Get-SafeDirectory $releases 'releases root'
$null = Get-SafeDirectory $versionRoot 'release version directory'
$t = Join-Path $versionRoot 'open-tui-orchestrator'
$null = Get-SafeDirectory $t 'release target'
if (-not (Is-Descendant $releases $t)) { throw "release target escapes releases root: $t" }
$null = Get-SafeDirectory $nodeFresh 'node24-fresh root'
$null = Get-SafeDirectory $jParent 'junction parent'

$targetFull = Normalize-Path $t
$previousTarget = $null
$previousTargetRaw = $null
$item = Get-OptionalItem $j
if ($item) {
  if (-not $item.PSIsContainer) { throw "existing path is not a directory junction/reparse point: $j" }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
    throw "existing path is not a junction/reparse point: $j"
  }
  if ([string]$item.LinkType -and [string]$item.LinkType -ne 'Junction') {
    throw "existing path is not a directory junction: $j (type=$($item.LinkType))"
  }
  $targets = @($item.Target | Where-Object { $_ })
  if ($targets.Count -ne 1) { throw "existing link has no single target: $j" }
  $previousTargetRaw = [string]$targets[0]
  $previousTarget = Normalize-Path $previousTargetRaw
  if (-not (Test-Path -LiteralPath $previousTarget -PathType Container)) {
    throw "existing junction target is missing or not a directory: $previousTarget"
  }
  Write-Output "current -> $previousTarget"
  if ([String]::Equals($previousTarget, $targetFull, [StringComparison]::OrdinalIgnoreCase)) {
    Write-Output 'already on target (no-op)'
    exit 0
  }
}
$removedPrevious = $false
try {
  if ($item) {
    Remove-Item -LiteralPath $j -Force -ErrorAction Stop
    $removedPrevious = $true
  }
  if (Get-OptionalItem $j) { throw 'junction still present after removal' }
  New-Item -ItemType Junction -Path $j -Target $targetFull -ErrorAction Stop | Out-Null
  $nowItem = Get-OptionalItem $j
  if (-not $nowItem) { throw 'new junction is missing after creation' }
  if (($nowItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'new path is not a reparse point' }
  if ([string]$nowItem.LinkType -and [string]$nowItem.LinkType -ne 'Junction') { throw 'new path is not a directory junction' }
  $nowTargets = @($nowItem.Target | Where-Object { $_ })
  if ($nowTargets.Count -ne 1) { throw 'new junction has no single target' }
  $now = Normalize-Path ([string]$nowTargets[0])
  if (-not [String]::Equals($now, $targetFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "junction target mismatch: $now"
  }
} catch {
  $primaryError = $_
  $rollbackErrors = @()
  if ($removedPrevious -and $previousTarget) {
    try {
      $existing = Get-OptionalItem $j
      if ($existing) { Remove-Item -LiteralPath $j -Force -ErrorAction Stop }
    } catch {
      $rollbackErrors += "remove new link: $($_.Exception.Message)"
    }
    try {
      if (-not (Get-OptionalItem $j)) {
        New-Item -ItemType Junction -Path $j -Target $previousTarget -ErrorAction Stop | Out-Null
      }
    } catch {
      $rollbackErrors += "restore original link: $($_.Exception.Message)"
    }
  }
  if ($rollbackErrors.Count) {
    throw ("junction switch failed: {0}; rollback failed: {1}" -f $primaryError.Exception.Message, ($rollbackErrors -join ' | '))
  }
  throw $primaryError
}
Write-Output "now     -> $now"
Write-Output "OK junction -> $Version"
