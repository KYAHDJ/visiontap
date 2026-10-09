#!/bin/bash
set -u

export DISPLAY=:1
export HOME=/home/opc

APP_DIR=/home/opc/VisionTap/slotbrowser
SCANNER_DIR=/home/opc/VisionTap/pcapp/scanner
STATE_DIR='/home/opc/.config/VisionTap Slots/state'
LOG=/tmp/visiontap-watchdog.log
MAX_RESTARTS=8
RESTART_WINDOW=600
WORKER_HEARTBEAT_MS=90000

accounts=(danicajgb nnnikkikim darlenejoyce deartheodosia aaronburr)
declare -A restart_count
declare -A restart_time

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*" >> "$LOG"
}

trim_log() {
  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 2097152 ]; then
    tail -n 2000 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
  fi
}

restart_allowed() {
  local name=$1 now last count
  now=$(date +%s)
  last=${restart_time[$name]:-0}
  count=${restart_count[$name]:-0}
  if [ $((now - last)) -gt "$RESTART_WINDOW" ]; then count=0; fi
  count=$((count + 1))
  restart_count[$name]=$count
  restart_time[$name]=$now
  if [ "$count" -gt "$MAX_RESTARTS" ]; then
    log "$name restart suppressed: crash-loop protection ($count attempts in ${RESTART_WINDOW}s)"
    return 1
  fi
  return 0
}

restart_service() {
  local service=$1 reason=$2
  if restart_allowed "$service"; then
    log "$service unhealthy: $reason; restarting"
    systemctl restart "$service" >> "$LOG" 2>&1 || log "$service restart failed"
  fi
}

service_active() {
  systemctl is-active --quiet "$1"
}

worker_protected_or_fresh() {
  local account=$1
  python3 - "$STATE_DIR/chrome_${account}_state.json" "$WORKER_HEARTBEAT_MS" <<'PY'
import json, sys, time
path, threshold = sys.argv[1], int(sys.argv[2])
try:
    with open(path, encoding='utf-8') as handle:
        state = json.load(handle)
except Exception:
    raise SystemExit(1)
status = str(state.get('status') or '').lower()
protected = (
    state.get('paused') or state.get('verificationHold') or
    any(word in status for word in ('verification', 'login required', 'cash-out', 'encash'))
)
updated = int(state.get('updatedAt') or 0)
fresh = updated > 0 and int(time.time() * 1000) - updated < threshold
raise SystemExit(0 if protected or fresh else 1)
PY
}

log 'Contabo full-system watchdog started'

while true; do
  trim_log

  if ! service_active visiontap-xvfb || ! pgrep -f '^/usr/bin/Xvfb :1 ' >/dev/null 2>&1; then
    restart_service visiontap-xvfb 'virtual display process missing'
    sleep 2
    restart_service visiontap-openbox 'display was rebuilt'
    restart_service visiontap-vnc 'display was rebuilt'
    for account in "${accounts[@]}"; do
      restart_service "visiontap-chrome@$account" 'display was rebuilt'
    done
  fi

  if ! service_active visiontap-openbox || ! pgrep -x openbox >/dev/null 2>&1; then
    restart_service visiontap-openbox 'window manager process missing'
  fi

  if ! service_active visiontap-vnc || ! pgrep -f '^/usr/bin/x11vnc .*:1' >/dev/null 2>&1; then
    restart_service visiontap-vnc 'local automation viewer missing'
  fi

  if ! "$HOME/VisionTap/.venv/bin/python" -m py_compile "$SCANNER_DIR/server.py" >/dev/null 2>&1; then
    log 'scanner syntax check failed; automatic restart skipped'
  elif ! curl -fsS --max-time 5 http://127.0.0.1:5566/health 2>/dev/null | grep -qi online; then
    restart_service visiontap-scanner 'health endpoint failed'
  elif ! service_active visiontap-scanner; then
    restart_service visiontap-scanner 'service stopped'
  fi

  if ! /usr/bin/node --check "$APP_DIR/dashboard.js" >/dev/null 2>&1; then
    log 'dashboard syntax check failed; automatic restart skipped'
  elif ! curl -fsS --max-time 5 http://127.0.0.1:6260/api/stats 2>/dev/null | grep -q '"scannerUp"'; then
    restart_service visiontap-dashboard 'API health check failed'
  elif ! service_active visiontap-dashboard; then
    restart_service visiontap-dashboard 'service stopped'
  fi

  pilot_syntax_ok=1
  /usr/bin/node --check "$APP_DIR/chrome-pilot.js" >/dev/null 2>&1 || pilot_syntax_ok=0
  /usr/bin/node --check "$APP_DIR/chrome-encashment.js" >/dev/null 2>&1 || pilot_syntax_ok=0
  /usr/bin/node --check "$APP_DIR/inject/slot_inject.js" >/dev/null 2>&1 || pilot_syntax_ok=0
  if [ "$pilot_syntax_ok" -eq 0 ]; then
    log 'Chrome worker syntax check failed; automatic worker restarts skipped'
  else
    for account in "${accounts[@]}"; do
      service="visiontap-chrome@$account"
      if ! service_active "$service"; then
        restart_service "$service" 'service stopped'
      elif ! worker_protected_or_fresh "$account"; then
        restart_service "$service" "state heartbeat stale for ${WORKER_HEARTBEAT_MS}ms"
      fi
    done
  fi

  sleep 10
done
