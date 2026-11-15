# 2026-11-15 — ECNL Cloudflare update, ad cleanup, worker hardening

Branch: `ecnl-cloudflare-ads-cleanup-2026-11-15`
No credentials, tokens, payout details or private keys are in this folder.

## What happened

1. **Missed cashouts on MAIN (ContaboMain).** Over Nov 9–13 two accounts missed their 8 AM cashout
   (a Tuesday and a Friday account). In both cases the cashout page navigation timed out
   (`page.goto ... 30000ms`), the solver loop then threw, and the worker went completely silent
   for hours (no heartbeat, no retry). GROUP and THEODOSIA, running the same cashout code, did not miss.
2. **Worker hardening on MAIN** (see `server-patched-ContaboMain/chrome-pilot.js`):
   - `SELF_HANG_LIMIT_MS = 150000` / `SELF_HANG_BUSY_LIMIT_MS = 420000`: a worker with no heartbeat
     write for 2.5 min (7 min while a cashout is running) exits with code 75 so systemd restarts it
     with the profile preserved. Paused workers and manual-verification holds are never killed.
   - Dashboard-control polling (`pollDashboardControl`) is wrapped in try/catch so a failing
     reload/control command can no longer break the loop.
3. **CPU cap removed on MAIN workers** (`systemd/nocap.conf`): the per-worker `CPUQuota=38%` is cleared.
   MAIN is 4 cores / 8 GB; Theodosia (6 cores, no cap) had no misses. Suspected, not proven, cause.
4. **Watchdog enabled on MAIN** (`systemd/visiontap-watchdog.service`) with `VT_ACCOUNTS` pinned to the
   7 local MAIN accounts. Note: the watchdog script logs to `/tmp/visiontap-watchdog.log`, which
   root cannot write (sticky `/tmp`, file owned by `opc`); restarts still work but are not logged.
   (Later disabled again on all servers together with all workers, see below.)
5. **Theodosia payout windows** for four accounts extended from 8–9 AM to 8–10 AM PH
   (config `endHour`). The encashment code re-reads the config file on every 15 s tick, no restart needed.
6. **ECNL migrated behind Cloudflare** (Nov 15): for several hours the site served a wrong certificate and
   HTTP 503, then came back with a Cloudflare "Verify you are human" (Turnstile) check on `/login`.
   The automated worker Chrome could not get past the check; a normal, human-driven Chrome on the
   same server could. All 21 workers ended on the login page. The check is **not** bypassed by any
   change in this branch.
7. **All automation stopped and disabled** on MAIN, GROUP and THEODOSIA (workers + watchdogs),
   nothing deleted. Only the `adaihbi` worker on MAIN was started again for a one-time test.
8. **One-time network-wallet cashout override** for `adaihbi` on 2026-11-16 (8–10 AM PH):
   `oneTimeOverride: { date, type: "network", weekday, startHour, endHour }` in its encashment
   config; it reverts to the normal task schedule automatically afterwards.

## Ad removal for the new ECNL site

The new site shows Google ads and a Google "rewarded ad" wall ("Unlock more content").

- `VisionTap-ECNL-Extension/content.js` (the browser extension used with a manually signed-in Chrome):
  - Google-owned elements are **deleted**: Funding Choices dialog, `google-anno` cards
    (`#google-anno-sa` bottom strip, `google-anno-sc` pills), the `auto-rewarded` dialog
    (a bare `<div>` under `<body>` that hosts a shadow root, plus `.auto-rewarded-focus-trap`).
  - Elements the Next.js site also manages (`ins.adsbygoogle`, `aswift*`, `google-auto-placed`, body-level
    ad iframes) are only **hidden**. Deleting them made the dashboard crash with "Something went wrong".
  - Cloudflare / reCAPTCHA / hCaptcha frames are never touched.
  - `#google_vignette` in the URL hash is cleared.
- `server-patched-ContaboMain/slot_inject.js` and `ad_blocker.js`: wording fix
  (`unlock more content`, no trailing "s") and the new selectors (`patch-scripts/patch_ads*.py`).
  Injected `<style>` tags are blocked by ECNL's CSP, so DOM removal/hiding must be used.

## Findings worth keeping

- The Cloudflare check passed in a normal Chrome on the Contabo server, so the server IP is not the blocker;
  the Playwright-driven worker browser is.
- Chrome 137+ ignores `--load-extension` in branded Chrome. The extension was loaded through
  `chrome://extensions` (Developer mode, Load unpacked) from `/home/opc/VisionTap-ECNL-Extension`.
- The `isVerificationUrl()` check in the pilot only matches Cloudflare challenge URLs, so the ad
  blocker/injection does run on `/login`.

## Not in this branch

Server-only state: credentials, Chrome profiles, per-account configs, backups under
`/root/backup_2026-11-15/`, installed `xdotool`. `slotbrowser/encodra.env` and other untracked
private files were deliberately not committed.

## To start automation again

Re-enable and start the workers one at a time (`systemctl enable --now visiontap-chrome@<account>`),
then the watchdog. The adaihbi one-time override expires on its own after 2026-11-16.
