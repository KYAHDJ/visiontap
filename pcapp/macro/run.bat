@echo off
REM Auto-elevates to Administrator (required for keyboard global hotkey + DPI)
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting Administrator privileges...
    powershell -Command "Start-Process cmd -ArgumentList '/c cd /d \"%~dp0\" && python main.py' -Verb RunAs"
    exit /b
)
cd /d "%~dp0"
python main.py
