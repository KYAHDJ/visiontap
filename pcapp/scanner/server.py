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

if __name__ == '__main__':
    print("=== VISIONTAP STRICT COLOR ENGINE ONLINE (PORT 5566) ===")
    app.run(host='127.0.0.1', port=5566, debug=False)