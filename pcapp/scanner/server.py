import os
import sys
import base64
import json
import re
import time
import threading
import urllib.request
import urllib.parse
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

import cv2
import easyocr

PORT = 5555
SCRIPT_DIR = Path(__file__).resolve().parent
REFERENCES_DIR = (SCRIPT_DIR / ".." / ".." / "references").resolve()

ANIMAL_NAMES = ["chicken", "dog", "frog", "monkey", "pig"]
ANIMAL_WORDS = {
    "chicken": ["chicken"],
    "dog": ["dog"],
    "frog": ["frog"],
    "monkey": ["monkey", "monkeys"],
    "pig": ["pig"],
}

text_refs = {}
sprite_refs = {}
reader = None


def load_references():
    if not REFERENCES_DIR.exists():
        print(f"[ERROR] References folder not found: {REFERENCES_DIR}")
        return
    for f in REFERENCES_DIR.iterdir():
        if not f.suffix.lower() in (".png", ".jpg", ".jpeg"):
            continue
        name = f.stem.lower()
        img = cv2.imread(str(f), cv2.IMREAD_COLOR)
        if img is None:
            continue
        if "text" in name:
            text_refs[name] = img
        else:
            sprite_refs[name] = img
    print(f"[READY] Loaded {len(text_refs)} text refs, {len(sprite_refs)} sprite refs from {REFERENCES_DIR}")


def init_ocr():
    global reader
    print("[OCR] Initializing EasyOCR (first run downloads models)...")
    reader = easyocr.Reader(['en'], gpu=False, verbose=False)
    print("[OCR] Ready.")


def detect_animal_ocr(scene_bgr):
    """Read the question text via OCR and find the animal name."""
    if reader is None:
        return None, 0.0, "OCR not initialized"
    try:
        # OCR on the top text portion only (speed + accuracy)
        h, w = scene_bgr.shape[:2]
        top_region = scene_bgr[0:int(h*0.3), :]
        result = reader.readtext(top_region, detail=1, paragraph=False)
        full_text = " ".join([t for (_, t, _) in result])
        low = full_text.lower()
        for animal in ANIMAL_NAMES:
            for word in ANIMAL_WORDS[animal]:
                if re.search(r'\b' + re.escape(word) + r'\b', low):
                    return animal, 1.0, full_text
        return None, 0.0, full_text
    except Exception as e:
        return None, 0.0, f"OCR error: {e}"


# Search scales to try when matching sprites. The rendered sprite size can vary
# slightly between tasks, so we try several scales and use the best-matching one.
SCALES = [0.8, 0.9, 1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.4]
COUNT_THRESHOLD = 0.82
NMS_THRESHOLD = 0.3


def _match_at_scale(scene_bgr, template, scale, threshold):
    th, tw = template.shape[:2]
    sh, sw = scene_bgr.shape[:2]
    nth = int(round(th * scale))
    ntw = int(round(tw * scale))
    if nth < 10 or ntw < 10 or nth > sh or ntw > sw:
        return 0.0, []
    nt = cv2.resize(template, (ntw, nth), interpolation=cv2.INTER_CUBIC)
    result = cv2.matchTemplate(scene_bgr, nt, cv2.TM_CCOEFF_NORMED)
    y_idxs, x_idxs = np.where(result >= threshold)
    boxes = []
    scores = []
    for x, y in zip(x_idxs, y_idxs):
        boxes.append([int(x), int(y), int(ntw), int(nth)])
        scores.append(float(result[y, x]))
    if not boxes:
        return 0.0, []
    indices = cv2.dnn.NMSBoxes(boxes, scores, score_threshold=threshold, nms_threshold=NMS_THRESHOLD)
    n = len(indices) if len(indices) > 0 else 0
    match_score = float(max(scores)) if scores else 0.0
    return match_score, list(indices) if len(indices) > 0 else []


def count_sprites_nms(scene_bgr, template, threshold=COUNT_THRESHOLD, nms_threshold=NMS_THRESHOLD):
    """Multi-scale sprite count: find best scale, then NMS-dedupe and count.

    Never returns a count of 0 if the sprite is actually present: if the strict
    threshold finds nothing but a looser threshold still shows a clear sprite,
    we fall back so we don't report a false 0.
    """
    best_count = 0
    best_score = 0.0
    best_scale = 1.0

    # Primary pass with the strict threshold.
    for scale in SCALES:
        match_score, indices = _match_at_scale(scene_bgr, template, scale, threshold)
        if match_score > best_score:
            best_score = match_score
            best_count = len(indices)
            best_scale = scale

    # Fallback pass: if nothing matched at strict threshold but sprites are
    # clearly present at a lower threshold (>= 0.70), recover a real count so
    # we never report a false 0 for a present sprite.
    if best_count == 0:
        fallback_score = 0.0
        fallback_scale = 1.0
        fallback_count = 0
        for scale in SCALES:
            match_score, indices = _match_at_scale(scene_bgr, template, scale, 0.70)
            if match_score > fallback_score and len(indices) > 0:
                fallback_score = match_score
                fallback_count = len(indices)
                fallback_scale = scale
        if fallback_score >= 0.70 and fallback_count > 0:
            best_count = fallback_count
            best_score = fallback_score
            best_scale = fallback_scale

    return best_count, best_scale, best_score


