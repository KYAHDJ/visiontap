# VisionTap Cloud Server Setup & Fixes

## Server Info
- **IP**: 140.245.49.233
- **OS**: Oracle Linux 9
- **Shape**: VM.Standard.E5.Flex (1 OCPU, 6 GB RAM)
- **SSH**: `ssh -i C:\VisionTap\oracle_key opc@140.245.49.233`
- **VNC**: 140.245.49.233:5901 (no password)
- **Dashboard**: http://140.245.49.233:8080
- **SSH Key**: `C:\VisionTap\oracle_key` (generated locally, public key uploaded to OCI)

## Ports (must be open in both Security List AND NSG)
- 22 (SSH)
- 5901 (VNC)
- 8080 (Dashboard)
- Also add firewall: `sudo firewall-cmd --permanent --add-port=5901/tcp --add-port=8080/tcp && sudo firewall-cmd --reload`

## Systemd Services (all enabled for autostart)
- `visiontap-xvfb` — Virtual display :1
- `visiontap-openbox` — Window manager
- `visiontap-vnc` — VNC server on 5901
- `visiontap-scanner` — Python Flask scanner on 5566
- `visiontap-electron` — Electron app
- `visiontap-dashboard` — Web dashboard on 8080

Manage with: `sudo systemctl status/restart/stop visiontap-{xvfb,openbox,vnc,scanner,electron,dashboard}`

## Critical Fixes Applied

### 1. OCR: easyocr replaced with pytesseract (Sep 13, 2026)
**Problem**: easyocr is ~2GB and fails to install on 1 OCPU. The `reader` variable was `None`, so badge OCR silently failed every time, returning `None`, causing "Unverified target number" 400 error.

**Fix**: Replaced all `easyocr` usage with `pytesseract` (already installed via `dnf install tesseract`). Changed imports and all `reader.readtext()` calls to `pytesseract.image_to_string()`.

**File**: `pcapp/scanner/server.py` — lines 10-14, 64-75, 199-204, 338-340

### 2. OCR Preprocessing: mask+invert for white-on-gray badge text (Sep 13, 2026)
**Problem**: The ECNL badge has **white text on gray background**. Default grayscale+threshold produced invisible text. Tesseract returned empty string.

**Fix**: New preprocessing pipeline:
1. Threshold at 180 to isolate bright white text pixels → binary mask
2. Invert mask → black text on white background (what tesseract expects)
3. Scale 4x with INTER_CUBIC
4. Use `--psm 7` (single text line)

```python
mask = np.where(gray > 180, 255, 0).astype(np.uint8)
inv = cv2.bitwise_not(mask)
scaled = cv2.resize(inv, None, fx=4.0, fy=4.0, interpolation=cv2.INTER_CUBIC)
text = pytesseract.image_to_string(scaled, config='--psm 7 -c tessedit_char_whitelist=0123456789')
```

### 3. grabTaskImage: stronger logo filtering (Sep 13, 2026)
**Problem**: EC&L gold logo was being captured instead of the task grid. Logo passes filter because its src URL doesn't contain "ecnl"/"logo" keywords.

**Fix**:
- Added more bad keywords: `'gold', 'shine', 'gradient', 'social', 'share', 'follow', 'ec and l'`
- Check `title` attribute and `grandparent` class
- Increased parent traversal from 6 to 8 levels
- Added `<a>` tag (anchor links = logos), `cls.includes('logo')`, `cls.includes('brand')`, `cls.includes('sidebar')` to skip
- **Square image penalty changed from -15 to -50** (logos are ~1:1, task grids are ~3:1+)
- Wide aspect bonus increased from +10 to +20

### 4. Font installation (Sep 13, 2026)
**Problem**: Oracle Linux minimal has only 34 fonts. No web fonts (Arial, Roboto, etc.). ECNL page renders broken layout.

**Fix**: Installed 252 fonts:
```bash
sudo dnf install -y google-noto-sans-fonts google-noto-serif-fonts google-roboto-fonts \
  google-roboto-slab-fonts google-noto-color-emoji-fonts dejavu-sans-fonts \
  liberation-sans-fonts liberation-serif-fonts liberation-mono-fonts
```

### 5. Debug image save path (Sep 13, 2026)
**Problem**: `slot.js` hardcoded Windows path `C:\VisionTap\pcapp\scanner\debug_captured_task.png` — fails silently on Linux.

**Fix**: Changed to cross-platform path using `require("os").homedir()`:
```javascript
const debugPath = require("path").join(require("os").homedir(), "VisionTap", "pcapp", "scanner", "debug_captured_task.png");
```

### 6. Scanner /report and /stats endpoints (Sep 13, 2026)
Added to `pcapp/scanner/server.py`:
- `POST /report` — receives task reports from slot.js (pointsDone, pointsTotal, withdrawable, correct, etc.) and saves to `scanner_stats.json`
- `GET /stats` — returns saved stats for dashboard

### 7. Dashboard with earnings display (Sep 13, 2026)
Updated `slotbrowser/dashboard.js`:
- Reads from `GET /stats` endpoint
- Shows per-slot: task count, correct/wrong, accuracy %, points done/total, withdrawable balance, last answer result
- Auto-refreshes every 10s via `<meta http-equiv="refresh" content="10">`
- Systemd control buttons (restart/stop) use `sudo systemctl` commands

## Deployment Steps (when updating)
```bash
# Local
git add -A && git commit -m "message" && git push

# Server
ssh oracle_key opc@140.245.49.233
cd /home/opc/VisionTap && git pull
sudo systemctl restart visiontap-scanner
sudo systemctl restart visiontap-electron
sudo systemctl restart visiontap-dashboard
```

## Troubleshooting
- Check scanner logs: `sudo journalctl -u visiontap-scanner -f`
- Check electron logs: `sudo journalctl -u visiontap-electron -f`
- Check all services: `sudo systemctl status visiontap-*`
- View captured image: `scp opc@140.245.49.233:~/VisionTap/pcapp/scanner/debug_captured_task.png .`
- Test scanner directly: `curl -s http://127.0.0.1:5566/health`
- Test OCR standalone: run test scripts at `/tmp/test_ocr*.py` on server
