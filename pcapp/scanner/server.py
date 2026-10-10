import base64
import json
import re
import os
import time
import threading
import hashlib
from collections import OrderedDict, deque
# Small task images do not benefit from competing OpenMP/BLAS thread pools.
os.environ.setdefault('OMP_THREAD_LIMIT', '1')
os.environ.setdefault('OPENBLAS_NUM_THREADS', '1')
import numpy as np
import cv2
from flask import Flask, request, jsonify, g
from flask_cors import CORS

try:
    import pytesseract
    # Auto-detect tesseract per OS to never break again (Windows vs Linux Oracle)
    import shutil
    win_path = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    if os.name == "nt" and os.path.exists(win_path):
        pytesseract.pytesseract.tesseract_cmd = win_path
    elif shutil.which("tesseract"):
        pytesseract.pytesseract.tesseract_cmd = shutil.which("tesseract")
    # Verify
    v = pytesseract.get_tesseract_version()
    print(f"[TESSERACT OK] {v} cmd={pytesseract.pytesseract.tesseract_cmd}")
    reader = True
except Exception as e:
    print(f"[TESSERACT FAIL] {e} – scanner will reject but not crash")
    reader = None

# Startup self-check: ensure slots taskMode integrity helper
def ensure_pmath_slot_integrity():
    try:
        # This is for slotbrowser state, not scanner, but log hint
        pass
    except: pass

app = Flask(__name__)
CORS(app)

# PayMath can require several Tesseract reads for one image.  Never allow
# abandoned/timed-out browser requests to create an unbounded OCR backlog.
MATH_OCR_LOCK = threading.Lock()
TESSERACT_PROCESS_LOCK = threading.Lock()
OCR_PROCESS_TIMEOUT = float(os.environ.get('VT_OCR_TIMEOUT', '2'))
OCR_QUEUE = deque()
OCR_CONDITION = threading.Condition()
RESULT_CACHE = OrderedDict()
RESULT_CACHE_LOCK = threading.Lock()
GLYPH_CACHE = OrderedDict()
GLYPH_CACHE_LOCK = threading.Lock()
STATS_LOCK = threading.RLock()
cv2.setNumThreads(1)

class ScannerBusy(Exception):
    pass

@app.errorhandler(ScannerBusy)
def scanner_busy(error):
    return jsonify(error=str(error), retryable=True), 503

def bounded_ocr(image, config):
    """Run at most one Tesseract child at a time and never leave it unbounded."""
    cache_key = None
    if isinstance(image, np.ndarray):
        cache_key = (str(image.shape), config, hashlib.sha256(image.tobytes()).hexdigest())
        with GLYPH_CACHE_LOCK:
            if cache_key in GLYPH_CACHE:
                GLYPH_CACHE.move_to_end(cache_key)
                return GLYPH_CACHE[cache_key]
    ticket = object()
    deadline = time.monotonic() + 8
    with OCR_CONDITION:
        if len(OCR_QUEUE) >= 8:
            raise ScannerBusy('Scanner busy; queue full')
        OCR_QUEUE.append(ticket)
        while OCR_QUEUE[0] is not ticket:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                OCR_QUEUE.remove(ticket)
                OCR_CONDITION.notify_all()
                raise ScannerBusy('Scanner busy; queue deadline')
            OCR_CONDITION.wait(remaining)
    try:
        try:
            text = pytesseract.image_to_string(image, config=config, timeout=OCR_PROCESS_TIMEOUT).strip()
            if cache_key and text:
                with GLYPH_CACHE_LOCK:
                    GLYPH_CACHE[cache_key] = text
                    GLYPH_CACHE.move_to_end(cache_key)
                    while len(GLYPH_CACHE) > 1024:
                        GLYPH_CACHE.popitem(last=False)
            return text
        except RuntimeError as error:
            if 'timeout' in str(error).lower():
                raise ScannerBusy('Scanner busy; OCR timeout') from error
            raise
    finally:
        with OCR_CONDITION:
            OCR_QUEUE.popleft()
            OCR_CONDITION.notify_all()

