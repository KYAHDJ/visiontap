#!/bin/bash
# VisionTap Startup Script for Linux
export DISPLAY=:1
export HOME=/home/opc
export PATH=$HOME/.local/bin:$HOME/bin:/usr/local/bin:/usr/bin:$PATH

# Kill old processes
pkill -f Xvfb 2>/dev/null || true
pkill -f x11vnc 2>/dev/null || true
pkill -f openbox 2>/dev/null || true
pkill -f "python3.*server.py" 2>/dev/null || true
pkill -f electron 2>/dev/null || true
sleep 1

# Start Xvfb
Xvfb :1 -screen 0 1280x1024x24 -ac &
sleep 1

# Start openbox
openbox &
sleep 1

# Start x11vnc (no password for now)
x11vnc -display :1 -forever -nopw -rfbport 5901 -shared -bg 2>&1 | tail -3

# Start scanner
cd /home/opc/VisionTap/pcapp/scanner
nohup python3 server.py > /tmp/scanner.log 2>&1 &
sleep 2
echo "Scanner started, checking..."
curl -s http://127.0.0.1:5566/ 2>/dev/null || echo "Scanner may need a moment..."

# Start Electron
cd /home/opc/VisionTap/slotbrowser
nohup npx electron . --no-sandbox > /tmp/electron.log 2>&1 &
sleep 3

# Start Dashboard
cd /home/opc/VisionTap/slotbrowser
nohup node dashboard.js > /tmp/dashboard.log 2>&1 &
sleep 2

echo "=== All services started ==="
echo "VNC: port 5901"
echo "Scanner: port 5566"
echo "Electron: running"
echo "Dashboard: port 8080"
