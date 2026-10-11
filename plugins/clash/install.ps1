# Installs the self-contained Clash CLI/daemon (bundled Node, ffmpeg, ffprobe).
#
#   irm <release>/install.ps1 | iex
#   .\install.ps1 -Uninstall
#
# The archive is accepted only if its SHA-256 matches the release's SHA256SUMS.
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$baseUrl = if ($env:CLASH_RELEASE_BASE_URL) { $env:CLASH_RELEASE_BASE_URL } else { 'https://github.com/clash-art/clash/releases/download/cli-preview' }
$installDir = if ($env:CLASH_INSTALL_DIR) { $env:CLASH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\clash' }
$binDir = Join-Path $installDir 'bin'

function Set-UserPath([scriptblock]$Change) {
  $entries = @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ })
  [Environment]::SetEnvironmentVariable('Path', ((& $Change $entries) -join ';'), 'User')
}

if ($Uninstall) {
  # Project data lives under CLASH_HOME and is deliberately left alone.
  if (Test-Path $installDir) { Remove-Item -Recurse -Force $installDir }
  Set-UserPath { param($entries) $entries | Where-Object { $_ -ne $binDir } }
  Write-Host "Removed Clash from $installDir"
  return
}

$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($arch -ne 'X64') { throw "No self-contained Clash archive exists for Windows $arch yet." }
$target = 'win32-x64'

$work = Join-Path ([IO.Path]::GetTempPath()) ("clash-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force $work | Out-Null
try {
  $sums = Join-Path $work 'SHA256SUMS'
  Invoke-WebRequest -UseBasicParsing "$baseUrl/SHA256SUMS" -OutFile $sums
  $entry = Get-Content $sums | Where-Object { $_ -match "^[0-9a-f]{64}  clash-[0-9A-Za-z.+-]+-$target\.zip$" } | Select-Object -First 1
  if (-not $entry) { throw "This release has no archive for $target." }
  $expected, $archive = $entry -split '  ', 2
  $name = $archive -replace '\.zip$', ''
  $versionDir = Join-Path $installDir "versions\$name"

  if (-not (Test-Path (Join-Path $versionDir 'bin\clash.cmd'))) {
    Write-Host "Downloading $archive"
    $download = Join-Path $work $archive
    Invoke-WebRequest -UseBasicParsing "$baseUrl/$archive" -OutFile $download
    $actual = (Get-FileHash -Algorithm SHA256 $download).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "Checksum mismatch for ${archive}: expected $expected, got $actual." }
    $unpacked = Join-Path $work 'unpacked'
    New-Item -ItemType Directory -Force $unpacked | Out-Null
    & "$env:SystemRoot\System32\tar.exe" -xf $download -C $unpacked
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $unpacked 'package\bin\clash.cmd'))) {
      throw "$archive is not a self-contained Clash archive."
    }
    New-Item -ItemType Directory -Force (Split-Path $versionDir) | Out-Null
    if (Test-Path $versionDir) { Remove-Item -Recurse -Force $versionDir }
    Move-Item (Join-Path $unpacked 'package') $versionDir
  }

  # A small shim names the active version; the previous one stays on disk for a rollback.
  New-Item -ItemType Directory -Force $binDir | Out-Null
  Set-Content -Encoding ASCII (Join-Path $binDir 'clash.cmd') "@echo off`r`n`"$versionDir\bin\clash.cmd`" %*`r`n"
  Set-UserPath { param($entries) @($entries | Where-Object { $_ -ne $binDir }) + $binDir }
  Write-Host "Installed $name. Open a new terminal and run 'clash --version'."
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
