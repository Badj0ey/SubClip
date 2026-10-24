@echo off
setlocal
cd /d "%~dp0"

REM ---------------------------------------------------------------------------
REM SubClip launcher (ASCII filename on purpose).
REM
REM Why a second launcher exists next to the Chinese-named one:
REM desktop shortcuts (.lnk) store their target as a plain string. An ASCII
REM target survives any code page / encoding handling on the way, while a path
REM containing Chinese characters can break when the shortcut is copied,
REM synced, or restored on a machine with a different system locale.
REM Both files run exactly the same steps; keep them in sync.
REM
REM NOTE: keep this file ASCII-only anyway. cmd.exe reads .bat using the system
REM code page (GBK on zh-CN), so UTF-8 Chinese in here becomes stray commands.
REM ---------------------------------------------------------------------------

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

REM Launch detached so this console can close immediately. A lingering cmd
REM window behind the app looks broken and is easy to close by accident,
REM which would kill nothing but is confusing.
start "" "%ELECTRON%" "%APPDIR%"
exit /b 0
