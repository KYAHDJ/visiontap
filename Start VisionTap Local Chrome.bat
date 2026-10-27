@echo off
title VisionTap Local Chrome
cd /d "%~dp0slotbrowser"
node local-hide-test.js
if errorlevel 1 pause
