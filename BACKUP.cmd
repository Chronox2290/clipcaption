@echo off
cd /d "%~dp0"

if not exist ".git" (
    echo No git repo here yet — run GITHUB-SETUP.cmd first.
    pause
    exit /b
)

git add -A
set /p MSG="Commit message (Enter for a default one): "
if "%MSG%"=="" set MSG=Update
git commit -m "%MSG%"
git push

echo.
echo Pushed to GitHub.
pause
