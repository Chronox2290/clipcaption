@echo off
cd /d "%~dp0"
set BIN=src-tauri\binaries\whisper-cli-x86_64-pc-windows-msvc.exe
set FF=src-tauri\binaries\ffmpeg-x86_64-pc-windows-msvc.exe
set MODEL=%APPDATA%\com.clipcaption.app\models\ggml-small.en.bin
set LOG=%~dp0whisper-diag.txt

echo === ClipCaption whisper diagnostic === > "%LOG%"
echo BIN=%BIN% >> "%LOG%"
echo MODEL=%MODEL% >> "%LOG%"
if exist "%MODEL%" (echo model file: EXISTS >> "%LOG%") else (echo model file: MISSING >> "%LOG%")
for %%A in ("%MODEL%") do echo model size: %%~zA bytes >> "%LOG%"
echo. >> "%LOG%"

echo --- test 1: whisper-cli --help --- >> "%LOG%"
"%BIN%" --help >> "%LOG%" 2>&1
echo [exit code: %ERRORLEVEL%] >> "%LOG%"
echo. >> "%LOG%"

echo --- test 2: generate 3s test wav --- >> "%LOG%"
"%FF%" -y -f lavfi -i sine=frequency=440:duration=3 -ar 16000 -ac 1 -c:a pcm_s16le "%TEMP%\cc-diag.wav" >> "%LOG%" 2>&1
echo [exit code: %ERRORLEVEL%] >> "%LOG%"
echo. >> "%LOG%"

echo --- test 3: plain transcribe (no extra flags) --- >> "%LOG%"
"%BIN%" -m "%MODEL%" -f "%TEMP%\cc-diag.wav" >> "%LOG%" 2>&1
echo [exit code: %ERRORLEVEL%] >> "%LOG%"
echo. >> "%LOG%"

echo --- test 4: transcribe with app flags (-ojf -of -pp -t 8) --- >> "%LOG%"
"%BIN%" -m "%MODEL%" -f "%TEMP%\cc-diag.wav" -ojf -of "%TEMP%\cc-diag" -pp -t 8 >> "%LOG%" 2>&1
echo [exit code: %ERRORLEVEL%] >> "%LOG%"
echo. >> "%LOG%"

echo === diagnostic complete === >> "%LOG%"
echo Done. Results are in whisper-diag.txt
pause
