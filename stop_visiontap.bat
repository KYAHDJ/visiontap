@echo off
taskkill /f /im python.exe >nul 2>&1
taskkill /f /im electron.exe >nul 2>&1
echo VisionTap stopped.
