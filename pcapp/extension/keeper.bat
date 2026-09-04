@echo off
REM VisionTap keeper - launches the local background pusher SILENTLY (no console
REM window pops up, no focus steal). Double-click this anytime; it starts/keeps
REM the keeper running in the background via pythonw.
REM If a keeper is already running, this simply does nothing (it's already up).
cd /d "%~dp0"
set PYTHONW=C:\Users\benit\AppData\Local\Python\bin\pythonw.exe
set VBSTEMP=%TEMP%\vt_keeper_launch.vbs

REM Only start if not already listening on :8177
powershell -NoProfile -Command "try{$null=Invoke-WebRequest -Uri 'http://127.0.0.1:8177/health' -TimeoutSec 1 -UseBasicParsing; exit 999}catch{exit 0}" >nul 2>&1
IF %ERRORLEVEL%==999 (
    echo Keeper is already running. Nothing to do.
    exit /b 0
)

REM Create a hidden VBS that launches keeper.py with pythonw (no window), then run it.
(
echo Set s = CreateObject("WScript.Shell"^)
echo s.Run """%PYTHONW%"" ""%~dp0keeper.py""", 0, False
) > "%VBSTEMP%"
wscript "%VBSTEMP%"
del "%VBSTEMP%" >nul 2>&1
echo Keeper started in the background.
exit /b 0
