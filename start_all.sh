#!/bin/bash
# VisionTap Startup Script for Linux
export DISPLAY=:1
export HOME=/home/opc
export PATH=$HOME/.local/bin:$HOME/bin:/usr/local/bin:/usr/bin:$PATH

sudo systemctl daemon-reload
sudo systemctl restart visiontap-xvfb visiontap-openbox visiontap-vnc visiontap-scanner visiontap-dashboard
sudo systemctl restart visiontap-chrome@kyaiko visiontap-chrome@adaihbi visiontap-chrome@temi visiontap-chrome@axceling1001 visiontap-chrome@clarencebopis visiontap-chrome@connormofu

echo "=== All services started ==="
echo "VNC: port 1919"
echo "Scanner: port 5566"
echo "Chrome pilots: kyaiko adaihbi temi axceling1001 clarencebopis connormofu"
echo "Dashboard: port 6260"
