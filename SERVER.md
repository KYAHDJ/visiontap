# Server Side — Scanner + Electron Slots

## 1. Scanner (`pcapp/scanner/server.py`, Flask `0.0.0.0:5566`)

### Endpoints
- `GET /health` → `{"status":"online"}`
- `POST /detect` — main color detection. Body `{"image":"data:image/png;base64,...", "target_num":optional}`. Steps: base64→cv2, OCR badge if needed, compute 3×12 grid, sample inner 50% of target cell (9 points 3×3), `detect_color_from_sample` (HSV), majority vote purity ≥50%, else 400. Returns `{"color", "target_num", "cell":{row,col}}` or `400 {"error"}`.
- `POST /debug_detect` — debug, saves `debug_input.png`, calls `ocr_read_header`/`count_blobs_binary` (legacy math).
- `POST /report` — task report from `slot.js`. Body `{slot, pointsDone, pointsTotal, withdrawable, taskCount, correctCount, wrongCount, errorCount, correct, color, taskNum}`. Persists to `scanner_stats.json` (`slots:{slot:{...}}`) + new-cycle reset ( `old>=100 && new 0-10` → reset counts, `pointsTotal 0/0 →250`), `lastUpdate`. Earnings tracked if `correct && withdrawable > old` → `earnings_history.json[slot].push({ts, epoch, earning, total, taskNum, color})` (keep 500).
- `GET /stats` → `scanner_stats.json` or `{"slots":{}}`
- `GET /earnings` → `earnings_history.json` or `{}`

### Color Pipeline
- `COLOR_RANGES` HSV strict (red 2 ranges, pink 2, orange/yellow/green/blue/purple/brown/white/gray/black). `detect_color_from_sample` median HSV → achromatic (V<45 black, S<30 white/gray) → brown (H 8-22 S<210 V<150) → chromatic range match.
- `ocr_read_badge_number`: bottom 60% crop → HSV `85,30,50-135,255,220` mask → contours `18-60×18-120` → pad 4 → gray → `where >180 →255` mask → invert → `resize 4x CUBIC` → `pytesseract --psm 7 -c tessedit_char_whitelist=0123456789` → regex `1-36`.
- Grid: `margin_x 0.05, grid_width 0.90, margin_y 0.05, grid_height 0.53` → `cell_w = grid_width/12, cell_h = grid_height/3` → target `N-1` → `row=N//12, col=N%12` → inner pad 25% → 9 samples.

Debug: `DEBUG_DIR/debug/`, `debug_input.png`.

### Running
`python server.py` (port 5566, CORS). Systemd `visiontap-scanner`. Deps: `flask, flask_cors, opencv-python-headless, pytesseract, numpy, Pillow`, binary `tesseract`.

## 2. Electron Slots (`slotbrowser/`)

### Main (`main.js`, 706 lines)
- Single `BrowserWindow` (frameless, `1440×800`, `background #0b1020`, `preload shellpreload.js`) + `N` `WebContentsView` slots (isolated `persist:vt-slot-${id}`, `preload slotpreload.js`). Layout `layout()` splits width `GUTTER 8, TOOLBAR_H 82, PHONE_ASPECT 0.7`, scroll if overflow.
- `createSlot(id,name,stopRequested,opts)` → session `wireSession` (no spellcheck, no permissions), `Slot` attach, `zoom/hud/delay` from `settings.slots[id]`, `ensureRunning` or `stopRequested`, `loadURL(getWorkUrl())` (`https://ecnlmediamarket.com/solving-colors`).
- IPC `vt-*`: `slot-add/remove/toggle/reload/focus`, `pause-all`, `settings-get/set`, `slot-set-creds/flags/boot/logout`, `state-get`, `debug-images`, etc. Broadcast `vt-state`.
- File watchers (2s): `credentials.json` → hot-reload `_creds` + `refreshPage`, `loop_command.json` → pause/resume all, `slot_commands.json` → per-slot `pause/resume/restart/refresh/remove`.
- Tray, auto-start, bounds save (`winbounds.json`), `BUILD_STAMP`.

### Slot (`slot.js`, ~884 lines)
`SCANNNER_URL http://127.0.0.1:5566`, `STALL_RESET_MS 15000`, `HEARTBEAT 30s`, `COMMAND_POLL 15s`, `HUD_TICK 5s`.

