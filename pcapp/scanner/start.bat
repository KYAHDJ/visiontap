@echo off
REM VisionTap Scanner Server - launches SILENTLY (no console window).
REM Double-click this anytime; it starts the server in the background.
REM If already running, does nothing.
cd /d "%~dp0"
set PYTHONW=C:\Users\benit\AppData\Local\Python\bin\pythonw.exe
set VBSTEMP=%TEMP%\vt_scanner_launch.vbs

REM Only start if not already listening on :5555
powershell -NoProfile -Command "try{$null=Invoke-WebRequest -Uri 'http://127.0.0.1:5555/health' -TimeoutSec 1 -UseBasicParsing; exit 999}catch{exit 0}" >nul 2>&1
IF %ERRORLEVEL%==999 (
    echo Scanner server is already running.
    exit /b 0
)

REM Create a hidden VBS that launches server.py with pythonw (no window), then run it.
(
echo Set s = CreateObject("WScript.Shell"^)
echo s.Run """%PYTHONW%"" ""%~dp0server.py""", 0, False
) > "%VBSTEMP%"
wscript "%VBSTEMP%"
del "%VBSTEMP%" >nul 2>&1
echo Scanner server started in the background.
exit /b 0
