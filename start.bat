@echo off
setlocal
title VibePlay AI launcher
cd /d "%~dp0"

echo ============================================
echo   VibePlay AI - browser game generator
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto no_node

for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
echo [OK] Node.js %NODE_VERSION%

if not exist ".env" (
  if not exist ".env.example" goto no_env_example
  echo.
  echo [FIRST RUN] Creating .env from .env.example...
  copy /y ".env.example" ".env" >nul
  echo Add an API key, save the file, then close Notepad.
  echo GigaChat key:   https://developers.sber.ru/studio/workspaces/
  echo Gemini key:     https://aistudio.google.com/apikey
  echo OpenRouter key: https://openrouter.ai/keys
  notepad ".env"
)

echo.
echo [START] Starting local server...
start "VibePlay AI server" /min cmd /c "node server.js"

echo Waiting for the server...
ping 127.0.0.1 -n 4 >nul
if not defined VIBEPLAY_NO_BROWSER start "" "http://localhost:3000"

echo.
echo [DONE] Opened http://localhost:3000
echo The server is running in the minimized window named VibePlay AI server.
echo Close that window to stop the server.
echo.
if defined VIBEPLAY_NO_PAUSE exit /b 0
pause
exit /b 0

:no_node
echo [ERROR] Node.js was not found.
echo Install Node.js 22 or newer from https://nodejs.org
echo Then run start.bat again.
echo.
pause
exit /b 1

:no_env_example
echo [ERROR] .env.example was not found next to start.bat.
echo Extract the complete ZIP archive and run start.bat again.
echo.
pause
exit /b 1