def run_detection(image_bgr):
    h, w = image_bgr.shape[:2]
    animal, _, ocr_text = detect_animal_ocr(image_bgr)
    if not animal:
        return {
            "error": "no_animal_detected",
            "message": f"Could not read animal from text ({ocr_text[:60]})",
            "ocr_text": ocr_text[:120],
            "image_size": f"{w}x{h}"
        }
    sprite_key = animal
    template = sprite_refs.get(sprite_key)
    if template is None:
        return {
            "error": "no_sprite_ref",
            "message": f"No sprite reference for {sprite_key}",
            "image_size": f"{w}x{h}"
        }
    count, used_scale, match_score = count_sprites_nms(image_bgr, template)
    return {
        "animal": animal,
        "count": count,
        "ocr_text": ocr_text[:120],
        "scale": used_scale,
        "sprite_score": round(match_score, 3),
        "image_size": f"{w}x{h}"
    }


# ---------------------------------------------------------------------------
# Google Form reporter
# ---------------------------------------------------------------------------
CONFIG_PATH = SCRIPT_DIR / "gform_config.json"


def load_gform_config():
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            pass
    return None


def push_report_to_form(report):
    """Best-effort: forwards one task report to the Google Form as a response.
    Runs on a background thread so it never blocks the /detect server.
    """
    cfg = load_gform_config()
    if not cfg:
        return
    if not cfg.get("ENABLED", False):
        print(f"[report] disabled (ENABLED=false); skipping form push.", flush=True)
        return
    url = cfg.get("FORM_RESPONSE_URL", "")
    entry_ids = cfg.get("ENTRY_IDS", {})
    if not url or not entry_ids:
        print("[report] config incomplete; skipping form push.", flush=True)
        return

    fields = {
        "battery": report.get("battery"),
        "animal": report.get("animal"),
        "count": report.get("count"),
        "correct": ("TRUE" if report.get("correct") is True
                    else "FALSE" if report.get("correct") is False else None),
        "totalSec": report.get("totalSec"),
        "withdrawable": report.get("withdrawable"),
    }

    data = {}
    for key, entry in entry_ids.items():
        if key in fields and fields[key] is not None:
            data[entry] = str(fields[key])

    if not data:
        print("[report] no fields mapped; skipping form push.", flush=True)
        return

    payload = urllib.parse.urlencode(data).encode("utf-8")
    try:
        req = urllib.request.Request(url, data=payload, method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("User-Agent",
                       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) VisionTap/1.0")
        with urllib.request.urlopen(req, timeout=15) as resp:
            print(f"[report] pushed to form (HTTP {resp.getcode()}).", flush=True)
    except Exception as e:
        print(f"[report] form push failed: {e}", flush=True)


def queue_report(report):
    threading.Thread(target=push_report_to_form, args=(report,), daemon=True).start()


class ScannerHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self._json_response(200, {
                "status": "ok",
                "refs": len(text_refs) + len(sprite_refs),
                "ocr": reader is not None
            })
        else:
            self._json_response(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/detect":
            self._handle_detect()
        elif self.path == "/report":
            self._handle_report()
        else:
            self._json_response(404, {"error": "not found"})

    def _handle_report(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            report = json.loads(body)
            queue_report(report)
            self._json_response(200, {"status": "queued"})
        except Exception as e:
            self._json_response(500, {"error": "server_error", "message": str(e)})

    def _handle_detect(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            data = json.loads(body)
            img_b64 = data.get("image", "")
            if not img_b64:
                self._json_response(400, {"error": "no_image", "message": "No image data in request"})
                return
            if "," in img_b64:
                img_b64 = img_b64.split(",", 1)[1]
            img_bytes = base64.b64decode(img_b64)
            np_arr = np.frombuffer(img_bytes, np.uint8)
            img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
            if img is None:
                self._json_response(400, {
                    "error": "bad_image",
                    "message": f"Could not decode image ({len(img_bytes)} bytes)"
                })
                return
            debug_dir = SCRIPT_DIR / "debug"
            debug_dir.mkdir(exist_ok=True)
            cv2.imwrite(str(debug_dir / "last_detect.png"), img)
            result = run_detection(img)
            self._json_response(200, result)
        except Exception as e:
            self._json_response(500, {"error": "server_error", "message": str(e)})

    def _json_response(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format, *args):
        pass


def main():
    load_references()
    init_ocr()
    server = HTTPServer(("127.0.0.1", PORT), ScannerHandler)
    print(f"[SCANNER] Listening on http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[SCANNER] Stopped.")
        server.server_close()


if __name__ == "__main__":
    main()
