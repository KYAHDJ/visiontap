# VisionTap

Multi-slot ECNL `solving-colors` automation: Electron split-screen slots + Flask HSV color scanner + web dashboard on Oracle Cloud (140.245.49.233).

## Repo Layout
```
VisionTap/
├── ORACLE.md          # Oracle Cloud instance, systemd, deploy
├── DASHBOARD.md       # Dashboard 8080 API + UI
├── SERVER.md          # Scanner 5566 + Electron slots + inject
├── CLOUD_SERVER_SETUP.md # Legacy detailed fixes (kept)
├── setup_server.sh    # dnf + Node20 + VisionTap clone + pip
├── watchdog.sh, *.service # systemd units (xvfb/openbox/vnc/scanner/electron/dashboard)
├── pcapp/scanner/server.py # Flask 5566, HSV 3×12 grid, pytesseract badge OCR
├── slotbrowser/
│   ├── main.js        # BrowserWindow + WebContentsView slots, IPC, layout
│   ├── slot.js        # Per-slot loop (5s input wait, instant checking reload)
│   ├── dashboard.js   # Node 8080 control UI, /api/stats, /cmd, /save-creds
│   ├── inject/slot_inject.js # In-page: grabTaskImage, fill, HUD, nukeAds
│   ├── preload/       # slot/shell bridges
│   ├── shell/         # Toolbar HTML/CSS
│   └── package.json   # electron 44, electron-builder
├── VisionTapColor/    # Chrome extension legacy (task_script.js)
└── math_test/, sampletask/ # Test images
```

## Quick Start
- **Windows**: `slotbrowser: npm install && npm start` (needs Python scanner: `pcapp/scanner/start.bat`).
- **Oracle**: `ssh -i oracle_key opc@140.245.49.233 "cd ~/VisionTap && git pull && sudo systemctl restart visiontap-scanner visiontap-electron visiontap-dashboard"`; VNC `140.245.49.233:5901`, Dashboard `http://140.245.49.233:8080`.
- **Scanner**: `curl -s http://127.0.0.1:5566/health` → `online`; `POST /detect` with `data:image/png;base64`.

## Docs
- `ORACLE.md` — VM, services, firewall, fonts, troubleshooting.
- `DASHBOARD.md` — 8080 routes, merging, polling, UI.
- `SERVER.md` — 5566 endpoints, HSV ranges, grid math, slot loop, inject API.

For AI: read the three MDs above for full server-side understanding. All server code is `pcapp/scanner/server.py` + `slotbrowser/*.js` + `slotbrowser/dashboard.js`. No external DB, JSON files only (`scanner_stats.json`, `earnings_history.json`, `~/.config/VisionTap Slots/state/*.json`).
