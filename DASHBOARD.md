# Dashboard — VisionTap Control (Port 8080)

## Overview
Node HTTP server `slotbrowser/dashboard.js` → `http://0.0.0.0:8080` (systemd `visiontap-dashboard`). No framework, single file. Polls scanner + Electron state files, merges, renders mobile-friendly control UI. Live poll 2s (`/api/stats`), live clock `setInterval 1s`.

## Data Sources
- **Electron state**: `~/.config/VisionTap Slots/state/slots.json` → `getElectronSlots()` (active slots list, `id, name, accountName`)
- **Creds**: `credentials.json` + `cred_history.json` (saved via `/save-creds`)
- **Scanner stats**: `GET http://127.0.0.1:5566/stats` → `scanner_stats.json` (`slots: {id: {pointsDone, pointsTotal, withdrawable, taskCount, correctCount, wrongCount, errorCount, lastUpdate}}`)
- **Earnings**: `GET http://127.0.0.1:5566/earnings` → `earnings_history.json` (`{slotId: [{ts, earning, total, taskNum, color}]}`)
- **Loop pause**: `loop_command.json` (`{action:"pause"|"resume"}`)
- **Status**: `GET http://127.0.0.1:5566/health` + `ps aux | grep electron`

## Merging Logic (`getMergedSlots`, dashboard.js:56-134)
For each `electronSlots.active`, resolve scanner slot:
`scannerSlots[id] || scannerSlots[name] || Slot ${id} || Slot ${Number(id)+1} ...` → if none, pick best by `max taskCount`. Earnings resolved similarly by id/name/legacy → fallback to longest history. New-cycle handling: `pointsDone 0-10` → clear `displayHist` (don't show old 195), `pointsDone >=250 → 0`. `totalEarned = sum(earning<10)`, last 20 reversed.

## HTTP API
| Path | Method | Action |
|------|--------|--------|
| `/` | GET | HTML `buildPage()` (cache `no-store`, version `v=Date.now()`) |
| `/api/stats` | GET | JSON `{scannerUp, electronProcs, loopPaused, slots:[merged]}` |
| `/cmd?action=&slot=` | GET | Write `slot_commands.json` `[{action,slot}]` → 302 `/` (actions: `pause,resume,restart,refresh,remove`, slot `all` or id) |
| `/loop?cmd=` | GET | Write `loop_command.json` `{action}` |
| `/save-creds?slot=&user=&pass=` | GET | Update `credentials.json[slot]`, update `cred_history.json` |
| `/restart` | GET | `sudo systemctl restart visiontap-electron` + `Refresh:3` |
| `/debug-images` | GET | Gallery of `../debug_images/*.png` |
| `/debug-images/:file` | GET | Serve png |

Electron `main.js` polls `slot_commands.json` + `loop_command.json` every 2s, executes and clears. Credentials polled every 2s → hot-reload + `refreshPage("creds-updated")`.

## UI (`buildPage`)
- Pills: Scanner Online/Offline, Electron Running/Stopped, Loop Running/Paused
- Global controls: Resume/Pause/Restart/Refresh All, Remove All
- Loop: Resume/Pause Loop (toggles `loop_command.json`)
- Per-slot card: name, badge (Active `#10b981` if `correct>0`), balance `₱withdrawable`, points `done/total` + progress bar, results `correct✓ wrong✗`, creds form (user+pass Save), earnings history (last 20, `+earning #task color ts`), actions `⏸ ▶ ↻ ↺ ✕` (pause/resume/restart/refresh/remove via `/cmd`)
- Server: Restart VisionTap
- Footer live dot + `Ltxt` updated every 1s, `fetch /api/stats?t=Date.now()` every 2s, `Cache-Control: no-store`, `render()` replaces `#slots` innerHTML.

## Flow
```
Browser --GET /api/stats--> dashboard.js --curl 5566/stats + read slots.json--> merged JSON
Browser poll 2s --> render()
User clicks Pause All --> GET /cmd?action=pause&slot=all --> slot_commands.json --> main.js (2s poll) --> slot.setPaused(true)
User saves creds --> GET /save-creds --> credentials.json --> main.js (2s poll) --> slot._creds updated --> reload
```

## Dev
Run locally: `cd slotbrowser && node dashboard.js` (needs `~/.config/VisionTap Slots/state` + scanner on 5566). No npm deps. Logs via `log()`.
