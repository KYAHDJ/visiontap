"""
data_feeder.py - VisionTap GitHub Pages data feed
--------------------------------------------------
Drives the live GitHub tracker using a session model:

  * A "session" is 250 tasks. When the ECNL work page reports
    pointsDone == pointsTotal (250 of 250), the scanner flags a reset.
  * On reset the tracker is wiped back to zero, but the latest battery and
    withdrawable carry over into the next session.
  * Every 10 *correct* tasks the scanner flags a batch push. The tracker
    "freezes" between batches, then jumps with the newest correct+incorrect
    tasks (capped at 300).

Data source = the Google Apps Script JSON feed of the form's linked Sheet.
Session state = read/written through the local scanner's /session endpoint so
there is a single writer on this machine.

Fully local. Only ever pushes the single data/runs.json file.

Usage (Windows):
    python data_feeder.py
    (launch hidden at login via data_feeder_startup.vbs / install_autostart.bat)
"""

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import requests

CONFIG_PATH = Path(__file__).resolve().parent / "data_feed_config.json"
LOCAL_SCANNER = "http://127.0.0.1:5555"


def load_config():
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            pass
    return {}


def fetch_rows(url, tries=3):
    # Use requests: it follows Apps Script's redirect to script.googleusercontent
    # reliably. Apps Script web apps have slow cold-start responses, so use a
    # generous timeout and retry a few times.
    last_err = None
    for attempt in range(tries):
        try:
            resp = requests.get(url, timeout=90)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict):
                if data.get("ok"):
                    return data.get("rows") or []
                raise ValueError("apps script responded with error: " + json.dumps(data)[:200])
            if isinstance(data, list):
                return data
            raise ValueError("apps script returned unexpected shape")
        except Exception as e:
            last_err = e
            time.sleep(5 * (attempt + 1))
    raise last_err


def get_session():
    """Fetch the current session state from the local scanner."""
    try:
        resp = requests.get(LOCAL_SCANNER + "/session", timeout=10)
        resp.raise_for_status()
        return resp.json().get("session") or {}
    except Exception as e:
        print(f"[feeder] could not read session state: {e}", flush=True)
        return {}


def post_session(action):
    try:
        resp = requests.post(LOCAL_SCANNER + "/session",
                             json={"action": action}, timeout=10)
        resp.raise_for_status()
        return resp.json().get("session") or {}
    except Exception as e:
        print(f"[feeder] session ack '{action}' failed: {e}", flush=True)
        return {}


def ts_ms(row):
    # Apps Script timestamps are ISO strings (UTC). Convert to epoch ms for
    # comparison against reset_at. Rows without a parseable timestamp default
    # to 0 (included) so they never get dropped accidentally.
    raw = row.get("timestamp")
    if not raw:
        return 0
    try:
        from datetime import datetime, timezone
        txt = str(raw).replace("Z", "+00:00").replace("z", "+00:00")
        return int(datetime.fromisoformat(txt).timestamp() * 1000)
    except Exception:
        return 0


def current_session_rows(rows, reset_at):
    if reset_at:
        return [r for r in rows if ts_ms(r) >= reset_at]
    return list(rows)


def write_runs(root, meta, rows, max_rows):
    rows = rows[:max_rows]
    payload = {"meta": meta, "runs": rows}
    path = Path(root) / "data" / "runs.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    return payload


def git_push(root):
    git = shutil.which("git") or r"C:\Program Files\Git\cmd\git.exe"
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    commands = [
        [git, "-C", root, "add", "--", "data/runs.json"],
        [git, "-C", root, "commit", "-m", "chore: update live tracker data"],
        [git, "-C", root, "pull", "--rebase", "--autostash"],
        [git, "-C", root, "push"],
    ]
    for cmd in commands:
        try:
            res = subprocess.run(cmd, capture_output=True, text=True,
                                 timeout=120, creationflags=flags)
        except subprocess.TimeoutExpired:
            print("[feeder] git timeout:", cmd, flush=True)
            return False
        if res.returncode != 0:
            err = (res.stderr or "").lower()
            if ("nothing to commit" in err or "up to date" in err
                    or "no rebase in progress" in err
                    or "couldn't find remote ref" in err
                    or "no merge to abort" in err):
                print("[feeder] git no-op / skipped:", err.strip(), flush=True)
                return True
            print("[feeder] git failed:", cmd, res.returncode, res.stderr, flush=True)
            return False
    print("[feeder] pushed data/runs.json", flush=True)
    return True


def main():
    cfg = load_config()
    if not cfg.get("ENABLED"):
        print("[feeder] disabled (ENABLED=false).", flush=True)
        return
    url = cfg.get("FEED_URL", "")
    root = cfg.get("REPO_ROOT", os.getcwd())
    poll = int(cfg.get("POLL_SECONDS", 15))
    max_rows = int(cfg.get("MAX_ROWS", 300))
    do_push = bool(cfg.get("GIT_PUSH", True))

    if not url:
        print("[feeder] no FEED_URL configured.", flush=True)
        return

    print(f"[feeder] polling {url} every {poll}s -> {root}/data/runs.json (max {max_rows})", flush=True)
    while True:
        try:
            sess = get_session()
            rows = fetch_rows(url)
            reset_requested = bool(sess.get("reset_requested"))
            batch_ready = bool(sess.get("batch_ready"))
            session = int(sess.get("session", 1))
            reset_at = sess.get("reset_at")
            battery = sess.get("last_battery")
            withdrawable = sess.get("last_withdrawable")

            if reset_requested:
                # Wipe tracker back to zero; battery/withdrawable carry over.
                meta = {
                    "session": session + 1,
                    "last_battery": battery,
                    "last_withdrawable": withdrawable,
                    "last_updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "status": "reset",
                }
                write_runs(root, meta, [], max_rows)
                if do_push:
                    git_push(root)
                post_session("reset_done")
                print(f"[feeder] SESSION {session + 1} reset. Cleared tracker (kept battery/withdrawable).", flush=True)

            elif batch_ready:
                # Jump: publish current-session correct+incorrect tasks (cap 300).
                sess_rows = current_session_rows(rows, reset_at)
                meta = {
                    "session": session,
                    "last_battery": battery,
                    "last_withdrawable": withdrawable,
                    "last_updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "status": "live",
                }
                written = write_runs(root, meta, sess_rows, max_rows)
                if do_push:
                    git_push(root)
                post_session("batch_done")
                print(f"[feeder] BATCH push: {len(written.get('runs', []))} rows (session {session}).", flush=True)

            else:
                # Freeze: no new commits while waiting for the next batch of 10 correct.
                print(f"[feeder] frozen. session={session} correct={sess.get('correct_since_reset')}/next={sess.get('next_batch')}", flush=True)
        except Exception as e:
            print(f"[feeder] error: {e}", flush=True)
        time.sleep(poll)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[feeder] stopped.", flush=True)
