REM AI: erstellt von GPT-6 Luna (bifrost/azure/gpt-6-luna) | 2026-11-05
@echo off
pushd "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
	 echo Node.js wurde nicht gefunden. Bitte Node.js LTS installieren.
	 popd
	 pause
	 exit /b 1
)
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:3000'"
node server.mjs
set "exit_code=%ERRORLEVEL%"
popd
exit /b %exit_code%
