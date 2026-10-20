#!/bin/bash
# VisionTap Startup Script for Linux
export DISPLAY=:1
export HOME=/home/opc
export PATH=$HOME/.local/bin:$HOME/bin:/usr/local/bin:/usr/bin:$PATH

sudo systemctl daemon-reload
sudo systemctl restart visiontap-xvfb visiontap-openbox visiontap-vnc visiontap-scanner visiontap-dashboard
accounts=(adaihbi temi axceling1001 clarencebopis connormofu jinninijin yaminiko)
for account in "${accounts[@]}"; do
  sudo systemctl restart "visiontap-chrome@$account"
  sleep 2
done

echo "=== All services started ==="
echo "VNC: port 1919"
echo "Scanner: port 5566"
echo "Chrome pilots: ${accounts[*]}"
echo "Dashboard: port 6260"
