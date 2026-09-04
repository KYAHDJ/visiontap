"""
keeper.py - VisionTap local background watcher
----------------------------------------------
Listens ONLY on 127.0.0.1:8177 for heartbeat / command signals from the Chrome
extension and the external watchdog. There is NO GitHub push, NO /record, and
nothing is ever sent anywhere off this machine -- fully local by design.

Endpoints:
  GET  /health     -> status
  GET  /battery    -> real Windows battery %
  GET  /heartbeat  -> last heartbeat/progress timestamps (for the watchdog)
  POST /heartbeat  -> extension pings while the loop is running
  POST /command    -> watchdog issues a one-shot 'reset' command
  GET  /command    -> extension polls and consumes the pending command

Usage (Windows):
    python keeper.py
    (or keep alive via keeper.bat / keeper_startup.vbs)
"""

import ctypes
import json
import time
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8177

# --- External watchdog state ---
# lastHeartbeatTs/lastProgressTs: updated whenever the extension pings
# /heartbeat while the loop is running. The watchdog uses these to detect a
# >60s/2-min stall (either a dead extension, or no loop progress for too long).
# pending_command: a one-shot {command, ts} that the extension polls and
#   clears once it has acted (used for the external 'reset' signal).
lastHeartbeatTs = 0
lastProgressTs = 0
pending_command = None


def get_windows_battery_percent():
    """Return the real Windows battery percentage (0-100), or None on failure.

    Uses the Win32 SYSTEM_POWER_STATUS struct via ctypes - no extra package
    installs, instant, and 100% reliable vs. the Browser Battery Status API
    (which is blocked/unsupported in Chrome service workers).
    """
    try:
        class SYSTEM_POWER_STATUS(ctypes.Structure):
            _fields_ = [
                ("ACLineStatus", ctypes.c_byte),
                ("BatteryFlag", ctypes.c_byte),
                ("BatteryLifePercent", ctypes.c_byte),
                ("SystemStatusFlag", ctypes.c_byte),
                ("BatteryLifeTime", wintypes.DWORD),
                ("BatteryFullLifeTime", wintypes.DWORD),
            ]
        sps = SYSTEM_POWER_STATUS()
        ok = ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(sps))
        if ok and 0 <= sps.BatteryLifePercent <= 100:
            return int(sps.BatteryLifePercent)
    except Exception as e:
        print("[keeper] battery read failed:", e, flush=True)
    return None


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Tiny health check so you know the keeper is alive.
        if self.path == "/health":
            body = json.dumps({"status": "ok"}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # Real Windows battery %, fetched by the extension as a fallback when the
        # Browser Battery Status API is unavailable in the background worker.
        if self.path == "/battery":
            pct = get_windows_battery_percent()
            body = json.dumps({"battery": pct}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # Heartbeat freshness the external watchdog polls to detect a stall.
        if self.path == "/heartbeat":
            body = json.dumps({
                "lastHeartbeatTs": lastHeartbeatTs,
                "lastProgressTs": lastProgressTs,
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # Extension polls this for a one-shot command. Read = consume it, so it
        # only fires once until the watchdog issues another.
        if self.path == "/command":
            global pending_command
            cmd = pending_command
            pending_command = None
            body = json.dumps(cmd or {"command": None}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        # Heartbeat: the extension pings this while the loop is running. The
        # external watchdog reads /heartbeat to detect a >60s stall. The body
        # carries the extension's last-progress timestamp so the watchdog can
        # catch mid-task hangs, not just a dead worker.
        if self.path == "/heartbeat":
            global lastHeartbeatTs, lastProgressTs
            lastHeartbeatTs = int(time.time() * 1000)
            try:
                length = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(length)
                payload = json.loads(raw.decode("utf-8")) if length else {}
            except Exception:
                payload = {}
            if isinstance(payload, dict) and payload.get("progress"):
                lastProgressTs = int(payload["progress"])
            self._reply(200, {
                "status": "ok",
                "heartbeat": lastHeartbeatTs,
                "progress": lastProgressTs,
            })
            return

        # Command: the watchdog POSTs {command, ts}; the extension polls and
        # consumes it via GET /command.
        if self.path == "/command":
            global pending_command
            try:
                length = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(length)
                payload = json.loads(raw.decode("utf-8"))
            except Exception:
                payload = {}
            if isinstance(payload, dict) and payload.get("command"):
                pending_command = {
                    "command": str(payload["command"]),
                    "ts": payload.get("ts") or int(time.time() * 1000),
                }
                print("[keeper] pending command:", pending_command, flush=True)
            self._reply(200, {"status": "ok", "command": pending_command})
            return

        self.send_response(404)
        self.end_headers()

    def _reply(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # quiet by default
        pass


def main():
    global server
    print(f"[keeper] listening on {HOST}:{PORT}", flush=True)

    # Resilient server: if anything makes the server loop exit, restart it
    # instead of the process dying. Only a KeyboardInterrupt (or repeated
    # fatal server bind errors) will stop it.
    while True:
        try:
            server = ThreadingHTTPServer((HOST, PORT), Handler)
            server.serve_forever()
        except KeyboardInterrupt:
            print("\n[keeper] stopped.", flush=True)
            break
        except OSError as e:
            # Port already in use -> another keeper is running; keep trying
            # (do not exit the background process).
            print(f"[keeper] server bind error, retrying: {e}", flush=True)
            time.sleep(5)


server = None


if __name__ == "__main__":
    main()
