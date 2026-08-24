@echo off
cd /d "%~dp0"

echo Fetching sidecar tools ClipCaption needs (ffmpeg, whisper-cli, and the
echo speaker-diarization binary + models) into src-tauri\binaries. Only
echo missing ones are downloaded - already-installed ones are skipped.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\get-sidecars.ps1"

if errorlevel 1 (
    echo.
    echo Something went wrong - scroll up for the actual error message.
) else (
    echo.
    echo Done.
)

echo.
echo (window kept open so you can read any messages)
pause
