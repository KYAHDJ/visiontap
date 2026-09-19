import base64
import json
import re
import os
import time
import numpy as np
import cv2
from flask import Flask, request, jsonify
from flask_cors import CORS

try:
    import pytesseract
    pytesseract.get_tesseract_version()
    reader = True
except Exception:
    reader = None

app = Flask(__name__)
CORS(app)

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
        text = pytesseract.image_to_string(scaled, config='--psm 7 -c tessedit_char_whitelist=0123456789').strip()
        digits = re.findall(r'\b([1-9]|[12][0-9]|3[0-6])\b', text)
        if digits:
            return int(digits[0])
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
        # Darken all colors to black, keep white text contrast (as requested) — HSV white detection (permissive)
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        # White text: low saturation, high value (permissive for anti-aliased white)
        lower_white = np.array([0, 0, 150])
        upper_white = np.array([180, 80, 255])
        mask_white = cv2.inRange(hsv, lower_white, upper_white)
        # Invert for tesseract (black text on white) — mask_white has text white, background black
        inv = cv2.bitwise_not(mask_white)
        # Clean small noise
        kernel = np.ones((2,2), np.uint8)
        inv = cv2.morphologyEx(inv, cv2.MORPH_OPEN, kernel)
        # Upscale 3x for better OCR
        scaled = cv2.resize(inv, None, fx=3.0, fy=3.0, interpolation=cv2.INTER_CUBIC)
        # OCR with math whitelist
        config = '--psm 7 -c tessedit_char_whitelist=0123456789+-xX*/='
        text = pytesseract.image_to_string(scaled, config=config).strip()
        print(f"[MATH OCR raw] '{text}'")
        # Clean text: keep only math chars
        cleaned = re.sub(r'[^0-9+\-xX*/]', '', text)
        # Normalize X to *
        cleaned = cleaned.replace('x', '*').replace('X', '*')
        # Handle case where OCR misreads: e.g., "2917X555" -> "2917*555"
        # Try to find pattern: number operator number
        m = re.search(r'(\d{1,5})\s*([+\-*/])\s*(\d{1,5})', cleaned)
        if not m:
            # Try with original text
            m2 = re.search(r'(\d+)\s*([+\-xX*/])\s*(\d+)', text)
            if m2:
                a, op, b = m2.groups()
                op = op.replace('x','*').replace('X','*')
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
        print(f"[MATH SOLVED] {a} {op} {b} = {ans} (from '{text}')")
        return jsonify({"answer": str(ans), "expression": f"{a}{op}{b}", "raw": text, "cleaned": cleaned})
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
                if (old_pointsDone >= 100 and 0 <= new_pd <= 10) or (old_pointsDone >= 150 and 0 <= new_pd <= 20) or (old_pointsDone >= 50 and new_pd == 0):
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
        if correct is True and new_withdrawable > old_withdrawable and old_withdrawable > 0:
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
    print("=== VISIONTAP STRICT COLOR ENGINE ONLINE (PORT 5566) ===")
    app.run(host='0.0.0.0', port=5566, debug=False)