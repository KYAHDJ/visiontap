# VisionTap Complete System Handoff

Last updated: October 17, 2026 (Asia/Manila)

## 1. Purpose and current scope

VisionTap is a multi-server browser automation and monitoring system for ECNL task accounts. It provides isolated Chrome profiles, image recognition, controlled answer delays, automatic recovery, scheduled payouts, and public read-only dashboards with optional authenticated administration controls.

The active scope is:

- ECNL task automation
- Per-account Chrome sessions
- Per-account answer delays
- Scheduled ECNL payouts
- Balance, task, payout, and health dashboards
- Scanner, browser, page, and service watchdogs
- Contabo server deployment and GitHub backups

KeyCash and Encodra are not part of the active system. Do not restore their workers, services, profiles, dashboard entries, or experimental files.

## 2. Non-negotiable safety and data rules

- Never commit passwords, cookies, OAuth codes, browser session tokens, GCash numbers, recipient names, or admin passwords to GitHub.
- Credentials belong only in private server-side environment/configuration files with mode `0600`.
- Each account must use its own Chrome user-data directory.
- Public dashboards must not reveal login or payout credentials.
- Dashboard controls must require admin authentication.
- Never combine histories, balances, payout records, or credentials between accounts.
- Preserve browser profiles during ordinary service restarts.
- Restart only the affected account whenever possible.

## 3. Server and GitHub branch map

| Server | Address | Active group | GitHub branch |
|---|---:|---|---|
| Original Contabo | `91.230.110.15` | Alexander, Elizabeth, Theodosia, Aaron | `Contabo` |
| Grouped-account Contabo | `169.58.93.176` | Danica, Nikki, DNC, Darlene, Diana | `Contabo3monkeys` |
| Main Contabo | `169.58.134.171` | Former Oracle ECNL group | `ContaboMain` |

Repository: `https://github.com/KYAHDJ/visiontap`

The former Oracle tenancy was terminated and should not be treated as an active deployment target.

## 4. Account layout

### Original Contabo — `91.230.110.15`

| Account | Platform | Scheduled day | Answer delay | Browser position |
|---|---|---|---:|---:|
| `Alexander1001` | ECNL | Tuesday | 500 ms | `0,0` |
| `Elizabeth1001` | ECNL | Wednesday | 700 ms | `512,0` |
| `DearTheodosia` | ECNL | Thursday | 0 ms | `1024,0` |
| `AaronBurr` | ECNL | Friday | 300 ms | `1536,0` |

The display is `3072x1024`; each mobile-style browser is normally `512x1000`. The final `2560,0` position is intentionally unused.

### Grouped-account Contabo — `169.58.93.176`

| Account | ECNL payout day | Answer delay | Dashboard grouping |
|---|---|---:|---|
| `danicajgb` | Monday | 3.9 seconds | Danica + Nikki + DNC |
| `nnnikkikim` | Tuesday | 4.1 seconds | Danica + Nikki + DNC |
| `dncjnnpabo22` | Wednesday | 4.3 seconds | Danica + Nikki + DNC |
| `darlenejoyce` | Monday | 4.0 seconds | Darlene only |
| `DianaJanelle` | Monday | 3.7 seconds | Diana only |

Dashboard isolation is required:

- Danica, Nikki, and DNC may appear together.
- Darlene must appear alone.
- Diana must appear alone.
- No Darlene/Diana cross-listing is allowed.

### Main Contabo — `169.58.134.171`

Active ECNL accounts:

- `adaihbi`
- `temi`
- `axceling1001`
- `ClarenceBopis`
- `ConnorMofu`
- `jinninijin`

`jinninijin` uses a 450 ms answer delay and Monday payout schedule. Treat the deployed private configuration as authoritative for the remaining account-specific delays and payout details.

## 5. Credentials and payout data

Credentials and recipient details are intentionally omitted from this handoff.

Sources of truth on each server:

