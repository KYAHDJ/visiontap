# VisionTap — Contabo ECNL system

This branch is the clean deployment source for the live Contabo ECNL system. It contains the five Chrome workers, scanner, responsive dashboard, grouped public views, private admin controls, virtual display, VNC/noVNC viewer, startup services, and watchdog.

It intentionally contains no ECNL passwords, Chrome cookies/profiles, SSH keys, payout recipient details, runtime state, or live admin password. Those values stay private on the server.

## Accounts and timing

| Account | Day | Submit delay |
| --- | --- | ---: |
| danicajgb | Monday | 3.9 seconds |
| nnnikkikim | Tuesday | 4.1 seconds |
| darlenejoyce | Wednesday | 4.0 seconds |
| DearTheodosia | Thursday | instant |
| AaronBurr | Friday | 0.3 seconds |

Automatic cash-out runs only on the assigned weekday from 8:00–9:00 AM Philippine time and only when the eligible balance is at least ₱300. Recipient details are stored in private server state, not Git.

## Dashboard views

- `/` or `/?group=danica-niki` — Danica and Nikki
- `/?group=darlene` — Darlene
- `/?group=theodosia-aaron` — Theodosia and Aaron

The dashboard is public and view-only by default. **Admin sign in** reveals Pause, Resume, Restart, and Refresh. Group controls affect only the accounts shown in the current view.

## Layout

- `slotbrowser/` — Chrome automation, cash-out workflow, page injection, and dashboard
- `pcapp/scanner/` — image/color scanner API
- `config/` — five non-secret worker configurations and slot layout
- `visiontap-*.service` — systemd units
- `watchdog.sh` — service recovery loop
- `visiontap-accounts-viewer` — responsive local noVNC viewer
- `setup_server.sh` — installs this checkout on an Ubuntu Contabo server

## Install

Use Ubuntu 24.04 with a user named `opc`, Google Chrome installed at `/opt/google/chrome/chrome`, and this repository checked out at `/home/opc/VisionTap`.

```bash
cd /home/opc/VisionTap
sudo bash setup_server.sh
```

Then create the private admin configuration:

```bash
sudo -u opc mkdir -p /home/opc/.config/VisionTap-Dashboard
sudo -u opc cp config/dashboard-admin.env.example /home/opc/.config/VisionTap-Dashboard/admin.env
sudo -u opc chmod 600 /home/opc/.config/VisionTap-Dashboard/admin.env
```

Replace the example password, add each account’s private Chrome session/login, and store cash-out recipient settings privately on the server. Restart the dashboard after changing its password.