@app.before_request
def prepare_request():
    if request.endpoint in ('report', 'stats', 'earnings'):
        STATS_LOCK.acquire()
        g.stats_lock_held = True
    if request.endpoint not in ('detect', 'solve_math'):
        return None
    data = request.get_json(silent=True) or {}
    payload = data.get('image')
    if not isinstance(payload, str):
        return None
    g.scan_started = time.monotonic()
    g.cache_key = (request.endpoint, hashlib.sha256(payload.encode()).hexdigest(), str(data.get('target_num')))
    with RESULT_CACHE_LOCK:
        cached = RESULT_CACHE.get(g.cache_key)
        if cached and time.monotonic() - cached[0] < 120:
            RESULT_CACHE.move_to_end(g.cache_key)
            return jsonify(cached[1])

@app.after_request
def remember_result(response):
    if hasattr(g, 'cache_key') and response.status_code == 200:
        with RESULT_CACHE_LOCK:
            RESULT_CACHE[g.cache_key] = (time.monotonic(), response.get_json())
            RESULT_CACHE.move_to_end(g.cache_key)
            while len(RESULT_CACHE) > 128:
                RESULT_CACHE.popitem(last=False)
    if hasattr(g, 'scan_started'):
        response.headers['Server-Timing'] = 'scan;dur=%.1f' % ((time.monotonic() - g.scan_started) * 1000)
    return response

@app.teardown_request
def release_stats_lock(_error):
    if getattr(g, 'stats_lock_held', False):
        g.stats_lock_held = False
        STATS_LOCK.release()

@app.before_request
def acquire_math_ocr_slot():
    if request.endpoint != 'solve_math':
        return None
    if not MATH_OCR_LOCK.acquire(blocking=False):
        return jsonify({"error": "Math scanner busy; retry shortly"}), 429
    g.math_ocr_lock_held = True
    return None

@app.teardown_request
def release_math_ocr_slot(_error):
    if getattr(g, 'math_ocr_lock_held', False):
        g.math_ocr_lock_held = False
        MATH_OCR_LOCK.release()

DEBUG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "debug")
os.makedirs(DEBUG_DIR, exist_ok=True)

# Strict HSV Boundaries for High-Contrast ECNL Emoji Asset Kit
COLOR_RANGES = {
    "red": [((0, 160, 140), (8, 255, 255)), ((171, 160, 140), (180, 255, 255))],
    "pink": [((162, 70, 160), (170, 255, 255)), ((145, 80, 180), (161, 255, 255))],
    "orange": [((9, 160, 160), (22, 255, 255))],
    "yellow": [((23, 130, 160), (35, 255, 255))],
    "green": [((36, 100, 100), (85, 255, 255))],
    "blue": [((86, 110, 100), (128, 255, 255))],
    "purple": [((129, 110, 100), (144, 255, 255))],
    "brown": [((8, 50, 20), (22, 210, 140))],
    "white": [((0, 0, 205), (180, 25, 255))],
    "gray": [((0, 0, 75), (180, 35, 200))],
    "black": [((0, 0, 0), (180, 255, 45))]
}

