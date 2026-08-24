# Builds an installer on this machine, without needing the updater signing key.
#
# The signing key only lives in GitHub Actions secrets, and tauri.conf.json
# sets createUpdaterArtifacts: true - so a plain `npm run tauri build` here
# fails asking for TAURI_SIGNING_PRIVATE_KEY. tauri.local.conf.json turns that
# one setting off, which is the only difference between this and a release
# build. The result installs and runs normally; it just can't be served to the
# in-app updater, because nothing signed it.
#
# Run via BUILD-EXE.cmd, or directly:
#   powershell -ExecutionPolicy Bypass -File scripts/build-local.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

try {

Push-Location $root
try {
    Write-Host "Building a local installer (optimized release build - several minutes)..."
    npx tauri build --config src-tauri/tauri.local.conf.json
    # A native command's non-zero exit is NOT a terminating PowerShell error,
    # even under $ErrorActionPreference = "Stop" - check it by hand, or a
    # failed build reports success.
    if ($LASTEXITCODE -ne 0) {
        Write-Error "tauri build failed (exit $LASTEXITCODE) - scroll up for the compiler or bundler error."
    }
} finally {
    Pop-Location
}

# Forward slashes deliberately: PowerShell accepts them in paths, and they
# survive being passed around by tooling that treats backslashes as escapes.
$bundleDir = Join-Path $root "src-tauri/target/release/bundle/nsis"
$installer = Get-ChildItem -Path $bundleDir -Filter "*-setup.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if ($installer) {
    Write-Host ""
    Write-Host "Installer ready:" -ForegroundColor Green
    Write-Host "  $($installer.FullName)"
    Write-Host ("  {0:N1} MB" -f ($installer.Length / 1MB))
    Write-Host ""
    Write-Host "Unsigned, so the in-app updater won't offer it - install it directly."
} else {
    Write-Error "Build reported success but no installer was found in $bundleDir."
}

} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
