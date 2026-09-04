@echo off
REM VisionTap watchdog - launches the external stall-watcher SILENTLY (no console
REM window pops up, no focus steal). Polls the keeper's heartbeat and auto-resets
REM the loop if it stalls. Runs in the background via pythonw.
REM If a watchdog is already running, this simply does nothing (it's already up).
cd /d "%~dp0"
set PYTHONW=C:\Users\benit\AppData\Local\Python\bin\pythonw.exe
set VBSTEMP=%TEMP%\vt_watchdog_launch.vbs

REM Only start if no watchdog is already running (check via process list).
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe'\" | Where-Object { $_.CommandLine -like '*watchdog*' }) { exit 999 } else { exit 0 }" >nul 2>&1
IF %ERRORLEVEL%==999 (
    echo Watchdog is already running. Nothing to do.
    exit /b 0
)

(
echo Set s = CreateObject("WScript.Shell"^)
echo s.Run """%PYTHONW%"" ""%~dp0watchdog.py"" %*, 0, False
) > "%VBSTEMP%"
wscript "%VBSTEMP%"
del "%VBSTEMP%" >nul 2>&1
echo Watchdog started in the background.
exit /b 0
