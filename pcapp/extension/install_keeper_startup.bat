@echo off
REM ============================================================
REM  VisionTap Keeper - Auto-start installer
REM  Makes the keeper launch silently at Windows logon. Fully local:
REM  it only handles heartbeat/command for the failsafe watchdog and
REM  never sends anything off-machine.
REM
REM  Method 1 (no admin needed): copies keeper_startup.vbs to your
REM     Windows Startup folder. Runs with pythonw, hidden, at logon.
REM ============================================================
setlocal

set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set VBS=%~dp0keeper_startup.vbs

echo.
echo Installing keeper auto-start (Startup folder method, no admin needed)...
if not exist "%VBS%" (
    echo ERROR: keeper_startup.vbs not found next to this script.
    pause
    exit /b 1
)

copy /Y "%VBS%" "%STARTUP%\keeper_startup.vbs" >nul
if errorlevel 1 (
    echo Failed to copy to Startup folder.
    pause
    exit /b 1
)
echo Installed to: %STARTUP%\keeper_startup.vbs

echo.
echo Starting the keeper now (silent, no window)...
wscript "%VBS%"
timeout /t 3 /nobreak >nul

powershell -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8177/health' -TimeoutSec 3; Write-Host 'Keeper is RUNNING:' $r.status } catch { Write-Host 'Keeper did not respond to /health.' }"

echo.
echo Done. The keeper will now auto-start on every Windows login
echo and run the local failsafe watchdog with no manual steps.
echo.
echo To REMOVE auto-start later, delete:
echo   %STARTUP%\keeper_startup.vbs
echo and stop the pythonw keeper process.
pause
