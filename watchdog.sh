#!/bin/bash
set -u

services=(
  visiontap-xvfb
  visiontap-openbox
  visiontap-vnc
  visiontap-scanner
  visiontap-dashboard
  visiontap-chrome@danicajgb
  visiontap-chrome@nnnikkikim
  visiontap-chrome@darlenejoyce
  visiontap-chrome@deartheodosia
  visiontap-chrome@aaronburr
)

while true; do
  for service in "${services[@]}"; do
    if ! systemctl is-active --quiet "$service"; then
      systemctl restart "$service" || true
    fi
  done
  python3 - <<'PY'
import json, os, subprocess, time

accounts = ('danicajgb', 'nnnikkikim', 'darlenejoyce', 'deartheodosia', 'aaronburr')
state_dir = '/home/opc/.config/VisionTap Slots/state'
now = int(time.time() * 1000)
for account in accounts:
    state_file = os.path.join(state_dir, f'chrome_{account}_state.json')
    command_file = os.path.join(state_dir, f'chrome_{account}_command.json')
    try:
        with open(state_file, encoding='utf-8') as handle:
            state = json.load(handle)
    except Exception:
        continue
    if state.get('paused') or state.get('verificationHold') or not state.get('running', False):
        continue
    updated_at = int(state.get('updatedAt') or 0)
    progress_at = int(state.get('lastProgressAt') or updated_at or now)
    status = str(state.get('status') or '').lower()
    protected = any(word in status for word in ('verification', 'login required', 'cash-out', 'encash'))
    if protected:
        continue
    if updated_at and now - updated_at >= 30000:
        subprocess.run(['systemctl', 'restart', f'visiontap-chrome@{account}'], check=False)
        continue
    if progress_at and now - progress_at >= 25000:
        temp_file = command_file + '.watchdog'
        with open(temp_file, 'w', encoding='utf-8') as handle:
            json.dump({'action':'watchdog-reload', 'nonce':f'watchdog-{now}'}, handle)
        os.replace(temp_file, command_file)
PY
  sleep 10
done
