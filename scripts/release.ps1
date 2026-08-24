# Cuts a new ClipCaption release: bumps the version everywhere it needs to
# match, commits, tags, and pushes - the tag push is what makes GitHub Actions
# (.github/workflows/release.yml) build the signed installer and updater
# manifest. Run via RELEASE.cmd, or directly:
#   powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version 0.2.0

param(
    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Error "Version must look like 0.2.0 (three numbers, dots, no leading 'v') - got '$Version'."
}

$tauriConf = Join-Path $root "src-tauri\tauri.conf.json"
$pkgJson = Join-Path $root "package.json"

Write-Host "Bumping version to $Version in tauri.conf.json and package.json..."
(Get-Content $tauriConf -Raw) -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`"" |
    Set-Content $tauriConf -NoNewline
(Get-Content $pkgJson -Raw) -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`"" |
    Set-Content $pkgJson -NoNewline

Push-Location $root
try {
    git add src-tauri/tauri.conf.json package.json
    git commit -m "Release v$Version"
    git tag "v$Version"
    git push
    git push origin "v$Version"
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Pushed v$Version. GitHub Actions is now building the installer:"
Write-Host "  https://github.com/Chronox2290/clipcaption/actions"
Write-Host ""
Write-Host "When it finishes (several minutes - it's a full Windows build), open:"
Write-Host "  https://github.com/Chronox2290/clipcaption/releases"
Write-Host "and click 'Publish release' on the new draft. Nobody's app will offer"
Write-Host "this update until you do that - it's the deliberate go-live step."
