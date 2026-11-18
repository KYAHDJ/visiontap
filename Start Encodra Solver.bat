@echo off
title VisionTap - Encodra Solver (runs by itself, no Claude needed)
cd /d "%~dp0"
set "PROFILE=%USERPROFILE%\.config\VisionTap-Chrome\encodra"
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
set RESTARTS=0

echo ===================================================
echo   VisionTap - Encodra Color Solver
echo   Keep the Encodra Chrome window open.
echo   Close this window to stop.
echo ===================================================

:chrome
curl -s -m 3 http://127.0.0.1:9222/json/version >nul 2>&1
if errorlevel 1 (
  echo [%time%] Opening Encodra Chrome with its local control port...
  start "" "%CHROME%" --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 "https://www.encodradigital.site/tasks/color"
  timeout /t 15 /nobreak >nul
)

:run
echo [%date% %time%] Solver running (no question limit)...
node slotbrowser\encodra-solver.js 1000000
echo [%date% %time%] Solver stopped. Last lines of state\encodra_answers.log:
powershell -NoProfile -Command "Get-Content 'state\encodra_answers.log' -Tail 3"

set /a RESTARTS+=1
if %RESTARTS% GEQ 5 (
  echo Stopped 5 times in a row. Probably a login or a verification check needs you. Open Encodra, fix it, then start this again.
  pause
  exit /b 1
)
echo Retrying in 60 seconds (attempt %RESTARTS% of 5)...
timeout /t 60 /nobreak >nul
goto chrome
