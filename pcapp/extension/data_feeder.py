"""
data_feeder.py - VisionTap GitHub Pages data feed
-------------------------------------------------
Polls a Google Apps Script web-app URL (which reads the responses from the
Google Form's linked Sheet and returns JSON), then:
  1. Writes the rows to data/runs.json at the repo root (newest first).
  2. (Optional) git add + commit + push data/runs.json to origin/main so GitHub
     Pages can render the live tracker from that file.

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

CONFIG_PATH = Path(__file__).resolve().parent / "data_feed_config.json"

_runs = []


def load_config():
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            pass
    return {}


def fetch_rows(url):
    req = urllib.request.Request(url, headers={"User-Agent": "VisionTap/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if isinstance(data, dict) and data.get("ok"):
        return data.get("rows") or []
    if isinstance(data, list):
        return data
    raise ValueError("apps script returned unexpected shape")


def write_runs(root, rows, max_rows):
    rows = rows[:max_rows]
    path = Path(root) / "data" / "runs.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(rows, fh, indent=2)
    return rows


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
    max_rows = int(cfg.get("MAX_ROWS", 200))
    do_push = bool(cfg.get("GIT_PUSH", True))

    if not url:
        print("[feeder] no FEED_URL configured.", flush=True)
        return

    print(f"[feeder] polling {url} every {poll}s -> {root}/data/runs.json", flush=True)
    while True:
        try:
            rows = fetch_rows(url)
            written = write_runs(root, rows, max_rows)
            print(f"[feeder] wrote {len(written)} rows.", flush=True)
            if do_push:
                git_push(root)
        except Exception as e:
            print(f"[feeder] error: {e}", flush=True)
        time.sleep(poll)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[feeder] stopped.", flush=True)
