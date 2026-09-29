# Chrome-only server setup

Run `setup_server.sh`, install Google Chrome at `/opt/google/chrome/chrome`, install the repository service units, copy the five non-secret account environment files to `~/.config/VisionTap-Chrome`, and run `start_all.sh`.

Open ports `1919/tcp` for VNC and `6260/tcp` for the dashboard. Scanner port `5566` should remain local. The host time zone and application schedulers use `Asia/Manila`.

The GitHub `master` branch preserves the retired Electron application. Do not enable `visiontap-electron` on the Chrome-only `main` deployment.
