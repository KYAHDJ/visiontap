# VisionTap - Server Access Guide for AI Agents

Last verified against the live servers: 2026-10-25.
Give this whole file to the AI. It explains how to reach every server without asking the owner for SSH details.

This file contains NO passwords, tokens or key contents. It only says where things are.
Do not commit or publish this file. It describes the owner's infrastructure.

---

## 0. Rules from the owner (read first)

1. Work on the SERVERS. Do not edit files in `C:\VisionTap` locally unless the owner explicitly asks.
2. Never print or paste secrets: account passwords, `VT_REMOTE_CONTROL_TOKEN`, admin passwords, payout recipient names / mobile numbers / emails, cookies, private keys.
 When inspecting config files, mask values (for example `sed -E 's/=.*/=***/'`) or print only the safe keys named below.
3. Change the minimum needed. Restart only the one affected service. Never restart every worker to fix one thing.
4. Back up a file before editing it: `cp -p file file.bak-<reason>`.
5. Syntax-check JavaScript before installing it: `node --check <file>.js` (the file name must end in `.js`).
6. Do not delete Chrome profiles, state files or env files as a "reset".
7. Never put the same account on two servers. One account = one running worker.
8. Do not touch servers the owner did not mention. If asked to change one server, leave the other two alone and say so.
9. Verify live after every change (see section 7) and report what you verified, not what you assume.
10. The owner's git phrase "commit push force no old files" means: commit only the files changed for this task, push with `--force-with-lease` pinned to the known remote tip, and leave unrelated dirty/untracked files alone. See section 8.

---

## 1. The three servers

