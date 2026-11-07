[CmdletBinding()]
param(
  [string]$KeyPath,
  [string]$BrowserPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$workRoot = $null
$succeeded = $false

try {
  if (-not $KeyPath) { $KeyPath = Join-Path $projectRoot "env\Video Audio Panner.pem" }
  $keyFile = [System.IO.Path]::GetFullPath($KeyPath)
  if (-not (Test-Path -LiteralPath $keyFile -PathType Leaf)) {
    throw "Signing key not found: $keyFile. Specify -KeyPath to reuse your existing .pem file."
  }

  if (-not $BrowserPath) { $BrowserPath = $env:EDGE_PATH }
  if (-not $BrowserPath) {
    $candidates = @(
      @($env:LOCALAPPDATA, "Microsoft\Edge SxS\Application\msedge.exe"),
      @(${env:ProgramFiles(x86)}, "Microsoft\Edge\Application\msedge.exe"),
      @($env:ProgramFiles, "Microsoft\Edge\Application\msedge.exe"),
      @($env:LOCALAPPDATA, "Microsoft\Edge\Application\msedge.exe")
    )
    foreach ($candidate in $candidates) {
      if ($candidate[0]) {
        $candidatePath = Join-Path $candidate[0] $candidate[1]
        if (Test-Path -LiteralPath $candidatePath -PathType Leaf) {
          $BrowserPath = $candidatePath
          break
        }
      }
    }
  }
  if (-not $BrowserPath -or -not (Test-Path -LiteralPath $BrowserPath -PathType Leaf)) {
    throw "Microsoft Edge was not found. Specify -BrowserPath or set EDGE_PATH to msedge.exe."
  }
  $browserExe = [System.IO.Path]::GetFullPath($BrowserPath)

  $manifest = Get-Content -LiteralPath (Join-Path $projectRoot "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $version = [string]$manifest.version
  if ($version -notmatch '^\d+(\.\d+){0,3}$') { throw "Invalid manifest version: $version" }

  # Explicit allowlist: never copy signing keys, tests, or browser profiles.
  $files = @("manifest.json", "background.js", "content.js")
  foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $file) -PathType Leaf)) { throw "Required file not found: $file" }
  }
  $references = @($manifest.background.service_worker) + @($manifest.content_scripts | ForEach-Object { $_.js })
  foreach ($reference in $references) {
    if ($reference -notin $files) { throw "Manifest references $reference. Update the packaging allowlist before building." }
  }

  $outputRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "crx"))
  $outputPath = Join-Path $outputRoot "Video Audio Panner-$version.crx"
  $envRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "env"))
  $workRoot = Join-Path $envRoot ("pack-" + [guid]::NewGuid().ToString("N"))
  $stageRoot = Join-Path $workRoot "extension"
  $packedCrx = "$stageRoot.crx"
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $stageRoot }

  Write-Host "Version: $version"
  Write-Host "Browser: $browserExe"
  Write-Host "Packing extension..."
  $stderrPath = Join-Path $workRoot "stderr.log"
  $packArguments = @(
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update",
    ('--user-data-dir="{0}"' -f (Join-Path $workRoot "browser-profile")),
    ('--pack-extension="{0}"' -f $stageRoot),
    ('--pack-extension-key="{0}"' -f $keyFile)
  )
  $packProcess = Start-Process -FilePath $browserExe -ArgumentList $packArguments -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $workRoot "stdout.log") -RedirectStandardError $stderrPath
  try {
    # Retain the handle so Windows PowerShell 5.1 can read a fast process's exit code.
    $null = $packProcess.Handle
    if (-not $packProcess.WaitForExit(30000)) {
      Stop-Process -Id $packProcess.Id -Force -ErrorAction SilentlyContinue
      throw "Edge packaging timed out after 30 seconds."
    }
    $packExitCode = $packProcess.ExitCode
  } finally {
    $packProcess.Dispose()
  }
  if ($packExitCode -ne 0 -or -not (Test-Path -LiteralPath $packedCrx -PathType Leaf)) {
    $details = (Get-Content -LiteralPath $stderrPath -Tail 10 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
    throw "Edge failed to create the CRX (exit $packExitCode). $details"
  }

  # Validate the CRX3 container and the exact source contents before publishing.
  Add-Type -AssemblyName System.IO.Compression
  $bytes = [System.IO.File]::ReadAllBytes($packedCrx)
  if ($bytes.Length -lt 12 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne "Cr24" -or [BitConverter]::ToUInt32($bytes, 4) -ne 3) {
    throw "Edge produced an invalid CRX3 file."
  }
  $zipOffset = 12L + [BitConverter]::ToUInt32($bytes, 8)
  if ($zipOffset -ge $bytes.Length) { throw "Invalid CRX3 archive offset." }
  $zipStream = New-Object System.IO.MemoryStream
  $archive = $null
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $zipStream.Write($bytes, [int]$zipOffset, $bytes.Length - [int]$zipOffset)
    $zipStream.Position = 0
    $archive = [System.IO.Compression.ZipArchive]::new($zipStream, [System.IO.Compression.ZipArchiveMode]::Read)
    $entries = @($archive.Entries)
    if ($entries.Count -ne $files.Count -or (Compare-Object ($files | Sort-Object) ($entries.FullName | Sort-Object))) {
      throw "Unexpected package contents. Only the three runtime files are allowed."
    }
    foreach ($entry in $entries) {
      $entryStream = $entry.Open()
      try { $entryHash = [Convert]::ToBase64String($hasher.ComputeHash($entryStream)) } finally { $entryStream.Dispose() }
      $sourceHash = [Convert]::ToBase64String($hasher.ComputeHash([System.IO.File]::ReadAllBytes((Join-Path $stageRoot $entry.FullName))))
      if ($entryHash -ne $sourceHash) { throw "Packaged contents do not match the source: $($entry.FullName)" }
    }
    $stagedManifest = Get-Content -LiteralPath (Join-Path $stageRoot "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($stagedManifest.version -ne $version) { throw "Manifest version changed during packaging. Run again." }
  } finally {
    if ($archive) { $archive.Dispose() }
    $zipStream.Dispose()
    $hasher.Dispose()
  }

  # Both move targets must stay inside the intended workspace directories.
  $sourcePath = [System.IO.Path]::GetFullPath($packedCrx)
  $targetPath = [System.IO.Path]::GetFullPath($outputPath)
  if (-not $sourcePath.StartsWith($workRoot + "\", [StringComparison]::OrdinalIgnoreCase) -or
      -not $targetPath.StartsWith($outputRoot + "\", [StringComparison]::OrdinalIgnoreCase)) { throw "Invalid package output path." }
  New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
  if (Test-Path -LiteralPath $targetPath) {
    [System.IO.File]::Replace($sourcePath, $targetPath, (Join-Path $workRoot "previous.crx"))
  } else {
    [System.IO.File]::Move($sourcePath, $targetPath)
  }
  $succeeded = $true
  Write-Host "Created: $targetPath"
  Write-Host "Verified: CRX3, version $version, three runtime files, no signing key."
} catch {
  [Console]::Error.WriteLine("CRX creation failed: " + $_.Exception.Message)
  if ($workRoot) { [Console]::Error.WriteLine("Working files: " + $workRoot) }
  exit 1
} finally {
  if ($succeeded -and $workRoot) {
    $cleanupPath = [System.IO.Path]::GetFullPath($workRoot)
    $cleanupParent = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "env")) + "\"
    if ($cleanupPath.StartsWith($cleanupParent, [StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFileName($cleanupPath) -match '^pack-[0-9a-f]{32}$') {
      Remove-Item -LiteralPath $cleanupPath -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
