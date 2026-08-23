@echo off
cd /d "%~dp0"
echo Removing the wrong (stub) whisper binary...
del /q "src-tauri\binaries\whisper-cli-x86_64-pc-windows-msvc.exe" 2>nul
echo Re-fetching the real whisper-cli...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\get-sidecars.ps1"
echo.
echo Done. Now try Auto-caption in the app again (no restart needed).
pause