| Name | IP | Hostname | SSH user | Key file (on the owner's Windows PC) | Git branch | Role |
|---|---|---|---|---|---|---|
| MAIN | `169.58.134.171` | `vmi3652887` | `root` | `C:\VisionTap\.contabo\visiontap_new_contabo` | `ContaboMain` | Main ECNL dashboard. 7 local workers. Shows Jerry from another server. |
| GROUP | `169.58.93.176` | `vmi3659853` | `root` | `C:\VisionTap\.contabo\visiontap_new_contabo` | `Contabo3monkeys` | Danica / Nikki / DNC / Darlene / Diana / Castiel / AannadiaA. |
| ORIGINAL | `91.230.110.15` | `vmi3646523` | `root` (or `opc`) | `C:\VisionTap\.contabo\visiontap_contabo` | `Contabo` | Theodosia/Aaron group, Alexander, Elizabeth. Also runs **jerrytomaton**. |

Key-to-server mapping was tested, do not guess differently:
- `visiontap_new_contabo` works ONLY for MAIN and GROUP, ONLY as `root`. (`opc` is denied.)
- `visiontap_contabo` works ONLY for ORIGINAL (as `root` or `opc`). It is denied on MAIN and GROUP.
- `opc` has no passwordless sudo anywhere, so always connect as `root`.
- Host fingerprints for all three are already in the owner's `known_hosts`, so there should be no "trust this host?" prompt.

Dashboards (port 6260, plain HTTP):
- MAIN: `http://169.58.134.171:6260/`
- GROUP: `http://169.58.93.176:6260/?group=danica-niki` (also `darlene`, `diana`, `theodosia-aaron`)
- ORIGINAL: `http://91.230.110.15:6260/?group=theodosia-aaron` (this dashboard is read-only: `VT_DASHBOARD_READ_ONLY=1`)

---

## 2. How to connect without any prompts

Always use these options so SSH never waits for a password or a question:

```powershell
ssh -i "<KEY>" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 root@<IP> "<command>"
scp -i "<KEY>" -o BatchMode=yes -o ConnectTimeout=15 <local-file> root@<IP>:<remote-path>
```

Ready-made one-liners:

```powershell
# MAIN
ssh -i C:\VisionTap\.contabo\visiontap_new_contabo -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 root@169.58.134.171 "hostname"
# GROUP
ssh -i C:\VisionTap\.contabo\visiontap_new_contabo -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 root@169.58.93.176 "hostname"
# ORIGINAL
ssh -i C:\VisionTap\.contabo\visiontap_contabo -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 root@91.230.110.15 "hostname"
```

Expected hostnames: `vmi3652887`, `vmi3659853`, `vmi3646523`. If the hostname is different, STOP: wrong server.

### Known connection behavior - important

- **SSH to MAIN (and sometimes the others) randomly times out** ("Connection timed out", "scp: Connection closed"). The port is usually open again seconds later. This is a flaky network, not a broken server. **Retry 5-10 times with a 10-15 second pause before giving up.**
- **Beware retry loops that treat a non-zero exit code as failure.** If your remote command ends with something that legitimately returns non-zero (for example `systemctl is-active` on a stopped service returns 3), your loop may re-run a command that already succeeded. Make edit scripts idempotent (they must refuse to patch twice), and end remote commands with `true` or check results explicitly.
- If an upload fails, the remote command that depends on it will fail too. Check `$LASTEXITCODE` after `scp` before running the remote step.

### Windows PowerShell 5.1 pitfalls (the owner's shell)

- Do not put complex multi-line shell code with nested quotes inside `ssh "..."`. It breaks. Instead: write a `.sh` or `.py` file locally in a temp folder, `scp` it to `/tmp/`, then run it. Example:
 ```powershell
 scp -i $KEY -o BatchMode=yes $env:TEMP\task.sh root@<IP>:/tmp/task.sh
 ssh -i $KEY -o BatchMode=yes root@<IP> "sed -i 's/\r$//' /tmp/task.sh; bash /tmp/task.sh; rm -f /tmp/task.sh"
 ```
- Always strip Windows line endings from uploaded scripts with `sed -i 's/\r$//'`.
- Use `;` not `&&` between PowerShell commands.
- `rg` (ripgrep) is not installed locally. `node` is installed locally, so you can test dashboard JS locally in a temp folder.

Optional: if the owner wants shorter commands, add these aliases to `C:\Users\benit\.ssh\config` (ask first - it is a local file):

```
Host vt-main
 HostName 169.58.134.171
 User root
 IdentityFile C:\VisionTap\.contabo\visiontap_new_contabo
 IdentitiesOnly yes
 BatchMode yes
 ConnectTimeout 15
Host vt-group
 HostName 169.58.93.176
 User root
 IdentityFile C:\VisionTap\.contabo\visiontap_new_contabo
 IdentitiesOnly yes
 BatchMode yes
 ConnectTimeout 15
Host vt-original
 HostName 91.230.110.15
 User root
 IdentityFile C:\VisionTap\.contabo\visiontap_contabo
 IdentitiesOnly yes
 BatchMode yes
 ConnectTimeout 15
```

### If the AI tool itself keeps asking for permission

That is the tool's own command-approval setting, not SSH. In Antigravity, allow terminal commands for this workspace (or turn on auto-approve for `ssh`/`scp`), and make sure the workspace includes `C:\VisionTap` so it can read the key files. If the tool runs in a sandbox that cannot read `C:\VisionTap\.contabo\`, it cannot authenticate - the keys must stay on the PC and must never be pasted into chat or committed.

---

## 3. What runs where

All servers use the same layout: Linux user `opc`, app in `/home/opc/VisionTap`, one systemd unit per account.

### MAIN - `169.58.134.171`

Local workers (7): `adaihbi`, `temi`, `axceling1001`, `clarencebopis`, `connormofu`, `jinninijin`, `yaminiko`
Units: `visiontap-chrome@<account>`, `visiontap-dashboard`, `visiontap-scanner` (port 5566), `visiontap-xvfb`, `visiontap-openbox`, `visiontap-vnc`, `visiontap-novnc`. There is no watchdog unit on MAIN.

MAIN also displays two accounts that run elsewhere. They are fetched every 2 seconds from `/api/stats?group=theodosia-aaron` on the other servers, and controlled through `/api/remote/control` with a token:
- `jerrytomaton` (display slot 19) comes from ORIGINAL `91.230.110.15:6260`. Its real slot there is 22.
Do not start Jerry locally on MAIN.

### GROUP - `169.58.93.176`

Workers: `danicajgb`, `nnnikkikim`, `dncjnnpabo22`, `dianajanelle`, `darlenejoyce`, `castiel`, `aannadiaa`
Units also include `visiontap-scanner`, `visiontap-dashboard`, `visiontap-watchdog`, vnc/novnc/xvfb/openbox.
`jerrytomaton` has leftover files here (profile, env, state) but its unit is **disabled and inactive on purpose**. Never start it here. It is removed from this dashboard's account lists.

### ORIGINAL - `91.230.110.15`

Workers: `alexander1001`, `elizabeth1001`, `deartheodosia`, `aaronburr`, `jerrytomaton`
Also running: `visiontap-scanner`, `visiontap-dashboard` (read-only), `visiontap-watchdog`, `visiontap-encodra` (see section 9).
`/home/opc/VisionTap` here is NOT a git repository. Edits here are not tracked by git.

### Slot numbers

- On MAIN, Jerry is shown as slot 19. On ORIGINAL, Jerry's real slot is 22 and Alexander is 19. Slot ids differ between a worker's server and the main dashboard on purpose, to avoid collisions.

---

## 4. Important paths on every server

```
/home/opc/VisionTap/ app root
/home/opc/VisionTap/slotbrowser/dashboard.js dashboard server + the whole web page (HTML/CSS/client JS in one file)
/home/opc/VisionTap/slotbrowser/chrome-pilot.js worker logic
/home/opc/VisionTap/slotbrowser/chrome-encashment.js ECNL payout automation
/home/opc/.config/VisionTap-Chrome/<account>.env per-account env (contains secrets - mask it)
/home/opc/.config/VisionTap-Chrome/<account>/ persistent Chrome profile - never delete
/home/opc/.config/VisionTap Slots/state/ state + payout config (NOTE: the folder name contains a SPACE - quote it)
/home/opc/.config/VisionTap-Dashboard/ dashboard private config (admin.env, remote.env - secrets)
```

Payout schedule per account lives in the state folder:
- `encashment_<account>_config.json` for every account, except the main account `adaihbi` which uses `encashment_config.json`.
- Safe keys to read or edit: `enabled`, `account`, `type` (`task` or `network`), `weekday` (`Mon`..`Fri`), `startHour`, `endHour`, `payment`.
- Do NOT print `receiverName`, `email`, `mobile` - these are payout recipient details.
- Never copy recipient details from one account to another unless the owner explicitly says to.
- For a worker to run payouts, the account must also be listed in `ENCASHMENT_ACCOUNTS` in that server's `chrome-pilot.js`. (This was the cause of Jerry showing Monday / "stuck at 300": his config and that list were missing on ORIGINAL.)

Service names:
```
visiontap-dashboard restart this after editing dashboard.js
visiontap-chrome@<account> restart this after editing a worker's code/env (affects only that account)
```

---

## 5. Current payout schedule (verify live before relying on it)

Window is 8:00-10:00 AM Philippine time (Asia/Manila) unless noted. The servers' own clocks are NOT Manila time (MAIN/ORIGINAL show PST, GROUP shows CEST); the app computes Manila time itself.

MAIN (ECNL task payouts): ClarenceBopis Mon, jinninijin Mon, ConnorMofu Tue, yaminiko Tue, adaihbi Wed, jerrytomaton Wed, temi Thu, axceling1001 Fri.

ORIGINAL (config window 8:00-9:00): alexander1001 Tue, elizabeth1001 Wed, deartheodosia Thu, aaronburr Fri.
(jerrytomaton's schedule file on ORIGINAL is Wed 8-10.)

GROUP: not re-verified in the latest session. Read the state folder before claiming anything.

Check live schedules without exposing recipients:
```bash
cd "/home/opc/.config/VisionTap Slots/state"
for f in encashment_*config.json encashment_config.json; do [ -f "$f" ] && python3 - "$f" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(sys.argv[1], {k:d.get(k) for k in ('enabled','account','type','weekday','startHour','endHour')})
PY
done
```

---

## 6. Dashboard behavior to preserve

MAIN dashboard (`dashboard.js`):
- Account cards and the "Account snapshot" are ordered by payout weekday: Monday, Monday, Tuesday, Tuesday, ... Friday. Within the same day: earlier start hour first, then name.
- "Next encashment" lists ALL accounts tied for the soonest payout day/window (for example "Monday - ClarenceBopis + jinninijin"), not just one.
- "Next payout" is calculated by `nextCashoutProjection` from balance + points/hour up to the scheduled window, with a 10% deduction for task payouts (15% for network). If an account has no schedule it falls back to "projected 300 eligibility" - that fallback is the symptom of a missing schedule config.
- Jerry appears here only through the remote fetch described in section 3.

ORIGINAL dashboard, `theodosia-aaron` view: shows Alexander, Elizabeth, DearTheodosia, AaronBurr only. **Jerry is hidden in the page on purpose** (owner wants him only on the main/adaihbi dashboard).
- IMPORTANT: Jerry must stay in the **server-side** `DASHBOARD_GROUPS['theodosia-aaron']` list on ORIGINAL (around line 73). MAIN reads his data and sends him control commands through that group. Remove him only from the client-side `groups` list inside `render()` (around line 1066), never from the server-side list.

GROUP dashboard: Jerry was removed from `DASHBOARD_GROUPS`, `CHROME_SLOT_ACCOUNTS` and `DEFAULT_CHROME_ACCOUNTS` so a "restart all" can never start a duplicate Jerry there.

Backups made during the latest session (safe to roll back to):
- MAIN: `dashboard.js.bak-payout-order`
- ORIGINAL: `dashboard.js.bak-hide-jerry`, `chrome-pilot.js.bak-jerry-schedule`
- GROUP: `dashboard.js.bak-remove-jerry`

---

## 7. Standard procedures

### A. Edit dashboard.js on a server

1. Download the live file to a temp folder (the live file is the source of truth; it can differ from git).
2. Edit with exact-match replacements that fail if the text is not found exactly once.
3. Run `node --check` locally on the result.
4. Upload to `/tmp/dashboard-new.js`, then on the server:
 ```bash
 cd /home/opc/VisionTap/slotbrowser
 node --check /tmp/dashboard-new.js
 cp -p dashboard.js dashboard.js.bak-<reason>
 install -m 0644 -o opc -g opc /tmp/dashboard-new.js dashboard.js
 rm /tmp/dashboard-new.js
 systemctl restart visiontap-dashboard
 sleep 4; systemctl is-active visiontap-dashboard
 ```
5. Restarting the dashboard does not stop the workers.
6. Careful: the file embeds the whole web page as a template string. Escaping mistakes break only at runtime in the browser, so also test the rendered page (below).

### B. Change a payout weekday

Edit only the `weekday` (and hours if asked) in the account's `encashment_<account>_config.json`. Do not print the file. The dashboard reads it live; no restart is needed for the display. If the account is new on that server, also add it to `ENCASHMENT_ACCOUNTS` in `chrome-pilot.js` and restart only `visiontap-chrome@<account>`.

### C. Restart one worker

```bash
systemctl restart visiontap-chrome@<account>.service
sleep 20
systemctl is-active visiontap-chrome@<account>.service
journalctl -u visiontap-chrome@<account>.service --since '1 minute ago' --no-pager | tail -8
```

### D. Verify live after any change

API (what the dashboards and MAIN consume):
```powershell
(Invoke-WebRequest 'http://169.58.134.171:6260/api/stats' -UseBasicParsing).Content | ConvertFrom-Json
(Invoke-WebRequest 'http://91.230.110.15:6260/api/stats?group=theodosia-aaron' -UseBasicParsing).Content | ConvertFrom-Json
(Invoke-WebRequest 'http://169.58.93.176:6260/api/stats?group=theodosia-aaron' -UseBasicParsing).Content | ConvertFrom-Json
```
Check: every expected pilot has `running = True`, schedules (`encashmentSchedule`) are right, and MAIN still lists `jerrytomaton`.

Rendered page (proves the browser JavaScript actually works):
```powershell
$c='C:\Program Files\Google\Chrome\Application\chrome.exe'
& $c --headless=new --disable-gpu --virtual-time-budget=8000 --dump-dom "http://169.58.134.171:6260/" 2>$null | Out-File $env:TEMP\dom.html -Encoding utf8
# then read card order: class="card-nm">NAME and class="mini-slot-name">NAME
```
Ignore matches that contain `esc(` - those are template code, not rendered cards.

Expected MAIN card order today: ClarenceBopis, jinninijin, ConnorMofu, yaminiko, adaihbi, jerrytomaton, temi, axceling1001.

### E. Quick health check of everything

```powershell
foreach($u in 'http://169.58.134.171:6260/api/stats','http://169.58.93.176:6260/api/stats?group=danica-niki','http://91.230.110.15:6260/api/stats?group=theodosia-aaron'){
 $j=(Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 30).Content|ConvertFrom-Json
 "$u -> " + (($j.chromePilots|%{"$($_.account)=$($_.running)"}) -join ', ')
}
```

---

## 8. Git (only when the owner asks)

Remote: `https://github.com/KYAHDJ/visiontap.git`. Local worktrees (these are what get committed - not the dirty root checkout):

| Worktree | Branch | Matches server |
|---|---|---|
| `C:\VisionTap\.contabo\recovery-main` | `ContaboMain` | MAIN |
| `C:\VisionTap\.contabo\recovery-3monkeys` | `Contabo3monkeys` | GROUP |
| `C:\VisionTap\.contabo\recovery-original` | `Contabo` | ORIGINAL (legacy; Encodra-related history, treat with caution) |

Rules:
- Last known tips: `ContaboMain` = `cdf016b`, `Contabo3monkeys` = `812d5d4`. Run `git fetch` and confirm before pushing.
- Stage by explicit path only (`git add <file>`), never `git add .` or `-A`.
- Push with a pinned lease: `git push --force-with-lease=<Branch>:<expected-old-sha> origin <Branch>`. Confirm afterwards with `git ls-remote origin refs/heads/<Branch>`.
- Never commit `.env` files that contain credentials, `credentials.json`, `cred_history.json`, key files, or anything from `C:\VisionTap\.contabo\` outside the worktrees. A previous push was blocked for exactly this reason. The tracked `config/*.env` files on `Contabo3monkeys` were checked and hold only slot / delay / window settings (no passwords).
- The recovery worktrees may still contain unrelated uncommitted changes. Leave them alone.
- The root `C:\VisionTap` checkout is on `main` and is dirty. Do not clean, reset or stage it.
- Because the live server code can differ from git, apply server fixes to the repo as a patch of the specific change. Do not copy the whole live file over the repo file.
- Git is configured with `core.autocrlf=true` here and `dashboard.js` has mixed line endings. Check `git diff --stat` is small before committing.
- The ORIGINAL server is not a git repo, so its fixes (for example Jerry's schedule and the hidden-Jerry page filter) exist only on the server. Back them up or note them.

---

## 9. Known open issues (do not "fix" these without being asked)

1. `visiontap-encodra` is still running on ORIGINAL, although Encodra was retired from the active system.
3. `visiontap-watchdog` on GROUP was seen flapping in `activating (auto-restart)`.
4. Some older handoff documents say Jerry moved to GROUP at slot 23. That is wrong for the live system: Jerry runs on ORIGINAL (slot 22). Trust the servers over old notes.
5. Passwords for some accounts were pasted into past chat. The owner should rotate them on the relevant websites.
6. Jerry's status on MAIN occasionally reads "Submission deferred (not-ready)". It appeared after the schedule fix and was not investigated; the worker itself was running.

---

## 10. When unsure

If a server's state does not match this document (different hostname, missing service, different account list), trust the server, state the difference, and ask the owner. Do not "correct" the server to match this file.
