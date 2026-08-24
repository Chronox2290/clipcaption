# Builds src-tauri/embed-tool's extract-embedding.exe: a small custom sidecar
# that ClipCaption's speaker-names feature needs to work correctly, and which
# nobody publishes prebuilt (see src-tauri/embed-tool/extract_embedding.cpp's
# top comment for what it does and why it has to be built from source here
# instead of just downloaded like the other sidecars).
#
# Downloads its own copy of the sherpa-onnx static release (same version
# get-sidecars.ps1 uses) purely for its headers + .lib files - this is a
# *build-time* dependency of this one small tool, separate from the sidecar
# binaries get-sidecars.ps1 fetches for the app to run at runtime.
#
# Requires CMake + an MSVC toolchain. GitHub's windows-latest runners ship
# both out of the box, so `cmake -B ...` picks up Visual Studio's generator
# automatically with no extra setup step needed. On a dev PC without Visual
# Studio installed, this script will fail clearly (CMake reports no
# generator found) rather than silently doing nothing - install "Desktop
# development with C++" via the Visual Studio Installer, or Build Tools for
# Visual Studio, if you need to build this locally.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $root "src-tauri\binaries"
$tmp = Join-Path $env:TEMP "clipcaption-embed-tool"
$triple = "x86_64-pc-windows-msvc"

try {

New-Item -ItemType Directory -Force -Path $tmp | Out-Null
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$destExe = Join-Path $binDir "extract-embedding-$triple.exe"
if (Test-Path $destExe) {
    Write-Host "extract-embedding already built, skipping."
} else {
    $sherpaVer = "1.12.15"
    $sherpaTar = Join-Path $tmp "sherpa-onnx-static.tar.bz2"
    Write-Host "Downloading sherpa-onnx v$sherpaVer static libs (build-time only, for compiling extract-embedding)..."
    Invoke-WebRequest -Uri "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$sherpaVer/sherpa-onnx-v$sherpaVer-win-x64-static.tar.bz2" -OutFile $sherpaTar

    $sherpaDir = Join-Path $tmp "sherpa-onnx-static"
    if (Test-Path $sherpaDir) { Remove-Item -Recurse -Force $sherpaDir }
    New-Item -ItemType Directory -Force -Path $sherpaDir | Out-Null

    # Windows' inbox tar (bsdtar) handles .tar.bz2 fine - already proven
    # working in this exact CI job by the "Fetch sidecar binaries" step,
    # which extracts the very same archive format for get-sidecars.ps1.
    if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
        throw "Windows' built-in tar wasn't found - can't extract '$sherpaTar'."
    }
    & tar -xf $sherpaTar -C $sherpaDir
    if ($LASTEXITCODE -ne 0) {
        throw "tar failed to extract '$sherpaTar' (exit code $LASTEXITCODE)"
    }

    $extractedRoot = Get-ChildItem -Path $sherpaDir -Directory | Select-Object -First 1
    if (-not $extractedRoot) {
        throw "Nothing extracted from '$sherpaTar'"
    }

    Write-Host "Configuring extract-embedding with CMake..."
    $buildDir = Join-Path $tmp "build"
    & cmake -B $buildDir -S (Join-Path $root "src-tauri\embed-tool") "-DSHERPA_ONNX_DIR=$($extractedRoot.FullName)"
    if ($LASTEXITCODE -ne 0) { throw "cmake configure failed (exit code $LASTEXITCODE)" }

    Write-Host "Building extract-embedding (Release)..."
    & cmake --build $buildDir --config Release
    if ($LASTEXITCODE -ne 0) { throw "cmake build failed (exit code $LASTEXITCODE)" }

    $exe = Get-ChildItem -Path $buildDir -Recurse -Filter "extract-embedding.exe" | Select-Object -First 1
    if (-not $exe) { throw "extract-embedding.exe not found anywhere under $buildDir after a successful-looking build" }

    Copy-Item $exe.FullName $destExe -Force
    Write-Host "extract-embedding installed."
}

} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
