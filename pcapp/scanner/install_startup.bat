@echo off
REM ============================================================
REM  VisionTap Scanner Server - Auto-start installer
REM  Makes the scanner server launch silently at Windows logon
REM  so it's always ready when you press Alt+M.
REM
REM  Method 1 (no admin needed): copies scanner_startup.vbs to
REM     the Windows Startup folder. Runs hidden at logon.
REM ============================================================
setlocal

set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set VBS=%~dp0scanner_startup.vbs

echo.
echo Installing scanner server auto-start (Startup folder method)...
if not exist "%VBS%" (
    echo ERROR: scanner_startup.vbs not found next to this script.
    pause
    exit /b 1
)

copy /Y "%VBS%" "%STARTUP%\scanner_startup.vbs" >nul
if errorlevel 1 (
    echo Failed to copy to Startup folder.
    pause
    exit /b 1
)
echo Installed to: %STARTUP%\scanner_startup.vbs

echo.
echo Starting the scanner server now (silent, no window)...
wscript "%VBS%"
timeout /t 3 /nobreak >nul

powershell -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:5555/health' -TimeoutSec 3; Write-Host 'Scanner Server is RUNNING:' $r.status } catch { Write-Host 'Scanner Server did not respond to /health.' }"

echo.
echo Done. The scanner server will auto-start on every Windows login.
echo Alt+M will always work with no manual steps.
echo.
echo To REMOVE auto-start later, delete:
echo   %STARTUP%\scanner_startup.vbs
echo and stop the pythonw server process.
pause
