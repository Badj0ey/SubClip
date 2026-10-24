@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"
set "ELECTRON=%APPDIR%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo [ERROR] Missing Electron. Run npm ci in this folder first.
  pause
  exit /b 1
)
if not exist "%APPDIR%\out\main\index.js" (
  call npm run build
  if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
  )
)
start "" "%ELECTRON%" "%APPDIR%"
exit /b 0
