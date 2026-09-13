import cv2, pytesseract, numpy as np, re

img = cv2.imread('/home/opc/VisionTap/pcapp/scanner/debug_captured_task.png')
h, w, _ = img.shape
print(f'Image size: {w}x{h}')

# Test the same crop as ocr_read_badge_number
bottom = img[int(h*0.60):h, 0:w]
hsv_bottom = cv2.cvtColor(bottom, cv2.COLOR_BGR2HSV)
lower_badge = np.array([85, 30, 50])
upper_badge = np.array([135, 255, 220])
badge_mask = cv2.inRange(hsv_bottom, lower_badge, upper_badge)
contours, _ = cv2.findContours(badge_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
print(f'Blue badge contours found: {len(contours)}')

target_crop = bottom
for c in contours:
    x, y, bw, bh = cv2.boundingRect(c)
    print(f'  Contour: x={x}, y={y}, w={bw}, h={bh}')
    if 18 <= bh <= 60 and 18 <= bw <= 120:
        pad = 4
        x1, y1 = max(0, x - pad), max(0, y - pad)
        x2, y2 = min(bottom.shape[1], x + bw + pad), min(bottom.shape[0], y + bh + pad)
        target_crop = bottom[y1:y2, x1:x2]
        print(f'  -> SELECTED badge crop: {x1},{y1} to {x2},{y2}')
        break

gray = cv2.cvtColor(target_crop, cv2.COLOR_BGR2GRAY)
scaled = cv2.resize(gray, None, fx=3.0, fy=3.0, interpolation=cv2.INTER_CUBIC)
cv2.imwrite('/tmp/test_badge.png', scaled)
print(f'Saved badge crop: {scaled.shape}')

text = pytesseract.image_to_string(scaled, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'OCR whitelisted: [{text.strip()}]')

text2 = pytesseract.image_to_string(scaled)
print(f'OCR full: [{text2.strip()}]')

digits = re.findall(r'\b([1-9]|[12][0-9]|3[0-6])\b', text2)
print(f'Digits found: {digits}')
