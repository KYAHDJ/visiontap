# Chrome pilot architecture

`slotbrowser/chrome-pilot.js` launches a persistent Playwright-controlled Chrome profile for one account. Environment variables select the account, slot, task mode, profile path, submit delay, and window bounds.

Color workers call scanner endpoint `/detect`; Kyaiko calls `/solve_math`. All workers publish counters and balances through `/report`. Recovery is isolated per worker: three scanner/image failures or a 15-second unchanged/not-ready stall reload only that work page. Reloads are suppressed during manual verification and adaihbi withdrawal.

`slotbrowser/chrome-encashment.js` runs inside adaihbi, temi, and axceling1001. It uses `Asia/Manila`, isolated private encashment configuration/state per account, the configured 8–10 AM payout window (Wednesday for adaihbi, Thursday for temi, Friday for axceling1001), five-minute retries, and payout-history state.

`slotbrowser/dashboard.js` merges configured slots, scanner statistics, and the five Chrome state files. Dashboard controls write per-account Chrome command files. Verification covers only the affected card.

Shared browser scripts remain in `slotbrowser/inject/`; the Flask scanner remains in `pcapp/scanner/server.py`.
