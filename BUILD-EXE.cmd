@echo off
cd /d "%~dp0"

echo Building a standalone ClipCaption installer...
echo This does a full optimized release build (small, fast binary) so it
echo takes longer than the dev mode you're used to — several minutes,
echo maybe more on the first run. Grab a coffee.
echo.

call npm.cmd run tauri build

if errorlevel 1 (
    echo.
    echo Build failed — scroll up for the error. Common cause: the
    echo dev app (RUN.cmd) still running in another window. Close it
    echo and try again.
    pause
    exit /b
)

echo.
echo Done. Your installer is here:
echo   src-tauri\target\release\bundle\nsis\
echo.
echo Run that .exe on this or any other Windows PC to install ClipCaption
echo as a normal desktop app — Start Menu shortcut, uninstaller, no
echo terminal window required.
pause
