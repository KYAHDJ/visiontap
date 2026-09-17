# Oracle Cloud Server — VisionTap

## Instance
- **IP**: `140.245.49.233` (Oracle Linux 9, VM.Standard.E5.Flex 1 OCPU / 6 GB)
- **SSH**: `ssh -i C:\VisionTap\oracle_key opc@140.245.49.233`
- **User**: `opc`, home `/home/opc`
- **Repo**: `/home/opc/VisionTap` (git `KYAHDJ/visiontap`, branch `main`)
- **VNC**: `140.245.49.233:5901` (no password, display `:1`)
- **Firewall**: Security List + NSG + `firewall-cmd` must open `22, 5901, 8080`

```bash
sudo firewall-cmd --permanent --add-port=5901/tcp --add-port=8080/tcp --add-port=5566/tcp
sudo firewall-cmd --reload
```

## Systemd Services
All enabled for autostart (`sudo systemctl status visiontap-*`):

| Service | Description | WorkingDir | Exec | Port / Display |
|---------|-------------|------------|------|----------------|
| `visiontap-xvfb` | Virtual X display | — | `Xvfb :1 -screen 0 1280x800x24` | `:1` |
| `visiontap-openbox` | Window manager | — | `openbox` | `:1` |
| `visiontap-vnc` | VNC server | — | `x11vnc -display :1 -rfbport 5901` | `5901` |
| `visiontap-scanner` | Flask scanner | `pcapp/scanner` | `/usr/bin/python3 server.py` | `5566` |
| `visiontap-electron` | Electron slots | `slotbrowser` | `npx electron . --no-sandbox` | `:1`, uses `DISPLAY=:1` |
| `visiontap-dashboard` | Control dashboard | `slotbrowser` | `node dashboard.js` | `8080` |
| `visiontap-watchdog` | Optional watchdog | — | `watchdog.sh` | — |

Service files: `visiontap-*.service` in repo root, installed to `/etc/systemd/system/`.

```bash
sudo systemctl restart visiontap-scanner
sudo systemctl restart visiontap-electron
sudo systemctl restart visiontap-dashboard
sudo systemctl status visiontap-electron --no-pager | head -n 20
sudo journalctl -u visiontap-scanner -f
sudo journalctl -u visiontap-electron -f
```

## Display & Electron Flags
Electron runs low-RAM mode (`app.disableHardwareAcceleration()`, `--disable-gpu`, `--max-old-space-size=64`, `renderer-process-limit=2`, `disable-dev-shm-usage` etc.) See `slotbrowser/main.js:42-71`. State dir: `~/.config/VisionTap Slots/state/` (`slots.json`, `credentials.json`, `settings.json`, `slot_commands.json`, `loop_command.json`).

## Scanner Deps (Oracle)
Installed via `setup_server.sh`:
`python3, pip, tesseract, gcc-c++, cmake, libX11, gtk3, nss, Xvfb, x11vnc, fluxbox, Node 20`, pip `flask, opencv-python-headless, pytesseract, Pillow, numpy`. No `easyocr` (2GB, fails on 1 OCPU) — replaced with `pytesseract`.

Fonts: `google-noto-*, liberation-*, dejavu-*` (252 fonts) required for ECNL layout.

## Deploy (Local → Oracle)
```bash
# Local
git add -A && git commit -m "msg" && git push

# Oracle
ssh -i C:\VisionTap\oracle_key opc@140.245.49.233
cd ~/VisionTap && git pull
sudo systemctl restart visiontap-scanner visiontap-electron visiontap-dashboard
```

VNC check: `vncviewer 140.245.49.233:5901`, dashboard `http://140.245.49.233:8080`, scanner `curl -s http://127.0.0.1:5566/health` → `{"status":"online"}`.

## Troubleshooting
- `scp opc@140.245.49.233:~/VisionTap/pcapp/scanner/debug_captured_task.png .`
- `curl -s http://127.0.0.1:5566/stats | jq`
- Electron crash: `ps aux | grep electron`, `DISPLAY=:1` must be set.
- Credentials: `~/.config/VisionTap Slots/state/credentials.json` (watched every 2s by `main.js`).
