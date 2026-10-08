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
  sleep 30
done
