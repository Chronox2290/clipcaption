@echo off
cd /d "%~dp0"

if not exist ".git" (
    echo No git repo here yet — run GITHUB-SETUP.cmd first.
    pause
    exit /b
)

git remote get-url origin >nul 2>&1
if errorlevel 1 (
    echo No GitHub remote is configured yet — run GITHUB-SETUP.cmd first.
    pause
    exit /b
)

git add -A
set /p MSG="Commit message (Enter for a default one): "
if "%MSG%"=="" set MSG=Update
git commit -m "%MSG%"

git rev-parse --abbrev-ref --symbolic-full-name @{u} >nul 2>&1
if errorlevel 1 (
    git push -u origin master
) else (
    git push
)

echo.
echo Pushed to GitHub.
pause
