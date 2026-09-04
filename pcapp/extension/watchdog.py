"""
watchdog.py - VisionTap external 1-minute watch tower
------------------------------------------------------
Runs alongside pcapp/keeper.py on the real desktop. It watches the keeper's
heartbeat: the Chrome extension pings the keeper every few seconds while the
loop is running. If no heartbeat arrives for >60s, the loop is stuck (stuck on
a page, hung, or died), so the watchdog issues a one-shot "reset" command to
the keeper. The extension polls /command and performs a full self-reset:
stop -> clear -> reload ALL tabs (ECNL + Gemini) -> restart from step 1.

This is a fully-local design: nothing is sent off this machine. The keeper
only handles heartbeat/command; no run data is pushed anywhere.

Usage (Windows):
    python pcapp/watchdog.py [--timeout 60] [--interval 5]
    (or double-click pcapp/watchdog.bat)
"""

import argparse
import json
import time
import urllib.request

DEFAULT_KEEPER = "http://127.0.0.1:8177"


def fetch(url, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def post(url, payload, timeout=5):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    ap = argparse.ArgumentParser(description="VisionTap external watchdog")
    ap.add_argument("--base", default=DEFAULT_KEEPER)
    ap.add_argument("--timeout", type=int, default=120000, help="stall threshold in ms (final 2-min failsafe)")
    ap.add_argument("--interval", type=float, default=5.0, help="poll interval in seconds")
    args = ap.parse_args()

    heartbeat_url = args.base.rstrip("/") + "/heartbeat"
    command_url = args.base.rstrip("/") + "/command"

    print(f"[watchdog] watching {heartbeat_url} (timeout {args.timeout}ms)", flush=True)
    while True:
        alive = False
        try:
            info = fetch(heartbeat_url)
            last_progress = info.get("lastProgressTs") or 0
            age = int(time.time() * 1000) - last_progress if last_progress else None
            if age is None:
                print("[watchdog] no progress timestamp yet (loop not progressed lately).", flush=True)
            elif age <= args.timeout:
                alive = True
            else:
                print(f"[watchdog] STALLED: no progress for {age}ms (>{args.timeout}ms).", flush=True)
        except Exception as e:
            print("[watchdog] keeper unreachable:", e, flush=True)

        if not alive:
            try:
                out = post(command_url, {"command": "reset", "ts": int(time.time() * 1000)})
                print("[watchdog] issued reset command to keeper.", flush=True)
            except Exception as e:
                print("[watchdog] failed to issue reset:", e, flush=True)

        time.sleep(max(args.interval, 1.0))


def _run():
    # Resilience: if the watchdog loop dies for any reason, restart the loop
    # instead of the background process exiting. Only Ctrl+C stops it.
    try:
        main()
    except KeyboardInterrupt:
        print("\n[watchdog] stopped.", flush=True)
    except Exception as e:
        print(f"[watchdog] watchdog loop crashed ({e!r}); restarting in 5s.", flush=True)
        time.sleep(5)
        _run()


if __name__ == "__main__":
    _run()