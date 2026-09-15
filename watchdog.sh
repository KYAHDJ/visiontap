#!/bin/bash
export DISPLAY=:1
APP_DIR=/home/opc/VisionTap/slotbrowser
LOG=/tmp/visiontap-watchdog.log

echo "[$(date)] Watchdog started" >> $LOG

while true; do
    if ! pgrep -f 'electron.*no-sandbox' > /dev/null 2>&1; then
        echo "[$(date)] Electron not running - restarting" >> $LOG
        cd $APP_DIR
        nohup npx electron . --no-sandbox --disable-gpu > /tmp/electron.log 2>&1 &
        sleep 5
        PID=$(pgrep -f 'electron.*no-sandbox' | head -1)
        echo "[$(date)] Restarted, PID: $PID" >> $LOG
    fi
    sleep 10
done
