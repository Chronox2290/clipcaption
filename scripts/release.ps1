# Cuts a new ClipCaption release: bumps the version everywhere it needs to
# match, commits, tags, and pushes - the tag push is what makes GitHub Actions
# (.github/workflows/release.yml) build the signed installer and updater
# manifest. Run via RELEASE.cmd, or directly:
#   powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version 0.2.0
# Leave -Version off (or just press Enter at the RELEASE.cmd prompt) to
# auto-bump the current patch version instead - e.g. 0.2.0 -> 0.2.1.

param(
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tauriConf = Join-Path $root "src-tauri\tauri.conf.json"
$pkgJson = Join-Path $root "package.json"

if ($Version -eq "") {
    $current = (Select-String -Path $tauriConf -Pattern '"version":\s*"([^"]+)"').Matches[0].Groups[1].Value
    if ($current -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
        Write-Error "Could not read a X.Y.Z version out of tauri.conf.json to auto-bump (found '$current'). Pass -Version explicitly instead."
    }
    $Version = "{0}.{1}.{2}" -f $Matches[1], $Matches[2], ([int]$Matches[3] + 1)
    Write-Host "No version given - auto-bumping patch: $current -> $Version"
} elseif ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Error "Version must look like 0.2.0 (three numbers, dots, no leading 'v') - got '$Version'."
}

Write-Host "Bumping version to $Version in tauri.conf.json, package.json and package-lock.json..."
(Get-Content $tauriConf -Raw) -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`"" |
    Set-Content $tauriConf -NoNewline

# `npm version` rather than the same regex trick used on tauri.conf.json above:
# it bumps package.json AND the two version fields at the top of
# package-lock.json. A regex over a lockfile would be reckless - every one of
# the hundreds of dependencies in there has a "version" key of its own.
# --no-git-tag-version keeps npm out of git; committing and tagging is this
# script's job, below. A native command's non-zero exit is NOT a terminating
# PowerShell error even under $ErrorActionPreference = "Stop", so check
# $LASTEXITCODE by hand.
Push-Location $root
npm version $Version --no-git-tag-version --allow-same-version | Out-Null
$npmExit = $LASTEXITCODE
Pop-Location
if ($npmExit -ne 0) {
    Write-Error "npm version failed (exit $npmExit) - package.json and package-lock.json were not bumped."
}

Push-Location $root
try {
    # `git add -A`, not just the two version files: a release should ship
    # whatever's actually sitting in the working tree. The narrower add used
    # to live here once caused a real, confusing bug - tauri.conf.json (one
    # of the two paths explicitly listed) started requiring a new sidecar
    # binary, but the script that fetches it wasn't one of the listed paths,
    # so it silently never got committed - CI built a config that demanded a
    # file nothing had ever been pushed to go get. `git status` below prints
    # exactly what's about to ship, so nothing goes out unreviewed.
    git add -A
    git status --short
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
