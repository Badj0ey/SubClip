@echo off
setlocal
cd /d "%~dp0"

REM NOTE: keep this file ASCII-only. cmd.exe reads .bat with the system code page
REM (GBK on zh-CN), so UTF-8 Chinese here gets mangled into stray commands.

REM Some IDE / host terminals inject ELECTRON_RUN_AS_NODE, which makes Electron
REM run as plain Node and fail with "Cannot read properties of undefined".
set "ELECTRON_RUN_AS_NODE="

set "APPDIR=%~dp0"
REM %~dp0 always ends with a backslash. A trailing "\" right before the closing
REM quote escapes that quote, so strip it before passing to Electron.
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"

set "ELECTRON=%APPDIR%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo [ERROR] Electron is missing. Run "npm install" in this folder first.
  pause
  exit /b 1
)

if not exist "%APPDIR%\out\main\index.js" (
  echo First run: building, please wait...
  call npm run build
  if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
  )
)

start "" "%ELECTRON%" "%APPDIR%"
exit /b 0
