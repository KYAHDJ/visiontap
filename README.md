# VisionTap ECNL

Answerer, watchdog and dashboard for the ECNL Colors task (a picture of 36 shapes and the text "Identify the color of emoji #N ?").

| File | Role |
|---|---|
| `slotbrowser/ecnl-solver.js` | Answerer. Reads the picture, clicks the color 14 s after the question shows. Stops instead of guessing. |
| `slotbrowser/ecnl-vision.js` | Picture reading (runs inside the page with canvas). |
| `slotbrowser/ecnl-watchdog.js` | Watches and fixes: refresh, restarts, closes popups, hides the ad wall. Never answers. |
| `slotbrowser/ecnl-dashboard.js` | Read-only dashboard, port 6261. |
| `slotbrowser/ecnl-ocr.ps1` | Windows OCR helper (MAIN uses tesseract). |
| `slotbrowser/ecnl-digits.seed.json` | Learned digit shapes; copy to `state/ecnl/digits.json`. |

Run on MAIN as systemd services `ecnl-brave`, `ecnl-solver`, `ecnl-watchdog`, `ecnl-dashboard`. See `CLAUDE.md` and `docs/HANDBOOK.md`.
The owner signs in and does any human check. No passwords or tokens live in this repo.
