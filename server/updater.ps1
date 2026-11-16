<#
.SYNOPSIS
Stage a release ZIP, then install it after the parent application exits.
.DESCRIPTION
Prepare validates archive paths and package contents without touching the installation.
Install backs up overwritten program files, restores them on failure and relaunches the app.
.PARAMETER Mode
Prepare extracts and validates; Install replaces files after waiting for ParentPid.
.PARAMETER ArchivePath
Downloaded ZIP used by Prepare.
.PARAMETER StagePath
Portable extraction directory used by Prepare.
.PARAMETER PackageRoot
Validated extracted directory containing both application and parser executables.
.PARAMETER TargetPath
Existing installation directory to update in place.
.PARAMETER UpdatePath
Temporary update directory directly beneath TargetPath; also contains rollback copies.
.PARAMETER ParentPid
Application process that must exit before program files are replaced.
.PARAMETER Port
Listening port to preserve when relaunching.
.PARAMETER SkipLaunch
Test-only switch that exercises installation without starting the resulting executable.
#>
param(
  [ValidateSet('Prepare', 'Install')][string]$Mode,
  [string]$ArchivePath,
  [string]$StagePath,
  [string]$PackageRoot,
  [string]$TargetPath,
  [string]$UpdatePath,
  [int]$ParentPid,
  [int]$Port = 80,
  [switch]$SkipLaunch
)

$ErrorActionPreference = 'Stop'

<#
.SYNOPSIS
Validate package contents and return the program files eligible for installation.
.PARAMETER root
Extracted package root, already checked to lie beneath the staging directory.
.OUTPUTS
FileInfo records; throws if either executable is absent or portable user data is included.
#>
function PackageFiles([string]$root) {
  $files = @(Get-ChildItem -LiteralPath $root -Recurse -File)
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($root.TrimEnd('\').Length + 1)
    if ($relative -match '^(?i:maps|reader|work|release)\\' -or
        $relative -match '^(?i:config\.json|database\.db(?:-.+)?|map\.png|replay\.json|saved-queries\.json|settings\.json|map-calibration\.json|update-error\.log)$' -or
        $relative -match '(?i:\.replay$)') {
      throw "The release archive includes local data: $relative"
    }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'SniperHunter.exe') -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $root 'SniperHunterParser.exe') -PathType Leaf)) {
    throw 'The release archive must contain SniperHunter.exe and SniperHunterParser.exe.'
  }
  return $files
}

if ($Mode -eq 'Prepare') {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $stageFull = [IO.Path]::GetFullPath($StagePath).TrimEnd('\')
  $stagePrefix = $stageFull + '\'
  New-Item -ItemType Directory -Force -Path $stageFull | Out-Null
  $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $uncompressed = [long]0
    $seen = @{}
    if ($archive.Entries.Count -gt 20000) { throw 'The release archive has too many entries.' }
    foreach ($entry in $archive.Entries) {
      $relative = $entry.FullName.Replace('/', '\')
      if (-not $relative -or [IO.Path]::IsPathRooted($relative) -or $relative.Contains(':')) {
        throw "Unsafe archive path: $relative"
      }
      $destination = [IO.Path]::GetFullPath((Join-Path $stageFull $relative))
      if (-not $destination.StartsWith($stagePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe archive path: $relative"
      }
      $key = $destination.ToLowerInvariant()
      if ($seen.ContainsKey($key)) { throw "Duplicate archive path: $relative" }
      $seen[$key] = $true
      $uncompressed += $entry.Length
      if ($uncompressed -gt 4GB) { throw 'The release archive expands beyond 4 GB.' }
      if (-not $entry.Name) {
        New-Item -ItemType Directory -Force -Path $destination | Out-Null
      } else {
        New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination)) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
      }
    }
  } finally { $archive.Dispose() }
  $package = $stageFull
  if (-not (Test-Path -LiteralPath (Join-Path $package 'SniperHunter.exe'))) {
    $children = @(Get-ChildItem -LiteralPath $stageFull -Directory)
    if ($children.Count -ne 1) { throw 'The release archive needs its program files at the root or inside one folder.' }
    $package = $children[0].FullName
  }
  [void](PackageFiles $package)
  Write-Output $package
  exit 0
}

$targetFull = [IO.Path]::GetFullPath($TargetPath).TrimEnd('\')
$updateFull = [IO.Path]::GetFullPath($UpdatePath).TrimEnd('\')
if (-not $updateFull.StartsWith($targetFull + '\.sniperhunter-update-', [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetDirectoryName($updateFull) -ne $targetFull) {
  throw 'The temporary update directory is outside the program folder.'
}
$backup = Join-Path $updateFull 'backup'
$changed = New-Object 'System.Collections.Generic.List[string]'
[IO.File]::WriteAllText((Join-Path $updateFull 'helper-started.flag'), 'started')
try {
  $files = @(PackageFiles $PackageRoot)
  for ($attempt = 0; $attempt -lt 180; $attempt++) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { throw 'Sniper Hunter did not exit for the update.' }
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($PackageRoot.TrimEnd('\').Length + 1)
    $destination = Join-Path $targetFull $relative
    $previous = Join-Path $backup $relative
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination)) | Out-Null
    if (Test-Path -LiteralPath $destination) {
      New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($previous)) | Out-Null
      Copy-Item -LiteralPath $destination -Destination $previous -Force
    }
    $changed.Add($relative)
    $copied = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      try { Copy-Item -LiteralPath $file.FullName -Destination $destination -Force; $copied = $true; break }
      catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $copied) { throw "Could not replace $relative" }
  }
  $arguments = @('--no-browser')
  if ($Port -ne 80) { $arguments += @('-port', [string]$Port) }
  if (-not $SkipLaunch) {
    Start-Process -FilePath (Join-Path $targetFull 'SniperHunter.exe') -WorkingDirectory $targetFull -ArgumentList $arguments -WindowStyle Hidden
  }
  # The archive and its extracted files are temporary; local data stays in the program folder.
  try { Remove-Item -LiteralPath $updateFull -Recurse -Force }
  catch {
    # A shell may briefly hold its script open. At minimum, remove the downloaded ZIP.
    Get-ChildItem -LiteralPath $updateFull -Filter '*.zip' -File | Remove-Item -Force
  }
} catch {
  $failure = $_.ToString()
  foreach ($relative in $changed) {
    $destination = Join-Path $targetFull $relative
    $previous = Join-Path $backup $relative
    try {
      if (Test-Path -LiteralPath $previous) { Copy-Item -LiteralPath $previous -Destination $destination -Force }
      else { Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue }
    } catch { $failure += "`nRollback failed for ${relative}: $_" }
  }
  [IO.File]::WriteAllText((Join-Path $targetFull 'update-error.log'), $failure)
  $oldExe = Join-Path $targetFull 'SniperHunter.exe'
  if (-not $SkipLaunch -and (Test-Path -LiteralPath $oldExe)) {
    $arguments = @('--no-browser')
    if ($Port -ne 80) { $arguments += @('-port', [string]$Port) }
    Start-Process -FilePath $oldExe -WorkingDirectory $targetFull -ArgumentList $arguments -WindowStyle Hidden
  }
  exit 1
}
