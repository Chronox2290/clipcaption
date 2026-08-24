@echo off
cd /d "%~dp0"

git rev-parse --verify -q HEAD >nul 2>&1
if errorlevel 1 (
    echo No git repo here yet - run GITHUB-SETUP.cmd first, and make sure
    echo it's pushed to GitHub before cutting a release.
    pause
    exit /b
)

echo This publishes a new version: bumps the version number, commits, tags it,
echo pushes to GitHub, and that kicks off the build that produces the signed
echo installer + the update GitHub Releases hands out to existing installs.
echo.
echo Current version is whatever's in src-tauri\tauri.conf.json right now.
echo.
set /p NEWVER="New version (e.g. 0.2.0), or just press Enter to auto-bump: "

if "%NEWVER%"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release.ps1"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release.ps1" -Version "%NEWVER%"
)

if errorlevel 1 (
    echo.
    echo Something went wrong - scroll up for the error. If the commit/tag
    echo already happened but the push failed, you can retry with:
    echo   git push ^&^& git push origin vX.Y.Z
)

pause
