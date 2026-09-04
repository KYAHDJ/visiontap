# VisionTap Dashboard + Auto-Push

Live, public dashboard showing the last **3** automation runs. It is **output
only** — all heavy logic stays in the Chrome extension.

## Flow

```
Chrome extension (local)
   │ after each ECNL submit:
   │   build run record (screenshot + per-stage timings + time + battery%)
   │   POST -> http://localhost:8177/record   (silent, best-effort)
   ▼
pcapp/keeper.py  (local Python, binds ONLY to 127.0.0.1:8177)
   │   append record to data/runs.json (max 3, newest first)
   │   git add data/runs.json -> commit -> push  to this repo
   ▼
GitHub (this repo)
   ▼
Vercel  (auto-rebuild on push -> serves the live dashboard)
```

## One-time setup

1. **Vercel project** — import this repo (`KYAHDJ/visiontap`) into Vercel.
   - Framework preset: **Other**. Build command: none. Output: repo root
     (`vercel.json` in this repo already sets this). The dashboard is `index.html`
     and the data is `data/runs.json`.
2. **Connect git** — make sure your local clone's remote points at this repo so
   the keeper's `git push` lands here:
   ```
   git remote set-url origin https://github.com/KYAHDJ/visiontap.git
   git push -u origin HEAD
   ```
   (A git credential helper on Windows lets the keeper push without prompts.)

## Running the keeper (the auto-push)

1. Start it once (keep it running while the automation loop runs):
   - Double-click `pcapp/keeper.bat`, or
   - `python pcapp/keeper.py`
2. It listens on `127.0.0.1:8177` and, on every `/record`, updates
   `data/runs.json` (max 3) and runs `git add data/runs.json && commit && push`.
3. Vercel auto-redeploys → dashboard updates live (polled ~5s in the page).

> Keep the machine awake on lid close if you want it to keep pushing while away:
> Windows Settings → System → Power → "When I close the lid" → **Do nothing**.

## External watchdog (auto-restart when stuck)

The extension should never stop on its own, but if it ever gets fully stuck
(hung on a page / no progress for >60s, or the worker dies), a separate local
watchdog forces a clean restart from scratch:

1. Run it alongside the keeper:
   - Double-click `pcapp/watchdog.bat`, or
   - `python pcapp/watchdog.py`  (optional args: `--timeout 60000 --interval 5`)
2. How it works (fully local — GitHub/Vercel stay pure output):
   - The extension `POST`s a **progress heartbeat** to the keeper every ~8s
     while the loop runs.
   - The watchdog polls `GET /heartbeat`; if **no progress** for the timeout
     (>60s), it `POST`s a one-shot `reset` command to the keeper.
   - The extension polls `GET /command`, and on `reset` does a **full
     self-reset**: stop → clear → reload all ECNL + Gemini tabs → restart from
     step 1. The loop **never goes STOPPED** from this path.

> The watchdog only issues a reset when progress is stale. A normal loop running
> fine will never see a reset.

## Extension side

`background.js` records per-stage timing (waiting, screenshot, ECNL→Gemini,
Gemini loading, submission), reads battery %, and on submit silently
`fetch`es to the keeper. If the keeper isn't running, the fetch fails silently
and the loop is unaffected. `host_permissions: <all_urls>` already covers
`http://localhost:8177`.

Battery % comes from **two sources**, in order:
1. **Browser Battery Status API** (`navigator.getBattery`). This is often
   blocked or unsupported in Chrome service workers / sandboxed profiles.
2. **Fallback: the local keeper** — `GET http://localhost:8177/battery` returns
   the real Windows battery via `GetSystemPowerStatus` (ctypes), which is
   reliable. The keeper also auto-fills any `null` battery on `/record`.

If both fail, the dashboard shows `--%`.

## Sandboxie note

If Chrome runs inside a Sandboxie sandbox, the in-extension `fetch` to
`localhost:8177` must be allowed to reach the real desktop. In Sandboxie Plus,
enable **loopback access** for the box running Chrome. The keeper itself runs on
the real desktop and is unaffected.

## Screen focus note

The loop captures the ECNL tab *without* stealing OS focus: it makes the tab
active inside its own window but does **not** call `windows.update(focused)`.
So it will not teleport your screen to the desktop running the sandboxed Chrome.
(One consequence: `captureVisibleTab` needs the ECNL window visible, not
minimized.)

## Layout

| Path              | Purpose                                       |
|-------------------|-----------------------------------------------|
| `index.html`      | Live dashboard (renders `data/runs.json`)     |
| `data/runs.json`  | Last 3 runs, newest first (pushed by keeper) |
| `pcapp/keeper.py` | Local HTTP keeper + git pusher (+ native battery, heartbeat, commands) |
| `pcapp/watchdog.py`| External 1-min stall watchdog (issues reset) |
| `pcapp/watchdog.bat`| Double-click launcher for the watchdog        |
| `pcapp/keeper.bat`| Double-click launcher for the keeper          |
| `vercel.json`     | Vercel static + function settings             |