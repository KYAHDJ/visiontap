#!/bin/bash
export DISPLAY=:1
export HOME=/home/opc
APP_DIR=/home/opc/VisionTap/slotbrowser
SCANNER_DIR=/home/opc/VisionTap/pcapp/scanner
LOG=/tmp/visiontap-watchdog.log
MAX_RESTARTS=8
RESTART_WINDOW=600

echo "[$(date)] Watchdog v2 started - auto-heal enabled" >> $LOG

# Track restarts to detect crash loop
declare -A restart_count
declare -A restart_time

should_restart() {
  local svc=$1
  local now=$(date +%s)
  local last=${restart_time[$svc]:-0}
  local cnt=${restart_count[$svc]:-0}
  if [ $((now - last)) -gt $RESTART_WINDOW ]; then
    cnt=0
  fi
  cnt=$((cnt+1))
  restart_count[$svc]=$cnt
  restart_time[$svc]=$now
  if [ $cnt -ge $MAX_RESTARTS ]; then
    echo "[$(date)] $svc crash loop ($cnt in $RESTART_WINDOW s) - attempting auto-fix (git pull + syntax check)" >> $LOG
    return 0
  fi
  return 0
}

while true; do
  # 1. Xvfb
  if ! pgrep -f 'Xvfb :1' > /dev/null 2>&1; then
    echo "[$(date)] Xvfb down - restarting" >> $LOG
    sudo systemctl restart visiontap-xvfb >> $LOG 2>&1
    sleep 5
    sudo systemctl restart visiontap-openbox >> $LOG 2>&1
    sudo systemctl restart visiontap-vnc >> $LOG 2>&1
  fi

  # 2. Openbox
  if ! pgrep -f 'openbox' > /dev/null 2>&1; then
    echo "[$(date)] Openbox down - restarting" >> $LOG
    sudo systemctl restart visiontap-openbox >> $LOG 2>&1
  fi

  # 3. VNC
  if ! pgrep -f 'x11vnc.*:1' > /dev/null 2>&1; then
    echo "[$(date)] VNC down - restarting" >> $LOG
    sudo systemctl restart visiontap-vnc >> $LOG 2>&1
  fi
  if ! sudo ss -tlnp 2>/dev/null | grep -q ':1919'; then
    echo "[$(date)] VNC port 1919 not listening - restarting" >> $LOG
    sudo systemctl restart visiontap-vnc >> $LOG 2>&1
  fi

  # 4. Scanner
  if ! curl -s --max-time 5 http://127.0.0.1:5566/health 2>/dev/null | grep -q 'online'; then
    echo "[$(date)] Scanner unhealthy - restarting" >> $LOG
    sudo systemctl restart visiontap-scanner >> $LOG 2>&1
    should_restart scanner
  fi
  # Syntax check for server.py
  if ! python3 -m py_compile $SCANNER_DIR/server.py 2>/dev/null; then
    echo "[$(date)] server.py syntax error - git pull auto-fix" >> $LOG
    cd /home/opc/VisionTap && git fetch origin >> $LOG 2>&1 && git reset --hard origin/main >> $LOG 2>&1
    sudo systemctl restart visiontap-scanner >> $LOG 2>&1
  fi

  # 5. Dashboard
  if ! curl -s --max-time 5 http://127.0.0.1:6260/api/stats 2>/dev/null | grep -q 'scannerUp'; then
    echo "[$(date)] Dashboard unhealthy - restarting" >> $LOG
    sudo systemctl restart visiontap-dashboard >> $LOG 2>&1
  fi
  if ! node --check $APP_DIR/dashboard.js 2>/dev/null; then
    echo "[$(date)] dashboard.js syntax error - git pull auto-fix" >> $LOG
    cd /home/opc/VisionTap && git fetch origin >> $LOG 2>&1 && git reset --hard origin/main >> $LOG 2>&1
    sudo systemctl restart visiontap-dashboard >> $LOG 2>&1
  fi

  # 6. Chrome pilots - each account heals independently.
  for account in kyaiko adaihbi temi axceling1001; do
    svc="visiontap-chrome@$account"
    if ! sudo systemctl is-active --quiet "$svc"; then
      echo "[$(date)] $account Chrome pilot down - restarting" >> $LOG
      sudo systemctl restart "$svc" >> $LOG 2>&1
      should_restart "chrome-$account"
    fi
  done
  if ! node --check $APP_DIR/chrome-pilot.js 2>/dev/null || ! node --check $APP_DIR/chrome-encashment.js 2>/dev/null; then
    echo "[$(date)] Chrome pilot syntax error - leaving services stopped for inspection" >> $LOG
    sudo systemctl stop 'visiontap-chrome@*' >> $LOG 2>&1
  fi

  # 7. Crash loop - only restart the failing shared service.
  for svc in scanner dashboard; do
    cnt=${restart_count[$svc]:-0}
    last=${restart_time[$svc]:-0}
    now=$(date +%s)
    if [ $cnt -ge $MAX_RESTARTS ] && [ $((now - last)) -lt $RESTART_WINDOW ]; then
      echo "[$(date)] $svc crash loop ($cnt) - restarting only $svc (not full system)" >> $LOG
      sudo systemctl restart visiontap-$svc >> $LOG 2>&1
      restart_count[$svc]=0
    fi
  done

  sleep 30
done
