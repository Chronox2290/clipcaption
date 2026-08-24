@echo off
cd /d "%~dp0"

echo Building a standalone ClipCaption installer on this PC.
echo This is a full optimized release build, so it takes several minutes -
echo much less if you've built before, since it reuses what it can.
echo.
echo For everyday testing you probably want RUN.cmd instead - it launches
echo the app straight away without building an installer at all.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts/build-local.ps1"

if errorlevel 1 (
    echo.
    echo Build failed - scroll up for the error.
)

pause