def ocr_read_badge_number(img):
    """Isolates the blue prompt badge box and reads the exact integer N."""
    if not reader:
        return None

    height, width, _ = img.shape
    bottom_crop = img[int(height * 0.60):height, 0:width]
    
    hsv_bottom = cv2.cvtColor(bottom_crop, cv2.COLOR_BGR2HSV)
    lower_badge = np.array([85, 30, 50])
    upper_badge = np.array([135, 255, 220])
    badge_mask = cv2.inRange(hsv_bottom, lower_badge, upper_badge)

    contours, _ = cv2.findContours(badge_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    target_crop = bottom_crop
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if 18 <= h <= 60 and 18 <= w <= 120:
            pad = 4
            x1, y1 = max(0, x - pad), max(0, y - pad)
            x2, y2 = min(width, x + w + pad), min(bottom_crop.shape[0], y + h + pad)
            target_crop = bottom_crop[y1:y2, x1:x2]
            break

    gray = cv2.cvtColor(target_crop, cv2.COLOR_BGR2GRAY)

    # White text on gray bg -> threshold to isolate white, invert for black-on-white
    mask = np.where(gray > 180, 255, 0).astype(np.uint8)
    inv = cv2.bitwise_not(mask)
    scaled = cv2.resize(inv, None, fx=4.0, fy=4.0, interpolation=cv2.INTER_CUBIC)

    try:
        text = bounded_ocr(scaled, '--psm 7 -c tessedit_char_whitelist=0123456789')
        digits = re.findall(r'\b([1-9]|[12][0-9]|3[0-6])\b', text)
        if digits:
            return int(digits[0])
    except ScannerBusy:
        raise
    except Exception as e:
        print(f" -> [OCR Error]: {e}")

    return None

def detect_color_from_sample(sample_hsv):
    """Classifies HSV median sample strictly against ECNL's color palettes."""
    med_h = np.median(sample_hsv[:, :, 0])
    med_s = np.median(sample_hsv[:, :, 1])
    med_v = np.median(sample_hsv[:, :, 2])

    print(f" -> Sample Pixel HSV: Hue={med_h:.1f}, Sat={med_s:.1f}, Val={med_v:.1f}")

    # Achromatic checks (Black, White, Gray)
    if med_v < 45:
        return "black"
    if med_s < 30:
        if med_v > 200:
            return "white"
        elif med_v >= 70:
            return "gray"
        else:
            return "black"

    # Strict Brown Check (Mid saturation/value in red-orange hue)
    if 8 <= med_h <= 22 and med_s < 210 and med_v < 150:
        return "brown"

    # Chromatic Range Matching
    for color_name, ranges in COLOR_RANGES.items():
        if color_name in ["white", "black", "gray", "brown"]:
            continue
        for (lower, upper) in ranges:
            if lower[0] <= med_h <= upper[0] and lower[1] <= med_s <= upper[1] and lower[2] <= med_v <= upper[2]:
                # Normalize 'pink' to 'purple' or 'red' if site expects standard color names
                return "pink" if color_name == "pink" else color_name

    return "unknown"

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "online"})

