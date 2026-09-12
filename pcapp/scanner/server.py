import base64
import re
import os
import time
import numpy as np
import cv2
from flask import Flask, request, jsonify
from flask_cors import CORS

try:
    import easyocr
    reader = easyocr.Reader(['en'], gpu=False)
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
    scaled = cv2.resize(gray, None, fx=3.0, fy=3.0, interpolation=cv2.INTER_CUBIC)

    try:
        results = reader.readtext(scaled, allowlist='0123456789')
        text = " ".join([res[1] for res in results]).strip()
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
        target_cx = int(margin_x + (target_col + 0.5) * cell_w)
        target_cy = int(margin_y + (target_row + 0.5) * cell_h)
        target_sample = hsv_img[max(0, target_cy - 2):min(height, target_cy + 3),
                                max(0, target_cx - 2):min(width, target_cx + 3)]
        detected_color = detect_color_from_sample(target_sample)

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

# ============================================================
# MATH TASK PIPELINES
# ============================================================

def ocr_read_header(img):
    """Read the prompt/question text area dynamically."""
    if not reader:
        return ""
    height, width, _ = img.shape
    # Dynamic crop: 25%-65% height, 5%-95% width (skips status bar, captures question)
    crop = img[int(height * 0.25):int(height * 0.65), int(width * 0.05):int(width * 0.95)]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    scaled = cv2.resize(gray, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    try:
        results = reader.readtext(scaled, detail=0)
        full_text = " ".join(results).lower()
        # Filter out account header noise
        cleaned = re.sub(r'ec&l account:.*?(?:points:?\s*\d+\s*/\s*\d+|points)', '', full_text)
        return cleaned.strip()
    except Exception as e:
        print(f" -> [Header OCR Error]: {e}")
        return ""

def count_blobs_binary(img):
    """Detect colorful objects (fruits) on light background using HSV saturation, not grayscale brightness."""
    height, width, _ = img.shape

    # Zone B: Canvas area with fruits/objects (skip header text)
    canvas = img[int(height * 0.45):int(height * 0.82), int(width * 0.08):int(width * 0.92)]
    if canvas.size == 0:
        return 0, 0.0

    # Convert to HSV — colorful objects have HIGH saturation, background/text has LOW saturation
    hsv = cv2.cvtColor(canvas, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]  # Saturation channel
    val = hsv[:, :, 2]  # Value channel

    # Mask: colorful pixels (saturation > 50 AND value > 80) = object
    # Everything else (white bg, gray text, gray UI) = background
    color_mask = ((sat > 50) & (val > 80)).astype(np.uint8) * 255

    # Clean up noise
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    color_mask = cv2.morphologyEx(color_mask, cv2.MORPH_CLOSE, kernel, iterations=3)
    color_mask = cv2.morphologyEx(color_mask, cv2.MORPH_OPEN, kernel, iterations=1)

    cv2.imwrite("debug_color_mask.png", color_mask)

    contours, _ = cv2.findContours(color_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return 0, 0.0

    # Filter blobs
    blobs = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < 100:
            continue
        x, y, w, h = cv2.boundingRect(c)
        aspect = float(w) / max(h, 1)
        # Skip very thin/wide shapes (likely lines or separators)
        if aspect > 3.0 or aspect < 0.33:
            continue
        blobs.append({"area": area, "aspect": aspect, "x": x, "y": y, "w": w, "h": h})

    if not blobs:
        return 0, 0.0

    # Keep blobs of similar size (filter out outliers)
    areas = [b["area"] for b in blobs]
    median_area = sorted(areas)[len(areas) // 2]
    filtered = [b for b in blobs if 0.2 * median_area <= b["area"] <= 5.0 * median_area]

    count = len(filtered)
    confidence = min(1.0, count / max(1, len(blobs))) if blobs else 0.0

    print(f"  [BLOB] contours={len(contours)} blobs_raw={len(blobs)} filtered={len(filtered)}")
    for i, b in enumerate(filtered[:10]):
        print(f"    blob[{i}] area={b['area']:.0f} aspect={b['aspect']:.2f} xy=({b['x']},{b['y']})")

    return count, confidence

def count_multiline_binary(img):
    """Split canvas into top/bottom halves, count blobs in each, add them."""
    height, width, _ = img.shape
    # Top half: 45%-63% height
    top_count, c1 = count_blobs_binary(
        img[int(height * 0.30):int(height * 0.63), :]
    )
    # Bottom half: 63%-82% height
    bottom_count, c2 = count_blobs_binary(
        img[int(height * 0.57):int(height * 0.85), :]
    )
    total = top_count + bottom_count
    if top_count > 0 and bottom_count > 0:
        confidence = min(c1, c2)
    elif total > 0:
        confidence = 0.5
    else:
        confidence = 0.0
    return total, confidence

def detect_digit_boxes_present(img):
    """Quick check: returns True if square-ish number blocks exist in the canvas area."""
    h, w, _ = img.shape
    canvas = img[int(h * 0.30):int(h * 0.80), int(w * 0.05):int(w * 0.95)]
    gray = cv2.cvtColor(canvas, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, thresh = cv2.threshold(blurred, 200, 255, cv2.THRESH_BINARY_INV)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    box_count = 0
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        aspect = float(cw) / max(ch, 1)
        if 0.7 <= aspect <= 1.3 and 25 <= cw <= 90:
            box_count += 1
    return box_count >= 2

def parse_block_expression(img):
    """Detect number boxes, sort by Y then X, OCR each, and evaluate expression."""
    height, width, _ = img.shape
    canvas = img[int(height * 0.30):int(height * 0.80), int(width * 0.05):int(width * 0.95)]
    gray = cv2.cvtColor(canvas, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        area = w * h
        if area > 200 and 0.3 < w / max(h, 1) < 3.0:
            boxes.append((x, y, w, h))
    if not boxes:
        return None, 0.0
    median_h = sorted([b[3] for b in boxes])[len(boxes) // 2]
    rows = []
    current_row = [boxes[0]]
    for b in boxes[1:]:
        if abs(b[1] - current_row[-1][1]) <= median_h * 0.5:
            current_row.append(b)
        else:
            rows.append(sorted(current_row, key=lambda b: b[0]))
            current_row = [b]
    rows.append(sorted(current_row, key=lambda b: b[0]))
    tokens = []
    for row in rows:
        for (x, y, w, h) in row:
            pad = 2
            x1, y1 = max(0, x - pad), max(0, y - pad)
            x2, y2 = min(canvas.shape[1], x + w + pad), min(canvas.shape[0], y + h + pad)
            crop = canvas[y1:y2, x1:x2]
            crop_gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if len(crop.shape) == 3 else crop
            scaled = cv2.resize(crop_gray, None, fx=3.0, fy=3.0, interpolation=cv2.INTER_CUBIC)
            try:
                results = reader.readtext(scaled, allowlist='0123456789+-*/')
                text = " ".join([res[1] for res in results]).strip()
                tokens.append(text)
            except Exception:
                pass
    expression = " ".join(tokens)
    expression = re.sub(r'[^0-9+\-*/.]', ' ', expression).strip()
    expression = re.sub(r'\s+', ' ', expression)
    try:
        allowed = set('0123456789+-*/. ')
        if all(c in allowed for c in expression) and any(c.isdigit() for c in expression):
            result = eval(expression)
            return str(int(result)) if isinstance(result, float) and result == int(result) else str(result), 0.8
    except Exception:
        pass
    return expression, 0.3

def solve_word_problem(header_text):
    """Extract numbers and operator from header text, compute answer."""
    nums = [int(n) for n in re.findall(r'\d+', header_text)]
    lower = header_text.lower()
    if len(nums) < 2:
        return None, 0.0, "Need at least 2 numbers"
    if "product" in lower or "multiply" in lower or "times" in lower:
        result = nums[0] * nums[1]
        confidence = 0.9 if len(nums) == 2 else 0.6
        return str(result), confidence, None
    elif "sum" in lower or "add" in lower or "plus" in lower or "total" in lower:
        result = nums[0] + nums[1]
        confidence = 0.9 if len(nums) == 2 else 0.6
        return str(result), confidence, None
    elif "difference" in lower or "subtract" in lower or "minus" in lower:
        result = nums[0] - nums[1]
        confidence = 0.9 if len(nums) == 2 else 0.6
        return str(result), confidence, None
    elif "quotient" in lower or "divide" in lower or "divided" in lower:
        if nums[1] == 0:
            return None, 0.0, "Division by zero"
        result = nums[0] / nums[1]
        confidence = 0.9 if len(nums) == 2 else 0.6
        return str(int(result)) if result == int(result) else str(result), confidence, None
    return None, 0.0, "Unknown operation"

@app.route('/detect_math', methods=['POST'])
def detect_math():
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

        # Speed optimization: resize large images before OCR
        h, w = img.shape[:2]
        if w > 800:
            scale = 800.0 / w
            img = cv2.resize(img, (800, int(h * scale)))

        header_text = ocr_read_header(img)
        lower_header = header_text.lower()
        print(f"\n==========================================")
        print(f"[MATH] Header OCR: '{header_text}'")

        # 1. Emoji counting: "How many..." or "count" or "many"
        if any(k in lower_header for k in ["how many", "count", "many"]):
            count, conf = count_blobs_binary(img)
            if count > 0:
                print(f"[MATH] Emoji count: {count} (conf={conf:.2f})")
                print(f"==========================================\n")
                return jsonify({"answer": str(count), "type": "emoji_count", "confidence": conf})

        # 2. "What is the Answer" — check if digit boxes exist
        if any(k in lower_header for k in ["what is", "answer", "calculate", "expression"]):
            if detect_digit_boxes_present(img):
                # Has digit boxes → boxed arithmetic
                expr, conf = parse_block_expression(img)
                if expr and conf > 0.5:
                    print(f"[MATH] Boxed arithmetic: {expr} (conf={conf:.2f})")
                    print(f"==========================================\n")
                    return jsonify({"answer": str(expr), "type": "boxed_arithmetic", "confidence": conf})
            else:
                # No digit boxes → emoji math (e.g. 5 apples + 1 apple)
                count, conf = count_multiline_binary(img)
                if count > 0:
                    print(f"[MATH] Emoji math: {count} (conf={conf:.2f})")
                    print(f"==========================================\n")
                    return jsonify({"answer": str(count), "type": "emoji_math", "confidence": conf})

        # 3. Word problems: multiply/sum/add etc.
        math_keywords = ["product", "multiply", "multiplied", "sum", "add", "added",
                         "times", "plus", "total", "subtract", "subtracted", "minus",
                         "difference", "divide", "divided", "quotient"]
        if any(k in lower_header for k in math_keywords):
            answer, conf, err = solve_word_problem(header_text)
            if answer:
                print(f"[MATH] Word problem: {answer} (conf={conf:.2f})")
                print(f"==========================================\n")
                return jsonify({"answer": answer, "type": "word_problem", "confidence": conf})

        # 4. Fallback: try word problem on full header text
        answer, conf, err = solve_word_problem(header_text)
        if answer:
            print(f"[MATH] Fallback word problem: {answer} (conf={conf:.2f})")
            print(f"==========================================\n")
            return jsonify({"answer": answer, "type": "word_problem", "confidence": conf})

        # 5. Fallback: try emoji counting
        count, conf = count_blobs_binary(img)
        if conf >= 0.4:
            print(f"[MATH] Fallback emoji count: {count} (conf={conf:.2f})")
            print(f"==========================================\n")
            return jsonify({"answer": str(count), "type": "fallback_emoji", "confidence": conf})

        # 6. Fallback: try boxed arithmetic
        expr, conf = parse_block_expression(img)
        if expr and conf > 0.3:
            print(f"[MATH] Fallback boxed arithmetic: {expr} (conf={conf:.2f})")
            print(f"==========================================\n")
            return jsonify({"answer": str(expr), "type": "boxed_arithmetic", "confidence": conf})

        print(f"[MATH] Unrecognized task structure")
        print(f"==========================================\n")
        return jsonify({"error": "Unrecognized math task", "header": header_text, "confidence": 0.0})

    except Exception as e:
        print(f"[MATH EXCEPT] {str(e)}")
        return jsonify({"error": str(e), "confidence": 0.0}), 500

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

if __name__ == '__main__':
    print("=== VISIONTAP STRICT COLOR ENGINE ONLINE (PORT 5566) ===")
    app.run(host='127.0.0.1', port=5566, debug=False)