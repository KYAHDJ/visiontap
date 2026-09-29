# VisionTap Chrome Pilots

Chrome-only Oracle automation for five isolated accounts: Kyaiko (PMath), adaihbi, Temi, Axceling1001, and Darlenejoyce. Each account has its own persistent Chrome profile, systemd service, recovery watchdog, dashboard state, and manual-verification hold.

## Runtime

- VNC: port `1919`, display `:1`, `2560x1024`
- Dashboard: port `6260`
- Scanner: localhost port `5566`
- Time zone: `Asia/Manila`
- Chrome workers: `visiontap-chrome@{kyaiko,adaihbi,temi,axceling1001,darlenejoyce}`

The five windows are forced into equal non-overlapping columns. Manual verification is never clicked automatically; the affected dashboard card is covered until the user verifies it, while other workers continue.

## Install and test

```bash
cd slotbrowser
npm ci
npm test
```

`visiontap-chrome@.service` loads one `chrome-ACCOUNT.env` file per worker. `start_all.sh` restarts the complete Chrome stack. Private credentials, Chrome profiles, payout configuration, counters, and runtime state remain outside Git under the Oracle user's configuration directories.

The former Electron implementation is preserved on the GitHub `master` branch. The `main` branch is Chrome-only.