@app.route('/detect', methods=['POST'])
def detect():
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({"error": "No image payload"}), 400

        img_data = data['image']
        if ',' in img_data:
            img_data = img_data.split(',')[1]
        
        img_bytes = base64.b64decode(img_data)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img is None:
            return jsonify({"error": "Failed to decode image"}), 400

        timestamp = int(time.time())
        height, width, _ = img.shape
        hsv_img = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

        # 1. Strict Target Number Extraction
        N = data.get('target_num')
        if not N or int(N) <= 0 or int(N) > 36:
            N = ocr_read_badge_number(img)

        if not N or int(N) < 1 or int(N) > 36:
            print("[SERVER REJECT] Unverified target number.")
            return jsonify({"error": "Unverified target number"}), 400

        N = int(N)

        # 2. Grid Coordinates (3 rows x 12 cols = 36 cells)
        margin_x = width * 0.05
        grid_width = width * 0.90
        margin_y = height * 0.05
        grid_height = height * 0.53

        cell_w = grid_width / 12.0
        cell_h = grid_height / 3.0

        # 3. First: read the TARGET cell to find the color we're counting
        target_index = N - 1
        target_row = target_index // 12
        target_col = target_index % 12

        # Cell boundaries (inner 50% to avoid edge blending)
        cell_x1 = margin_x + target_col * cell_w
        cell_y1 = margin_y + target_row * cell_h
        cell_x2 = cell_x1 + cell_w
        cell_y2 = cell_y1 + cell_h

        inner_pad_x = cell_w * 0.25
        inner_pad_y = cell_h * 0.25
        ix1 = int(max(0, cell_x1 + inner_pad_x))
        iy1 = int(max(0, cell_y1 + inner_pad_y))
        ix2 = int(min(width, cell_x2 - inner_pad_x))
        iy2 = int(min(height, cell_y2 - inner_pad_y))

        cell_region = hsv_img[iy1:iy2, ix1:ix2]

        if cell_region.size == 0:
            print("[SERVER REJECT] Empty cell region.")
            return jsonify({"error": "Empty cell region"}), 400

        # Sample 9 points in a 3x3 grid across the inner cell, classify each, majority vote
        rh, rw = cell_region.shape[:2]
        sample_points = []
        for sy in [0.2, 0.5, 0.8]:
            for sx in [0.2, 0.5, 0.8]:
                py = int(sy * rh)
                px = int(sx * rw)
                sample_points.append(cell_region[py:py+1, px:px+1])

        votes = {}
        vote_details = []
        for sp in sample_points:
            c = detect_color_from_sample(sp)
            votes[c] = votes.get(c, 0) + 1
            vote_details.append(c)

        sorted_votes = sorted(votes.items(), key=lambda x: -x[1])
        best_color, best_count = sorted_votes[0]
        purity = best_count / len(sample_points)

        print(f" -> Cell votes: {votes} | purity={purity:.0%} best={best_color}")

        if purity < 0.5 or best_color == "unknown":
            print(f"[SERVER REJECT] Low purity ({purity:.0%}) or inconclusive.")
            return jsonify({"error": f"Low purity ({purity:.0%}) or inconclusive"}), 400

        detected_color = best_color

        if detected_color == "unknown":
            print("[SERVER REJECT] Inconclusive color range.")
            return jsonify({"error": "Color detection inconclusive"}), 400

        print(f"\n==========================================")
        print(f"[STRICT DETECT SUCCESS] Target N={N} | Cell: Row {target_row+1}, Col {target_col+1}")
        print(f" -> DETECTED COLOR: [{detected_color.upper()}]")
        print(f"==========================================\n")

        return jsonify({
            "color": detected_color,
            "target_num": N,
            "cell": {"row": target_row, "col": target_col}
        })

    except ScannerBusy:
        raise
    except Exception as e:
        print(f"[EXCEPT] {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/solve_math', methods=['POST'])
def solve_math():
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({"error": "No image payload"}), 400
        img_data = data['image']
        if ',' in img_data:
            img_data = img_data.split(',')[1]
        img_bytes = base64.b64decode(img_data)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return jsonify({"error": "Failed to decode image"}), 400
        # Local patched: BW all color -> black, contour per-symbol (fast, 8/8 on TASK)
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        lower_white = np.array([0, 0, 150])
        upper_white = np.array([180, 80, 255])
        mask_white = cv2.inRange(hsv, lower_white, upper_white)
        # Contour per-symbol OCR — robust to empty gaps and thin dash
        contours, _ = cv2.findContours(mask_white, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        rects = [cv2.boundingRect(c) for c in contours if cv2.contourArea(c) > 30]
        rects = sorted(rects, key=lambda r: r[0])
        symbols = []
        for x, y, w, h in rects:
            crop = mask_white[y:y+h, x:x+w]
            white = int((crop == 255).sum())
            roi = mask_white[max(0, y-4):y+h+4, max(0, x-4):x+w+4]
            inv = cv2.bitwise_not(roi)
            kernel = np.ones((2, 2), np.uint8)
            if h < 10:  # thin dash needs dilation
                inv = cv2.dilate(inv, kernel, iterations=1)
            padded = cv2.copyMakeBorder(inv, 8, 8, 8, 8, cv2.BORDER_CONSTANT, value=255)
            scaled = cv2.resize(padded, None, fx=4.0, fy=4.0, interpolation=cv2.INTER_CUBIC)
            cfg_digit = '--psm 8 -c tessedit_char_whitelist=0123456789'
            cfg_op = '--psm 8 -c tessedit_char_whitelist=-+xX'
            is_square_op = abs(w - h) < 15 and w > 20 and h > 20 and 150 < white < 500
            if h < 10:
                txt = '-'
            elif is_square_op:
                txt_op = bounded_ocr(scaled, cfg_op)
                low = txt_op.lower()
                if 'x' in low:
                    txt = 'x'
                elif '+' in txt_op:
                    txt = '+'
                else:
                    txt = '+' if white < 300 else 'x'
                if txt == '+' and white > 320:
                    txt = 'x'
                if txt == 'x' and white < 280:
                    txt = '+'
            else:
                txt_digit = bounded_ocr(scaled, cfg_digit)
                if not re.fullmatch(r'[0-9]', txt_digit):
                    txt_digit = bounded_ocr(scaled, '--psm 10 -c tessedit_char_whitelist=0123456789')
                if not re.fullmatch(r'[0-9]', txt_digit):
                    smaller = cv2.resize(padded, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_LINEAR)
                    alternate = bounded_ocr(smaller, '--psm 10 -c tessedit_char_whitelist=0123456789')
                    linear = cv2.resize(padded, None, fx=4.0, fy=4.0, interpolation=cv2.INTER_LINEAR)
                    corroboration = bounded_ocr(linear, '--psm 13 -c tessedit_char_whitelist=0123456789')
                    if alternate == corroboration and re.fullmatch(r'[0-9]', alternate):
                        txt_digit = alternate
                txt = txt_digit if re.fullmatch(r'[0-9]', txt_digit) else '?'
            symbols.append((x, txt))
        expr = ''.join(t for _, t in sorted(symbols))
        print(f"[MATH OCR contour] '{expr}' from {len(rects)} symbols")
        if not re.fullmatch(r'\d{1,5}[+\-xX*/]\d{1,5}', expr):
            cv2.imwrite(os.path.join(DEBUG_DIR, 'math_unreadable_latest.png'), img)
            return jsonify({"error": "Incomplete or ambiguous equation"}), 400
        cleaned = re.sub(r'[^0-9+\-xX*/]', '', expr)
        cleaned = cleaned.replace('x', '*').replace('X', '*')
        m = re.search(r'(\d{1,5})\s*([+\-*/])\s*(\d{1,5})', cleaned)
        text = expr
        if not m:
            m2 = re.search(r'(\d+)\s*([+\-xX*/])\s*(\d+)', text)
            if m2:
                a, op, b = m2.groups()
                op = op.replace('x', '*').replace('X', '*')
                cleaned = f"{a}{op}{b}"
                m = re.search(r'(\d+)([+\-*/])(\d+)', cleaned)
        if not m:
            return jsonify({"error": f"Could not parse math: '{text}' cleaned '{cleaned}'"}), 400
        a_str, op, b_str = m.groups()
        try:
            a = int(a_str); b = int(b_str)
        except:
            return jsonify({"error": f"Invalid numbers: {a_str}, {b_str}"}), 400
        if op == '+': ans = a + b
        elif op == '-': ans = a - b
        elif op == '*': ans = a * b
        elif op == '/': ans = a // b if b != 0 else 0
        else: ans = 0
        ans = abs(ans)  # always positive
        if ans == 0:
            ans = 1  # avoid 0 per requirement, never return "0"
        print(f"[MATH SOLVED] {a} {op} {b} = {ans} (from '{text}')")
        return jsonify({"answer": str(ans), "expression": f"{a}{op}{b}", "raw": text, "cleaned": cleaned})
    except ScannerBusy:
        raise
    except Exception as e:
        print(f"[MATH EXCEPT] {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/debug_detect', methods=['POST'])
def debug_detect():
    """Debug endpoint: saves input image, runs detection with full debug output, returns debug info."""
    try:
        data = request.get_json()
        img_data = data['image']
        if ',' in img_data:
            img_data = img_data.split(',')[1]
        img_bytes = base64.b64decode(img_data)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return jsonify({"error": "Failed to decode"}), 400

        h, w = img.shape[:2]
        print(f"\n[DEBUG] Input image: {w}x{h}")
        cv2.imwrite("debug_input.png", img)

        # Run full detection
        header_text = ocr_read_header(img)
        print(f"[DEBUG] Header OCR: '{header_text}'")

        # Count blobs
        count, conf = count_blobs_binary(img)
        print(f"[DEBUG] Blob count: {count}, confidence: {conf}")

        return jsonify({
            "answer": str(count),
            "confidence": conf,
            "type": "debug",
            "image_size": f"{w}x{h}",
            "header": header_text
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

STATS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scanner_stats.json")
EARNINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "earnings_history.json")

@app.route('/report', methods=['POST'])
def report():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "No data"}), 400
        existing = {}
        try:
            with open(STATS_FILE, 'r') as f:
                existing = json.load(f)
        except Exception:
            pass
        slot = data.get('slot', 'default')
        if 'slots' not in existing:
            existing['slots'] = {}
        s = existing['slots'].get(slot, {
            'pointsDone': 0, 'pointsTotal': 0, 'withdrawable': 0,
            'taskCount': 0, 'correctCount': 0, 'wrongCount': 0, 'errorCount': 0
        })
        old_withdrawable = s.get('withdrawable', 0) or 0
        old_pointsDone = s.get('pointsDone', 0) or 0
        if data.get('countMode') == 'observed-points':
            new_points = data.get('pointsDone')
            if s.get('countMode') != 'observed-points':
                s['correctCount'] = 0
                s['wrongCount'] = None
                s['countMode'] = 'observed-points'
                s['confirmationStartedAt'] = int(time.time())
            elif new_points is not None:
                delta = int(new_points) - int(old_pointsDone)
                if data.get('platform') != 'math' and int(old_pointsDone) >= 230 and int(new_points) <= 20 and float(data.get('withdrawable') or 0) > old_withdrawable:
                    delta = 250 - int(old_pointsDone) + int(new_points)
                if 0 < delta <= 20:
                    s['correctCount'] = int(s.get('correctCount') or 0) + delta

        if data.get('pointsDone') is not None:
            try: s['pointsDone'] = int(data['pointsDone'])
            except: pass
        if data.get('pointsTotal') is not None:
            try: s['pointsTotal'] = int(data['pointsTotal'])
            except: pass
        if data.get('withdrawable') is not None:
            try: s['withdrawable'] = float(data['withdrawable'])
            except: pass
        if data.get('timerText') is not None:
            try: s['timerText'] = str(data['timerText'])
            except: pass
        if data.get('elapsed') is not None:
            try: s['elapsed'] = int(data['elapsed'])
            except: pass
        if data.get('loopStartTime') is not None:
            try: s['loopStartTime'] = int(data['loopStartTime'])
            except: pass
        if data.get('taskCount') is not None:
            try: s['taskCount'] = int(data['taskCount'])
            except: pass
        if data.get('correctCount') is not None:
            try: s['correctCount'] = int(data['correctCount'])
            except: pass
        if data.get('wrongCount') is not None:
            try: s['wrongCount'] = int(data['wrongCount'])
            except: pass
        if data.get('errorCount') is not None:
            try: s['errorCount'] = int(data['errorCount'])
            except: pass
        if data.get('correct') is not None:
            s['lastCorrect'] = bool(data['correct'])
        # New cycle: points 200+ -> 0-10 means new 250 cycle, show current not old compiled (user wants 4/250 not 195)
        if data.get('pointsDone') is not None:
            try:
                new_pd = int(data['pointsDone'])
                if data.get('countMode') != 'observed-points' and ((old_pointsDone >= 100 and 0 <= new_pd <= 10) or (old_pointsDone >= 150 and 0 <= new_pd <= 20) or (old_pointsDone >= 50 and new_pd == 0)):
                    # Reset to current cycle counts (data's counts should be small, but if data still has old large, reset to 0)
                    s['taskCount'] = 0
                    s['correctCount'] = 0
                    s['wrongCount'] = 0
                    s['errorCount'] = 0
                    if s.get('pointsTotal', 0) == 0:
                        s['pointsTotal'] = 250
                    print(f"[RESET] Slot {slot} new cycle {old_pointsDone}->{new_pd}, reset current counts")
            except:
                pass
        # Ensure pointsTotal is 250 if we have pointsDone but total is 0 (new cycle 0/0 case)
        if s.get('pointsTotal', 0) == 0 and s.get('pointsDone', 0) != 0:
            s['pointsTotal'] = 250
        if s.get('pointsDone', 0) == 0 and s.get('pointsTotal', 0) == 0:
            # New cycle start, show 0/250 not 0/0
            s['pointsTotal'] = 250
        s['lastUpdate'] = time.strftime('%H:%M:%S')
        # Hourly points history for dashboard - keep last 24 hours
        if 'pointsHistory' not in s:
            s['pointsHistory'] = []
        # Record every point change, every hour, and every 10 min even if stuck (for 1h/3h history)
        now_hour = int(time.time() // 3600)
        now_ts = int(time.time())
        last_hist = s['pointsHistory'][-1] if s['pointsHistory'] else None
        should_record = False
        if not s['pointsHistory']:
            should_record = True
        elif last_hist and last_hist.get('hour') != now_hour:
            should_record = True
        elif last_hist and now_ts - last_hist.get('ts',0) > 600:
            # Every 10 min snapshot even if points stuck (for 1h history)
            should_record = True
        elif last_hist and s.get('pointsDone',0) != last_hist.get('pointsDone',0):
            if abs(s.get('pointsDone',0) - last_hist.get('pointsDone',0)) >= 1:
                should_record = True
        if should_record:
            s['pointsHistory'].append({'hour': now_hour, 'ts': int(time.time()), 'pointsDone': s.get('pointsDone',0), 'withdrawable': s.get('withdrawable',0), 'timeStr': time.strftime('%H:%M')})
            if len(s['pointsHistory']) > 500:
                s['pointsHistory'] = s['pointsHistory'][-500:]
        existing['slots'][slot] = s

        with open(STATS_FILE, 'w') as f:
            json.dump(existing, f, indent=2)

        # Track earnings history
        new_withdrawable = s.get('withdrawable', 0) or 0
        correct = data.get('correct')
        if (correct is True or data.get('countMode') == 'observed-points') and new_withdrawable > old_withdrawable and old_withdrawable > 0:
            earning = round(new_withdrawable - old_withdrawable, 4)
            earnings = {}
            try:
                with open(EARNINGS_FILE, 'r') as f:
                    earnings = json.load(f)
            except Exception:
                pass
            if slot not in earnings:
                earnings[slot] = []
            earnings[slot].append({
                'ts': time.strftime('%Y-%m-%d %H:%M:%S'),
                'epoch': int(time.time()),
                'earning': earning,
                'total': round(new_withdrawable, 4),
                'taskNum': data.get('taskNum', 0),
                'correct': True,
                'color': data.get('color', '')
            })
            # Keep last 500 entries per slot
            if len(earnings[slot]) > 500:
                earnings[slot] = earnings[slot][-500:]
            with open(EARNINGS_FILE, 'w') as f:
                json.dump(earnings, f, indent=2)
            print(f"[EARNINGS] +{earning} PHP for {slot} (total: {new_withdrawable})")

        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/earnings', methods=['GET'])
def earnings():
    try:
        with open(EARNINGS_FILE, 'r') as f:
            return jsonify(json.load(f))
    except Exception:
        return jsonify({})

@app.route('/stats', methods=['GET'])
def stats():
    try:
        with open(STATS_FILE, 'r') as f:
            return jsonify(json.load(f))
    except Exception:
        return jsonify({"slots": {}})

if __name__ == '__main__':
    scanner_port = int(os.environ.get('VT_SCANNER_PORT', '5566'))
    print(f"=== VISIONTAP STRICT COLOR ENGINE ONLINE (PORT {scanner_port}) ===")
    app.run(host='127.0.0.1', port=scanner_port, debug=False)
