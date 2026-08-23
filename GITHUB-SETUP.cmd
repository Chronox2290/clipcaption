@echo off
cd /d "%~dp0"

if exist ".git" (
    echo A git repo is already set up here.
    echo If you just want to push again, run BACKUP.cmd instead.
    pause
    exit /b
)

echo Importing full project history from clipcaption.git.bundle...
git init -q
git fetch clipcaption.git.bundle master:master
if errorlevel 1 (
    echo.
    echo Something went wrong importing the bundle. Make sure
    echo clipcaption.git.bundle is in this same folder and try again.
    pause
    exit /b
)
git checkout master -q
echo History imported.
echo.

echo Before this can push anywhere, you need an empty repo on GitHub:
echo   1. Go to https://github.com/new in your browser (make sure you're logged in)
echo   2. Name it e.g. "clipcaption"
echo   3. Leave "Add a README" UNCHECKED (we already have one)
echo   4. Click "Create repository"
echo   5. On the next page, copy the URL under "...or push an existing repository"
echo      (it looks like https://github.com/YOURNAME/clipcaption.git)
echo.
set /p REPO_URL="Paste that URL here and press Enter: "

if "%REPO_URL%"=="" (
    echo No URL entered — skipping the push. You can run this script again later,
    echo or just run: git remote add origin YOUR_URL  ^&^&  git push -u origin master
    pause
    exit /b
)

git remote add origin "%REPO_URL%"
git push -u origin master

echo.
echo Done. Your first push may open a browser window asking you to sign in to
echo GitHub — that's Windows' own credential manager, not this script.
echo.
echo From now on, after I make changes, just run BACKUP.cmd to push them.
pause