- Account environment files: `/home/opc/.config/VisionTap-Chrome/<account>.env`
- Isolated Chrome profiles: `/home/opc/.config/VisionTap-Chrome/<account>/`
- VisionTap state: `/home/opc/.config/VisionTap Slots/state/`
- Private payout configuration: per-account JSON in the state directory
- Dashboard admin configuration: server-side environment/drop-in only

Do not reconstruct secrets from chat history or commit them to the repository. Ask the owner to enter or confirm them directly when a server must be rebuilt.

## 6. Core architecture

### Per-account browser worker

Each account runs as:

```text
visiontap-chrome@<account>.service
```

The worker:

1. Opens Chrome using the account's persistent profile.
2. Positions the browser according to its environment file.
3. Restores the authenticated session when possible.
4. Opens the correct work page.
5. Reads the current task image.
6. Sends it to the local scanner.
7. Applies the account-specific delay.
8. Enters and submits the answer.
9. Reports balance, points, task count, health, and timing to the dashboard state.
10. Recovers only that account when it stalls.

### Scanner services

- ECNL scanner: `visiontap-scanner.service`

### Display stack

- `visiontap-xvfb.service`
- `visiontap-openbox.service`
- VNC/noVNC services where installed
- Google Chrome Remote Desktop for owner access

### Dashboard

- Service: `visiontap-dashboard.service`
- Default port: `6260`
- Public view: read-only operational and payout information
- Admin sign-in: enables service controls and editable private settings

### Watchdog

- Service: `visiontap-watchdog.service`
- Reads the active account list from `VT_ACCOUNTS`
- Checks scanner, dashboard, display stack, and every configured Chrome worker
- Restarts the smallest affected component instead of restarting everything

## 7. ECNL behavior

### Task loop

- Each Chrome profile is independent.
- Delays are per account and must not be globally shared.
- The delay is applied immediately before answer submission.
- A task is counted only after confirmed submission.
- Scanner failure must retain the task for retry rather than guessing.
- Page verification or challenge states suspend automation and automatic refresh.

### Recovery

ECNL health logic includes:

- Missing-image retry counter
- Checking-state timeout
- Input readiness checks
- Submit readiness checks
- Same-image detection
- Server/runtime error detection
- Shared-site outage coordination
- Per-account restart after persistent failure
- Preserved profile/session during restart

Do not use aggressive refresh loops. They can interrupt valid submissions and create the appearance that accounts have identical answer speeds.

## 9. ECNL payout behavior

General production behavior:

- Payouts run during the configured morning window, normally beginning at 8:00 AM Philippine time.
- ECNL task payout estimates display gross and the expected amount after a 10% deduction.
- Temporary network-payout overrides must automatically return to normal task payout behavior afterward.
- At the end of the window, perform a final payout-history refresh so late status/reference updates are captured.
- Dashboard payout panels must support multiple payout records on the same day, including task and network records.
- Duplicate records must be deduplicated using stable transaction/reference identity, not just display text.

## 10. Dashboard requirements

Every dashboard must provide:

- Correct account isolation
- Current balance
- Points and progress
- Per-account answer/change rate
- Balance history
- Next payout gross
- Expected amount after deduction
- Scheduled payout day and time
- Payout Information button
- Multiple payout records when applicable
- Scanner, browser, loop, and account health
- Pause, resume, refresh, and restart controls only after admin sign-in

Calculation rules:

- Never reuse another account's history as fallback data.
- Sum every account's individual next-payout projection; do not average grouped accounts.
- Reject impossible rate spikes and stale samples.
- Keep calculation windows account-specific.
- Public views must hide credentials and configuration forms.

Useful dashboard URLs:

```text
http://91.230.110.15:6260/?group=theodosia-aaron
http://169.58.93.176:6260/?group=danica-niki
http://169.58.93.176:6260/?group=darlene
http://169.58.93.176:6260/?group=diana
http://169.58.134.171:6260/
```

