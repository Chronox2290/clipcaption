@echo off
cd /d "%~dp0"

git rev-parse --verify -q HEAD >nul 2>&1
if errorlevel 1 (
    echo Importing full project history from clipcaption.git.bundle...
    if not exist ".git" git init -q
    git fetch clipcaption.git.bundle master
    if errorlevel 1 (
        echo.
        echo Something went wrong importing the bundle. Make sure
        echo clipcaption.git.bundle is in this same folder and try again.
        pause
        exit /b
    )
    git reset --hard FETCH_HEAD -q
    echo History imported.
    echo.
) else (
    echo A git repo is already set up here — skipping the history import.
    echo.
)

git remote get-url origin >nul 2>&1
if not errorlevel 1 (
    echo A GitHub remote is already configured:
    for /f "delims=" %%u in ('git remote get-url origin') do echo   %%u
    echo.
    echo Run BACKUP.cmd whenever you want to push your latest changes.
    pause
    exit /b
)

echo This repo has history but isn't connected to GitHub yet. You need an
echo empty repo there to push to:
echo   1. Go to https://github.com/new in your browser (make sure you're logged in)
echo   2. Name it e.g. "clipcaption"
echo   3. Leave "Add a README" UNCHECKED (we already have one)
echo   4. Click "Create repository"
echo   5. On the next page, copy the URL under "...or push an existing repository"
echo      (it looks like https://github.com/YOURNAME/clipcaption.git)
echo.
echo If you already made the repo, just paste that URL below.
echo.
set /p REPO_URL="Repo URL: "

if "%REPO_URL%"=="" (
    echo No URL entered — skipping the push. You can run this script again later,
    echo or just run: git remote add origin YOUR_URL  ^&^&  git push -u origin master
    pause
    exit /b
)

git remote add origin "%REPO_URL%"
git push -u origin master

if errorlevel 1 (
    echo.
    echo The push failed — scroll up for the actual git error. Common causes:
    echo   - wrong URL pasted above ^(run "git remote remove origin" then retry^)
    echo   - not signed in to GitHub yet ^(a browser window should have popped up^)
    pause
    exit /b
)

echo.
echo Done. Your first push may open a browser window asking you to sign in to
echo GitHub — that's Windows' own credential manager, not this script.
echo.
echo From now on, after I make changes, just run BACKUP.cmd to push them.
pause
