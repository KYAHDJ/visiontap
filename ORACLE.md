# Oracle deployment

Repository: `/home/opc/VisionTap`
Display: `:1` at `2560x1024`
VNC: `140.245.49.233:1919`
Dashboard: `http://140.245.49.233:6260`

## Services

```text
visiontap-xvfb
visiontap-openbox
visiontap-vnc
visiontap-scanner
visiontap-dashboard
visiontap-chrome@kyaiko
visiontap-chrome@adaihbi
visiontap-chrome@temi
visiontap-chrome@axceling1001
visiontap-chrome@darlenejoyce
visiontap-watchdog
```

All services are enabled for startup. Electron is not installed as a VisionTap service and must remain disabled.

## Deploy

```bash
cd /home/opc/VisionTap
git pull --ff-only origin main
npm --prefix slotbrowser ci --omit=dev
sudo install -m 0644 visiontap-chrome@.service /etc/systemd/system/
sudo install -m 0644 visiontap-{xvfb,openbox,vnc,scanner,dashboard,watchdog}.service /etc/systemd/system/
for account in kyaiko adaihbi temi axceling1001 darlenejoyce; do
  install -m 0600 "chrome-$account.env" "$HOME/.config/VisionTap-Chrome/$account.env"
done
sudo systemctl daemon-reload
./start_all.sh
```

## Health checks

```bash
curl -s http://127.0.0.1:5566/health
curl -s http://127.0.0.1:6260/api/stats
systemctl is-active 'visiontap-chrome@*'
```

Profiles live under `~/.config/VisionTap-Chrome/ACCOUNT`. Shared private state remains under `~/.config/VisionTap Slots/state`. Never commit either directory.
