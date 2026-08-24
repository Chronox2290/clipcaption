# Downloads the sidecar binaries (ffmpeg, ffprobe, whisper-cli, and the
# sherpa-onnx speaker-diarization tool + its two .onnx models) for Windows x64
# and places them in src-tauri/binaries with the target-triple names Tauri expects.
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File scripts/get-sidecars.ps1

$ErrorActionPreference = "Stop"
$triple = "x86_64-pc-windows-msvc"
$root = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $root "src-tauri\binaries"
$tmp = Join-Path $env:TEMP "clipcaption-sidecars"

# Everything below runs inside this try block for one specific reason: a
# script invoked as `powershell -File foo.ps1` does NOT set a non-zero
# process exit code just because an unhandled terminating error (including
# Write-Error under $ErrorActionPreference = "Stop") reached the top level -
# that's a real PowerShell wart, not a hypothetical one. It's exactly what
# let a real extraction failure silently pass this script as "succeeded" in
# CI once (the Tauri build then failed much later and far more confusingly,
# on a missing resource file, instead of failing here with a clear message).
# The explicit `exit 1` in the catch is what actually fails the CI step.
try {

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Done($name) {
    Test-Path (Join-Path $binDir "$name-$triple.exe")
}

# Extracts a .tar.bz2. Tries Windows' own inbox tar.exe (bsdtar) first - it
# ships with every Windows 10 1803+/11 install and every GitHub Actions
# windows-latest runner, so this needs nothing extra on a normal PC. Falls
# back to 7-Zip only if tar isn't present or couldn't handle this archive
# (bz2 support in Windows' bundled tar isn't guaranteed on every build/SKU,
# and this is genuinely how the very first release build broke - see the
# build log). 7-Zip ships on GitHub's runners with no setup needed; on a
# real PC it needs to actually be installed, so the error message if BOTH
# fail says so explicitly instead of leaving a bare "not found".
#
# Checks $LASTEXITCODE explicitly after every native command, since a
# non-zero exit from an external tool does NOT become a PowerShell
# terminating error on its own, even under $ErrorActionPreference = "Stop" -
# only cmdlets and Write-Error get that treatment. This is the same class of
# bug that let the original CI failure here pass silently; see the
# try/catch wrapping the whole script below for the other half of that fix.
function Expand-TarBz2($archivePath, $destDir) {
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null

    $tarOk = $false
    if (Get-Command tar -ErrorAction SilentlyContinue) {
        & tar -xf $archivePath -C $destDir 2>$null
        if ($LASTEXITCODE -eq 0) { $tarOk = $true }
    }

    if (-not $tarOk) {
        if (-not (Get-Command 7z -ErrorAction SilentlyContinue)) {
            throw "Could not extract '$archivePath': Windows' built-in tar didn't work and 7-Zip (7z) isn't installed either. Install 7-Zip from https://www.7-zip.org/ (default settings are fine) and run this again."
        }
        & 7z x $archivePath "-o$tmp" -y | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "7z failed to decompress '$archivePath' (exit code $LASTEXITCODE)"
        }
        $tarPath = Join-Path $tmp ([System.IO.Path]::GetFileNameWithoutExtension($archivePath))
        if (-not (Test-Path $tarPath)) {
            throw "Expected '$tarPath' after decompressing '$archivePath' but it isn't there"
        }
        & 7z x $tarPath "-o$destDir" -y | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "7z failed to extract '$tarPath' (exit code $LASTEXITCODE)"
        }
    }
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
    # print a warning and exit 1 - match the real whisper-cli.exe exactly.
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

# ---------------- speaker diarization (sherpa-onnx) ----------------
# Real voice-fingerprint speaker diarization, replacing whisper.cpp's
# tinydiarize turn-alternation (see src-tauri/src/diarize.rs for why).
# A standalone C++ CLI (no Python/PyTorch), pinned to a specific release
# rather than "latest" since these asset URLs were hand-verified.
function DoneData($name) {
    Test-Path (Join-Path $binDir $name)
}

if ((Done "sherpa-onnx-offline-speaker-diarization") -and
    (DoneData "sherpa-pyannote-segmentation.onnx") -and
    (DoneData "sherpa-embedding.onnx")) {
    Write-Host "Speaker diarization sidecar + models already present, skipping."
} else {
    $sherpaVer = "1.12.15"

    Write-Host "Downloading sherpa-onnx v$sherpaVer (speaker diarization)..."
    $sherpaTar = Join-Path $tmp "sherpa-onnx.tar.bz2"
    Invoke-WebRequest -Uri "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$sherpaVer/sherpa-onnx-v$sherpaVer-win-x64-static.tar.bz2" -OutFile $sherpaTar
    $sherpaDir = Join-Path $tmp "sherpa-onnx"
    if (Test-Path $sherpaDir) { Remove-Item -Recurse -Force $sherpaDir }
    Expand-TarBz2 $sherpaTar $sherpaDir
    $sherpaExe = Get-ChildItem -Path $sherpaDir -Recurse -Filter "sherpa-onnx-offline-speaker-diarization.exe" | Select-Object -First 1
    if (-not $sherpaExe) {
        Write-Error "sherpa-onnx-offline-speaker-diarization.exe not found in the sherpa-onnx release archive. Download manually from https://github.com/k2-fsa/sherpa-onnx/releases and place it in src-tauri\binaries as sherpa-onnx-offline-speaker-diarization-$triple.exe"
    }
    Copy-Item $sherpaExe.FullName (Join-Path $binDir "sherpa-onnx-offline-speaker-diarization-$triple.exe") -Force
    Write-Host "sherpa-onnx diarization binary installed."

    Write-Host "Downloading pyannote segmentation model..."
    $segTar = Join-Path $tmp "sherpa-seg.tar.bz2"
    Invoke-WebRequest -Uri "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2" -OutFile $segTar
    $segDir = Join-Path $tmp "sherpa-seg"
    if (Test-Path $segDir) { Remove-Item -Recurse -Force $segDir }
    Expand-TarBz2 $segTar $segDir
    $segModel = Get-ChildItem -Path $segDir -Recurse -Filter "model.onnx" | Select-Object -First 1
    if (-not $segModel) {
        Write-Error "model.onnx not found in the pyannote segmentation archive. Download manually and place it in src-tauri\binaries as sherpa-pyannote-segmentation.onnx"
    }
    Copy-Item $segModel.FullName (Join-Path $binDir "sherpa-pyannote-segmentation.onnx") -Force
    Write-Host "Segmentation model installed."

    Write-Host "Downloading speaker embedding model..."
    Invoke-WebRequest -Uri "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx" -OutFile (Join-Path $binDir "sherpa-embedding.onnx")
    Write-Host "Embedding model installed."
}

Write-Host ""
Write-Host "All sidecars ready in src-tauri\binaries:"
Get-ChildItem $binDir | ForEach-Object { Write-Host "  $($_.Name)" }

} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
