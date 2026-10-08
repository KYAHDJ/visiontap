#!/bin/bash
set -euo pipefail

APP_DIR=/home/opc/VisionTap
OPC_HOME=/home/opc

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo."
  exit 1
fi
if ! id opc >/dev/null 2>&1; then
  echo "The required opc user does not exist."
  exit 1
fi
if [ ! -f "$APP_DIR/slotbrowser/dashboard.js" ]; then
  echo "Expected repository at $APP_DIR."
  exit 1
fi

apt-get update
apt-get install -y python3-venv python3-pip tesseract-ocr xvfb openbox x11vnc novnc websockify nodejs npm

python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"
npm --prefix "$APP_DIR/slotbrowser" ci --omit=dev

install -d -m 0700 -o opc -g opc "$OPC_HOME/.config/VisionTap-Chrome" "$OPC_HOME/.config/VisionTap-Dashboard"
install -d -m 0755 -o opc -g opc "$OPC_HOME/.config/VisionTap Slots/state"
install -m 0600 -o opc -g opc "$APP_DIR"/config/chrome-*.env "$OPC_HOME/.config/VisionTap-Chrome/"
install -m 0644 -o opc -g opc "$APP_DIR/config/slots.json" "$OPC_HOME/.config/VisionTap Slots/state/slots.json"

install -m 0644 "$APP_DIR"/visiontap-*.service /etc/systemd/system/
install -d -m 0755 /etc/systemd/system/visiontap-dashboard.service.d
install -m 0644 "$APP_DIR/visiontap-dashboard-admin.conf" /etc/systemd/system/visiontap-dashboard.service.d/admin.conf
install -m 0440 "$APP_DIR/visiontap-dashboard-sudoers" /etc/sudoers.d/visiontap-dashboard
install -m 0755 "$APP_DIR/watchdog.sh" "$APP_DIR/visiontap-accounts-viewer"
chown -R opc:opc "$APP_DIR"

systemctl daemon-reload
systemctl enable --now visiontap-xvfb visiontap-openbox visiontap-vnc visiontap-novnc visiontap-scanner visiontap-dashboard
for account in danicajgb nnnikkikim darlenejoyce deartheodosia aaronburr; do
  systemctl enable --now "visiontap-chrome@$account"
done
systemctl enable --now visiontap-watchdog

echo "VisionTap Contabo services installed. Add private account sessions, payout settings, and admin password separately."