- `Slot` per view: `id,name,view,wc, _creds, taskMode, loopRunning, isProcessing, taskCount/correct/wrong/error, points {done,total}, lastProgress/ActionTs, imageHash, paused, hud, zoom, delay, timers`.
- `attach()`: block `will-navigate`/`did-navigate`/`did-redirect` non-work, `ipc-message vt-slot-msg` (stale_refresh, ensure_running), `render-process-gone` reload.
- `inject()` → `executeJavaScript` `__vtCreds + ad_blocker.js + slot_inject.js`.
- `api(method,arg)` → `window.__vtapi.method(arg)`.
- Loop: `startLoop` → timers `startLiveTimer` (HUD), `startKeeperClients` (heartbeat/command), `startPointsSync` (8s poll `getTaskMeta` → `/report`), `startStaggered` → `runIteration`; `stopLoop`, `setPaused`.
- `runIteration`: check `taskStartTime` timeout, `inject()`, `api("pageReady")` → if not ECNL → wait/reload, if `isAuth` → `tryLogin` → wait 3s, if not work → redirect, `waitForInputBox()` (5s deadline, checking instant reload, no 120s wait), `getTaskMeta` points, `scannerEnsure()` (health → spawn `pythonw server.py` if down), `grabImage`, dedup hash log only, `fetch SCANNER_URL/detect` → `color`, `taskCount++`, `captureAndSendReport`, `fill(answer)` → random `1-3s` delay submit, `touchAction/Progress`, `scheduleNext(800*d delayMult)`.
- `waitForInputBox`: `deadline 5s`, loop `checkInputReady` → if `isBlank2026` immediate reload, if `checking` instant reload (removed 120s wait), else `ready` → true, status `Waiting...`, `sleep 200`.
- `captureAndSendReport`: sleep 1.5s → `getVerdict` 3× → `getTaskMeta` withdrawable/points → new-cycle `100→0-10` reset → correct++ via verdict or points rose → `sendTaskReport`.
- `refreshPage`, `hardRestart` (if stall `STALL_RESET_MS` both progress+action), `pointsSync` (8s push points to scanner), `snapshot()` for `statePayload`.

### Inject (`inject/slot_inject.js`, 847 lines)
Runs in page, `window.__vtapi`. `COLOR_WORK_URL`, `WORK_RE`.

- `findAnswerInput` (placeholder/aria `type|answer` or `inputs[0]`), `findSubmitButton` (`submit|solve|answer`), `isCheckingState` (`button text checking|encoded solutions` — now instant reload, no 120s wait).
- `clearSiteData` (cookies, localStorage, sessionStorage, indexedDB).
- `grabTaskImage`: canvases `100-1200` middle viewport → `toDataURL`, else imgs `magic-colors` or scored (`badKeywords` skip, size, viewport, aspect, penalty `-50` square) → canvas draw → `dataURL`.
- `pasteAndSubmit`: `navigator.clipboard.writeText` + `nativeSetter` + `input/change` → random `1-3s` weighted delay → `btn.click()` or `Enter`.
- `nukeAds` (`AD_SELECTORS` remove, fixed `z>100` divs) + `MutationObserver`.
- `autoLogin` + `vt.tryLogin` (user/pass from `__vtCreds`, 10 attempts, 1.5s interval).
- `checkSqlState` (`sqlstate|mysql`), HUD (`visiontap-hud` top-right, timer/correct/wrong/error/badge), `__vtapi`:
  - `checkInputReady` → `{ready, hasBox, hasBtn, checking, boxW/h, btnW/h, empty, loaded, isBlank2026/BlankNoTask, domDump}` — `ready = loaded && imgOk && !hidden && !blank`; clears non-empty box value; logs hidden `stale_refresh`.
  - `grabImage`, `debugDumpDOM/ListImages`, `fill`, `getVerdict` (regex + selectors + color), `getTaskMeta` (withdrawable `₱$`, points `X/250` robust), `pageReady`, `requestRefresh`.
  - `staleTimer 10s` (was 30s) → `stale_refresh`, `centerTaskArea` 1.5s.

### Preloads/Shell
`preload/slotpreload.js` bridges `__vtHost.signal` + `__vtapi` IPC, `preload/shellpreload.js` exposes `vt.getState/onState/invoke`. `shell/` (HTML/CSS/JS) toolbar, slot cards, settings.

## 3. Data Files & Flow
```
Page (ecnl solving-colors) <--inject--> Slot --fetch 5566/detect--> Scanner (py)
Slot --fetch 5566/report--> scanner_stats.json --curl--> Dashboard --fetch /api/stats--> Browser
Dashboard --slot_commands.json--> Main --Slot loop
```

State: `~/.config/VisionTap Slots/state/` (Electron) + `pcapp/scanner/*.json` (scanner).

## 4. Build & Run
`slotbrowser/package.json` `electron 44.2, electron-builder 26.15`. `npm start` (`electron .`), `npm run dist` → `dist/` (nsis/portable). No build needed on Oracle (runs `npx electron . --no-sandbox` directly from source).
