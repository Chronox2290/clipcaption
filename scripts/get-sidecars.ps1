# Downloads the sidecar binaries (ffmpeg, ffprobe, whisper-cli) for Windows x64
# and places them in src-tauri/binaries with the target-triple names Tauri expects.
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File scripts/get-sidecars.ps1

$ErrorActionPreference = "Stop"
$triple = "x86_64-pc-windows-msvc"
$root = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $root "src-tauri\binaries"
$tmp = Join-Path $env:TEMP "clipcaption-sidecars"

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Done($name) {
    Test-Path (Join-Path $binDir "$name-$triple.exe")
}

# ---------------- ffmpeg + ffprobe ----------------
if ((Done "ffmpeg") -and (Done "ffprobe")) {
    Write-Host "ffmpeg/ffprobe already present, skipping."
} else {
    Write-Host "Downloading ffmpeg (gyan.dev release-essentials)..."
    $ffZip = Join-Path $tmp "ffmpeg.zip"
    Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $ffZip
    $ffDir = Join-Path $tmp "ffmpeg"
    if (Test-Path $ffDir) { Remove-Item -Recurse -Force $ffDir }
    Expand-Archive -Path $ffZip -DestinationPath $ffDir
    $ffmpegExe = Get-ChildItem -Path $ffDir -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    $ffprobeExe = Get-ChildItem -Path $ffDir -Recurse -Filter "ffprobe.exe" | Select-Object -First 1
    Copy-Item $ffmpegExe.FullName (Join-Path $binDir "ffmpeg-$triple.exe") -Force
    Copy-Item $ffprobeExe.FullName (Join-Path $binDir "ffprobe-$triple.exe") -Force
    Write-Host "ffmpeg + ffprobe installed."
}

# ---------------- whisper-cli ----------------
if (Done "whisper-cli") {
    Write-Host "whisper-cli already present, skipping."
} else {
    Write-Host "Finding latest whisper.cpp Windows build..."
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest" -Headers @{ "User-Agent" = "clipcaption-setup" }
    $asset = $rel.assets | Where-Object { $_.name -match "bin-x64" -and $_.name -match "\.zip$" } | Select-Object -First 1
    if (-not $asset) {
        # fall back: any windows x64 zip
        $asset = $rel.assets | Where-Object { $_.name -match "(?i)win.*x64.*\.zip$" } | Select-Object -First 1
    }
    if (-not $asset) {
        Write-Error "Could not find a Windows x64 asset in the latest whisper.cpp release. Download manually from https://github.com/ggml-org/whisper.cpp/releases and place whisper-cli.exe (plus its DLLs) in src-tauri\binaries as whisper-cli-$triple.exe"
    }
    Write-Host "Downloading $($asset.name)..."
    $wZip = Join-Path $tmp "whisper.zip"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $wZip
    $wDir = Join-Path $tmp "whisper"
    if (Test-Path $wDir) { Remove-Item -Recurse -Force $wDir }
    Expand-Archive -Path $wZip -DestinationPath $wDir
    # IMPORTANT: the zip also ships deprecation STUBS (e.g. main.exe) that just
    # print a warning and exit 1 — match the real whisper-cli.exe exactly.
    $cli = Get-ChildItem -Path $wDir -Recurse -Filter "whisper-cli.exe" | Select-Object -First 1
    if (-not $cli) {
        $cli = Get-ChildItem -Path $wDir -Recurse -Filter "whisper-command.exe" | Select-Object -First 1
    }
    if (-not $cli) { Write-Error "whisper-cli.exe not found inside $($asset.name)" }
    Copy-Item $cli.FullName (Join-Path $binDir "whisper-cli-$triple.exe") -Force
    # whisper-cli needs its DLLs next to it (ggml.dll, whisper.dll, ...)
    Get-ChildItem -Path $cli.DirectoryName -Filter "*.dll" | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $binDir $_.Name) -Force
    }
    Write-Host "whisper-cli installed."
}

Write-Host ""
Write-Host "All sidecars ready in src-tauri\binaries:"
Get-ChildItem $binDir | ForEach-Object { Write-Host "  $($_.Name)" }