## 11. Important repository files

```text
slotbrowser/chrome-pilot.js
slotbrowser/chrome-encashment.js
slotbrowser/dashboard.js
slotbrowser/inject/slot_inject.js
slotbrowser/inject/ad_blocker.js
pcapp/scanner/server.py
watchdog.sh
visiontap-chrome@.service
visiontap-scanner.service
visiontap-dashboard.service
visiontap-watchdog.service
visiontap-xvfb.service
visiontap-openbox.service
setup_server.sh
```


## 12. Deployment procedure

### Before deployment

1. Confirm the destination server and matching GitHub branch.
2. Back up private Chrome profiles and state files outside Git.
3. Run syntax checks and tests locally.
4. Confirm no secrets or screenshots are staged.
5. Confirm the account list and browser positions.

### Deploy application files

Copy only the changed application/service files, preserve ownership as `opc:opc`, and use appropriate modes. Do not replace private environment files with repository examples unless rebuilding intentionally.

After service-file changes:

```bash
sudo systemctl daemon-reload
```

Restart only affected services. Example:

```bash
```

### Verification

Check:

```bash
systemctl is-active visiontap-scanner.service
systemctl is-active visiontap-dashboard.service
systemctl is-active visiontap-watchdog.service
systemctl is-active visiontap-chrome@<account>.service
```

Then inspect recent logs:

```bash
journalctl -u visiontap-chrome@<account>.service --since "10 minutes ago" --no-pager
```

Verify actual task progression, not merely an `active` service state.

## 13. Git procedure

Always target the branch that belongs to the server being changed.

1. Review `git status` and the complete diff.
2. Remove generated screenshots, session files, cookies, and temporary artifacts.
3. Run syntax/tests.
4. Stage only the clean system snapshot.
5. Commit with an outcome-focused message.
6. Use `--force-with-lease` when the owner requests a force update.
7. Compare the local commit hash with the remote branch hash.
8. Do not touch unrelated branches.

`--force-with-lease` is preferred to raw `--force` because it protects against overwriting unexpected remote work while still replacing the intended branch snapshot.

## 14. Diagnostic checklist

### Account looks frozen

1. Check the account service state and restart count.
2. Check whether task submissions are still appearing in logs.
3. Check scanner health separately.
4. Determine whether the page has no image, the same image, a not-ready input, a verification page, or a server error.
5. Allow the staged recovery to act.
6. Restart only that account if necessary.

### All accounts time out

1. Check the remote site's availability from the server.
2. Check DNS and route connectivity.
3. Check for a shared upstream outage before restarting every browser.
4. Confirm the scanner, X display, dashboard, and watchdog remain healthy.

### Dashboard values spike

1. Reject stale or impossible samples.
2. Confirm the balance belongs to the same account.
3. Confirm history timestamps are monotonic.
4. Avoid deriving a long-term rate from a tiny time interval.
5. Deduplicate payout records by stable identifiers.

### Browser position is wrong

Check:

```text
/home/opc/.config/VisionTap-Chrome/<account>.env
```

Then restart only that browser service and verify the position in its journal.

## 15. Known decisions and exclusions

- Oracle is no longer an active server.
- KeyCash was permanently removed.
- Encodra was inspected but must not be integrated into this system.
- Dashboard account groupings must remain isolated as specified above.
- Account credentials and payout recipients remain private server data and are not part of Git handoff materials.

## 16. Recommended first actions for the next operator

1. Read this document fully.
2. Inspect the matching Git branch before changing a server.
3. Read the live account environment files without exposing their contents.
4. Confirm `VT_ACCOUNTS` matches the intended server group.
5. Verify all active services and recent per-account submissions.
6. Confirm dashboards show only their authorized account groups.
7. Make the smallest possible change.
8. Test locally, deploy to one affected component, and verify live behavior.
9. Commit and push only after live validation.

