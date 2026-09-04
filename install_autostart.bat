@echo off
REM ============================================================
REM  VisionTap - Combined Auto-start Installer
REM  Installs ALL background processes to launch silently at every
REM  Windows logon:
REM    1. Scanner Server  (pcapp\scanner\server.py)  - port 5555
REM    2. Keeper          (pcapp\extension\keeper.py) - port 8177
REM    3. Watchdog        (pcapp\extension\watchdog.py) - 2-min final failsafe
REM    4. Data Feeder     (pcapp\extension\data_feeder.py) - Pages data feed
REM  No admin needed (Startup folder method). All run hidden via pythonw.
REM ============================================================
setlocal

set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup

echo ============================================
echo  VisionTap - Installing auto-start processes
echo ============================================
echo.

copy /Y "%~dp0scanner\scanner_startup.vbs" "%STARTUP%\scanner_startup.vbs" >nul
if errorlevel 1 ( echo FAILED: scanner startup ) else ( echo OK: scanner startup )

copy /Y "%~dp0extension\keeper_startup.vbs" "%STARTUP%\keeper_startup.vbs" >nul
if errorlevel 1 ( echo FAILED: keeper startup ) else ( echo OK: keeper startup )

copy /Y "%~dp0extension\watchdog_startup.vbs" "%STARTUP%\watchdog_startup.vbs" >nul
if errorlevel 1 ( echo FAILED: watchdog startup ) else ( echo OK: watchdog startup )

copy /Y "%~dp0extension\data_feeder_startup.vbs" "%STARTUP%\data_feeder_startup.vbs" >nul
if errorlevel 1 ( echo FAILED: data feeder startup ) else ( echo OK: data feeder startup )

echo.
echo Starting all four now (silent, no windows)...
wscript "%STARTUP%\scanner_startup.vbs"
wscript "%STARTUP%\keeper_startup.vbs"
wscript "%STARTUP%\watchdog_startup.vbs"
wscript "%STARTUP%\data_feeder_startup.vbs"
timeout /t 4 >nul

echo.
echo Verifying...
powershell -NoProfile -Command "try { $r=Invoke-RestMethod 'http://127.0.0.1:5555/health' -TimeoutSec 3; Write-Host ('Scanner: ' + $r.status) } catch { Write-Host 'Scanner: NOT RUNNING' }"
powershell -NoProfile -Command "try { $r=Invoke-RestMethod 'http://127.0.0.1:8177/health' -TimeoutSec 3; Write-Host ('Keeper: ' + $r.status) } catch { Write-Host 'Keeper: NOT RUNNING' }"
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe'\" | Where-Object { $_.CommandLine -like '*watchdog*' }) { Write-Host 'Watchdog: RUNNING' } else { Write-Host 'Watchdog: NOT RUNNING' }"
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe'\" | Where-Object { $_.CommandLine -like '*data_feeder*' }) { Write-Host 'Data Feeder: RUNNING' } else { Write-Host 'Data Feeder: NOT RUNNING' }"

echo.
echo Done. All processes auto-start on every Windows login.
echo To REMOVE auto-start, delete the four VBS files in:
echo   %STARTUP%
echo.
pause
