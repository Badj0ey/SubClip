@echo off
setlocal
cd /d "%~dp0"

REM NOTE: keep this file ASCII-only (see 启动.bat for the reason).

set "ELECTRON_RUN_AS_NODE="

echo Starting dev mode. Close this window to quit the app.
call npm run dev

pause
