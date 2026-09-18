"""
VisionTap Math Test Solver v2
Flow: OCR first to detect type → then solve accordingly
Only B&W for fruit counting. Everything else uses original image.
"""
import cv2
import numpy as np
import pytesseract
import re
import os
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
SAMPLE_DIR = os.path.join(os.path.dirname(__file__), "..", "sampletask")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")


def ocr(img):
    """Fast OCR on image."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
    scaled = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    return pytesseract.image_to_string(scaled, config='--psm 6').strip()


def to_bw_fruits(img):
    """Convert to B&W: colored fruits -> black, white bg -> white."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    is_colored = (sat > 40) & (val > 60)
    return np.where(is_colored, 0, 255).astype(np.uint8)


def count_fruits(bw, y_start_pct=0.15, y_end_pct=0.75):
    """Count black blobs in B&W fruit image."""
    h, w = bw.shape
    roi = bw[int(h * y_start_pct):int(h * y_end_pct), :]
    inv = cv2.bitwise_not(roi)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    cleaned = cv2.morphologyEx(inv, cv2.MORPH_CLOSE, kernel, iterations=1)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, kernel, iterations=1)
    contours, _ = cv2.findContours(cleaned, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return len([c for c in contours if cv2.contourArea(c) > 400])


def detect_operator(img):
    """Detect the math operator (x + - /) between fruit rows from original image."""
    h, w = img.shape[:2]
    # Operator is in the middle band (40-60% height, 30-70% width)
    band = img[int(h * 0.40):int(h * 0.60), int(w * 0.30):int(w * 0.70)]
    gray = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
    # The operator is dark on light background
    _, thresh = cv2.threshold(gray, 128, 255, cv2.THRESH_BINARY_INV)
    # Count dark pixels to detect symbol shape
    dark_ratio = np.sum(thresh > 0) / thresh.size

    # OCR just the operator band
    scaled = cv2.resize(thresh, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    text = pytesseract.image_to_string(scaled, config='--psm 10 -c tessedit_char_whitelist=x+−-*/').strip()

    if 'x' in text.lower() or '*' in text:
        return 'x'
    elif '+' in text:
        return '+'
    elif '-' in text or '−' in text:
        return '-'
    elif '/' in text or '÷' in text:
        return '/'

    # Fallback: check full OCR text for operator hints
    return None


def solve_fruit_counting(img):
    """Task: 'How many X?' -> count colored fruits, return B&W image."""
    bw = to_bw_fruits(img)
    count = count_fruits(bw)
    return count, bw


def solve_emoji_math(img):
    """Task: 'What is the Answer' with fruit rows -> count each row, apply operator."""
    h, w = img.shape[:2]
    bw = to_bw_fruits(img)

    # Count top row (20-45% height) and bottom row (55-80% height)
    top_count = count_fruits(bw, 0.20, 0.45)
    bottom_count = count_fruits(bw, 0.55, 0.80)

    # Detect operator from original image
    op = detect_operator(img)

    # Fallback: try OCR on full image for operator
    if not op:
        text = ocr(img).lower()
        if 'x' in text or 'multiply' in text:
            op = 'x'
        elif '+' in text:
            op = '+'
        elif '-' in text or 'subtract' in text:
            op = '-'
        elif '/' in text or 'divide' in text:
            op = '/'
        else:
            op = '+'  # default

    if op == 'x':
        result = top_count * bottom_count
    elif op == '+':
        result = top_count + bottom_count
    elif op == '-':
        result = top_count - bottom_count
    elif op == '/':
        result = top_count // bottom_count if bottom_count > 0 else 0
    else:
        result = top_count + bottom_count

    return result, None  # No B&W image for emoji math


def solve_word_problem(img):
    """Task: 'Solve the Question' with text math -> OCR text, extract numbers + operation."""
    text = ocr(img)
    text_lower = text.lower()
    nums = [int(n) for n in re.findall(r'\d+', text)]
    if len(nums) < 2:
        return None

    a, b = nums[0], nums[1]

    if 'product' in text_lower or 'multiply' in text_lower or 'times' in text_lower:
        return a * b
    elif 'sum' in text_lower or 'add' in text_lower or 'plus' in text_lower:
        return a + b
    elif 'difference' in text_lower or 'subtract' in text_lower or 'minus' in text_lower:
        if 'from' in text_lower:
            return b - a
        return a - b
    elif 'quotient' in text_lower or 'divide' in text_lower or 'divided' in text_lower:
        return a // b if b != 0 else 0

    # Fallback: operator symbols
    if '×' in text or 'x' in text.lower():
        return a * b
    elif '+' in text:
        return a + b
    elif '-' in text or '−' in text:
        return a - b
    elif '/' in text or '÷' in text:
        return a // b if b != 0 else 0

    return a + b


def solve_digit_boxes(img):
    """Task: 'What is the Answer' with gray/blue digit boxes -> detect each box, OCR each."""
    h, w = img.shape[:2]
    roi = img[int(h * 0.25):int(h * 0.75), int(w * 0.02):int(w * 0.98)]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

    _, mask = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    dilated = cv2.dilate(mask, kernel, iterations=1)
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = sorted([cv2.boundingRect(c) for c in contours if cv2.contourArea(c) > 300], key=lambda b: b[0])

    if len(boxes) < 2:
        return None

    parts = []
    for x, y, bw, bh in boxes:
        box_mask = mask[y:y+bh, x:x+bw]
        inv = cv2.bitwise_not(box_mask)
        scaled = cv2.resize(inv, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
        text = pytesseract.image_to_string(scaled, config='--psm 10 -c tessedit_char_whitelist=0123456789+-*/').strip()
        if not text:
            text = pytesseract.image_to_string(scaled, config='--psm 8 -c tessedit_char_whitelist=0123456789+-*/').strip()
        if text and text in '+-*/':
            parts.append(text)
        elif text and any(c.isdigit() for c in text):
            parts.append(text)
        elif bw < 45 and bh < 45:
            aspect = bw / max(bh, 1)
            if aspect > 2.0:
                parts.append('-')
            elif aspect < 0.7:
                parts.append('/')
            else:
                parts.append('*')
        else:
            parts.append('?' if text else '')

    expression = ' '.join(parts)
    expression = expression.replace('×', '*').replace('÷', '/').replace('−', '-')
    expression = re.sub(r'\s+', '', expression)
    expression = expression.replace('?', '')

    print(f"  Boxes: {len(boxes)}, parts: {parts}, expr: {expression}")

    try:
        allowed = set('0123456789+-*/')
        if all(c in allowed for c in expression) and any(c.isdigit() for c in expression):
            result = eval(expression)
            return int(result)
    except Exception:
        pass

    return None


def solve_image(filepath):
    """Main: detect type via OCR, then solve accordingly."""
    import time
    filename = os.path.basename(filepath)
    print(f"\n{'='*50}")
    print(f"Processing: {filename}")

    start = time.time()

    img = cv2.imread(filepath)
    if img is None:
        print(f"  ERROR: Could not read image")
        return None, None

    text = ocr(img)
    text_lower = text.lower()
    print(f"  OCR: {text}")

    # Type 1: Fruit counting
    if 'how many' in text_lower or 'count' in text_lower:
        count, bw = solve_fruit_counting(img)
        print(f"  -> Fruit counting: {count}")
        return count, bw

    # Type 2: Emoji math or digit boxes
    if 'what is the answer' in text_lower or 'answer' in text_lower:
        # Check if image has colored boxes (digit boxes) vs fruits (emoji math)
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        h_img, w_img = img.shape[:2]
        roi = hsv[int(h_img*0.3):int(h_img*0.7), int(w_img*0.05):int(w_img*0.95)]

        # Digit boxes: blue/gray colored regions (hue 100-130 or low saturation)
        blue = ((roi[:,:,0] > 100) & (roi[:,:,0] < 130) & (roi[:,:,1] > 30) & (roi[:,:,2] > 50))
        gray_box = (roi[:,:,1] < 50) & (roi[:,:,2] > 100) & (roi[:,:,2] < 220)
        box_pixels = np.sum(blue | gray_box)
        total_pixels = roi.shape[0] * roi.shape[1]
        box_ratio = box_pixels / total_pixels

        # Emoji math: fruits are small round colored objects, mostly white bg
        # Digit boxes: large rectangular colored blocks
        if box_ratio > 0.10:
            result = solve_digit_boxes(img)
            if result is not None:
                print(f"  -> Digit boxes: {result}")
                return result, None

        # Emoji math fallback
        result, _ = solve_emoji_math(img)
        print(f"  -> Emoji math: {result}")
        return result, None

    # Type 3: Word problem
    if 'solve' in text_lower or 'question' in text_lower or 'what is' in text_lower:
        result = solve_word_problem(img)
        if result is not None:
            print(f"  -> Word problem: {result}")
            return result, None

    # Fallback: try word problem
    result = solve_word_problem(img)
    if result is not None:
        print(f"  -> Fallback word problem: {result}")
        return result, None

    print(f"  -> UNKNOWN")
    return None, None


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    files = sorted([f for f in os.listdir(SAMPLE_DIR) if f.endswith('.png')])
    print(f"Found {len(files)} images")

    # Expected answers for verification
    expected = {
        "-271373711.png": 10,   # Cherries (10 pairs, counted individually)
        "-548334919.png": 2207, # 1633+574
        "-736908537.png": 10,   # 9+1 apples
        "-841405229.png": 1628080, # 1732x940
        "1044439050.png": 3734, # 2953+781
        "1118029390.png": 20,   # 13+7 apples
        "1406471571.png": 77,   # 11x7 apples
        "2108051732.png": 9,    # Grapes
        "246227139.png": 140,   # 143-3
        "282852146.png": 21,    # 7x3 apples
        "596109935.png": 191,    # 678-869 (absolute value)
        "752325447.png": 4,     # Oranges
        "777523089.png": 658987,# 2003x329
    }

    results = {}
    times = {}
    for f in files:
        filepath = os.path.join(SAMPLE_DIR, f)
        import time
        t0 = time.time()
        answer, bw_img = solve_image(filepath)
        elapsed = time.time() - t0
        times[f] = elapsed
        if answer is not None:
            answer = abs(answer)
        if answer is not None:
            # Save: B&W for fruit counting, original for others
            if bw_img is not None:
                out_path = os.path.join(OUTPUT_DIR, f"{answer}_{f}")
                cv2.imwrite(out_path, bw_img)
            else:
                out_path = os.path.join(OUTPUT_DIR, f"{answer}_{f}")
                img = cv2.imread(filepath)
                cv2.imwrite(out_path, img)
            print(f"  SAVED: {os.path.basename(out_path)}")
        results[f] = answer

    print(f"\n{'='*50}")
    print(f"RESULTS:")
    correct = 0
    total_time = 0
    for f, ans in results.items():
        exp = expected.get(f, "?")
        match = "OK" if ans == exp else "WRONG"
        if ans == exp:
            correct += 1
        t = times[f]
        total_time += t
        print(f"  {f}: expected={exp} got={ans} [{match}] ({t:.3f}s)")

    print(f"\nAccuracy: {correct}/{len(files)}")
    print(f"Total time: {total_time:.3f}s  Avg: {total_time/len(files):.3f}s per image")


if __name__ == "__main__":
    main()
