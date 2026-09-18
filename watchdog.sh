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
  if ! sudo ss -tlnp 2>/dev/null | grep -q ':5901'; then
    echo "[$(date)] VNC port 5901 not listening - restarting" >> $LOG
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
  if ! curl -s --max-time 5 http://127.0.0.1:8080/api/stats 2>/dev/null | grep -q 'scannerUp'; then
    echo "[$(date)] Dashboard unhealthy - restarting" >> $LOG
    sudo systemctl restart visiontap-dashboard >> $LOG 2>&1
  fi
  if ! node --check $APP_DIR/dashboard.js 2>/dev/null; then
    echo "[$(date)] dashboard.js syntax error - git pull auto-fix" >> $LOG
    cd /home/opc/VisionTap && git fetch origin >> $LOG 2>&1 && git reset --hard origin/main >> $LOG 2>&1
    sudo systemctl restart visiontap-dashboard >> $LOG 2>&1
  fi

  # 6. Electron - main check
  if ! pgrep -f 'electron.*no-sandbox' > /dev/null 2>&1; then
    echo "[$(date)] Electron not running - restarting via systemd" >> $LOG
    sudo systemctl restart visiontap-electron >> $LOG 2>&1
    should_restart electron
  else
    # Check for SyntaxError crash loop in journal
    if sudo journalctl -u visiontap-electron -n 20 --no-pager 2>/dev/null | grep -q 'SyntaxError'; then
      echo "[$(date)] Electron SyntaxError detected - git pull auto-fix" >> $LOG
      cd /home/opc/VisionTap && git fetch origin >> $LOG 2>&1 && git reset --hard origin/main >> $LOG 2>&1
      if node --check $APP_DIR/main.js 2>/dev/null; then
        echo "[$(date)] main.js syntax OK after pull - restarting electron" >> $LOG
        sudo systemctl restart visiontap-electron >> $LOG 2>&1
      else
        echo "[$(date)] main.js still broken after pull!" >> $LOG
      fi
      # Clear journal to avoid loop
      sudo journalctl --rotate 2>/dev/null; sudo journalctl --vacuum-time=1s 2>/dev/null
    fi
    # Check for black screen: electron running but no vt-slot renderers
    RENDERERS=$(pgrep -f 'vt-slot=' 2>/dev/null | wc -l)
    ELECTRON_MAIN=$(pgrep -f 'electron.*slotbrowser' 2>/dev/null | wc -l)
    if [ "$ELECTRON_MAIN" -gt 0 ] && [ "$RENDERERS" -eq 0 ]; then
      # Give it 60s to spawn renderers after start
      UPTIME=$(sudo systemctl show visiontap-electron --property=ActiveEnterTimestampMonotonic 2>/dev/null | cut -d= -f2)
      # Simple: if no renderers for 2 consecutive checks, restart
      if [ -f /tmp/.no_renderer_count ]; then
        CNT=$(cat /tmp/.no_renderer_count)
        CNT=$((CNT+1))
        echo $CNT > /tmp/.no_renderer_count
        if [ $CNT -ge 8 ]; then
          echo "[$(date)] Black screen detected (0 renderers for 4m) - restarting electron + display stack" >> $LOG
          sudo systemctl restart visiontap-xvfb visiontap-openbox visiontap-vnc visiontap-electron >> $LOG 2>&1
          echo 0 > /tmp/.no_renderer_count
        fi
      else
        echo 1 > /tmp/.no_renderer_count
      fi
    else
      echo 0 > /tmp/.no_renderer_count
    fi
    # Check node syntax for main.js/slot.js
    if ! node --check $APP_DIR/main.js 2>/dev/null; then
      echo "[$(date)] main.js syntax error (pre-crash) - git pull" >> $LOG
      cd /home/opc/VisionTap && git fetch origin >> $LOG 2>&1 && git reset --hard origin/main >> $LOG 2>&1
      sudo systemctl restart visiontap-electron >> $LOG 2>&1
    fi
    if ! node --check $APP_DIR/slot.js 2>/dev/null; then
      echo "[$(date)] slot.js syntax error - git pull" >> $LOG
      cd /home/opc/VisionTap && git fetch origin >> $LOG 2>&1 && git reset --hard origin/main >> $LOG 2>&1
      sudo systemctl restart visiontap-electron >> $LOG 2>&1
    fi
  fi

  # 7. Crash loop - only restart the failing service, not whole system (avoid random full restarts)
  for svc in electron scanner dashboard; do
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
