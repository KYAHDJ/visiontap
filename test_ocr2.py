import cv2, pytesseract, numpy as np, re

img = cv2.imread('/home/opc/VisionTap/pcapp/scanner/debug_captured_task.png')
h, w, _ = img.shape

bottom = img[int(h*0.60):h, 0:w]
hsv_bottom = cv2.cvtColor(bottom, cv2.COLOR_BGR2HSV)
lower_badge = np.array([85, 30, 50])
upper_badge = np.array([135, 255, 220])
badge_mask = cv2.inRange(hsv_bottom, lower_badge, upper_badge)
contours, _ = cv2.findContours(badge_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

target_crop = bottom
for c in contours:
    x, y, bw, bh = cv2.boundingRect(c)
    if 18 <= bh <= 60 and 18 <= bw <= 120:
        pad = 4
        x1, y1 = max(0, x - pad), max(0, y - pad)
        x2, y2 = min(bottom.shape[1], x + bw + pad), min(bottom.shape[0], y + bh + pad)
        target_crop = bottom[y1:y2, x1:x2]
        break

gray = cv2.cvtColor(target_crop, cv2.COLOR_BGR2GRAY)
scaled = cv2.resize(gray, None, fx=3.0, fy=3.0, interpolation=cv2.INTER_CUBIC)

# Method 1: Otsu threshold (binary)
_, thresh = cv2.threshold(scaled, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
cv2.imwrite('/tmp/badge_thresh.png', thresh)
t1 = pytesseract.image_to_string(thresh, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'Otsu threshold: [{t1.strip()}]')

# Method 2: Invert + threshold
inv = cv2.bitwise_not(thresh)
cv2.imwrite('/tmp/badge_inv.png', inv)
t2 = pytesseract.image_to_string(inv, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'Inverted: [{t2.strip()}]')

# Method 3: Adaptive threshold
adaptive = cv2.adaptiveThreshold(scaled, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2)
cv2.imwrite('/tmp/badge_adaptive.png', adaptive)
t3 = pytesseract.image_to_string(adaptive, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'Adaptive: [{t3.strip()}]')

# Method 4: Contrast stretch + threshold
p2, p98 = np.percentile(scaled, (2, 98))
stretched = np.clip((scaled.astype(float) - p2) / (p98 - p2) * 255, 0, 255).astype(np.uint8)
_, thresh2 = cv2.threshold(stretched, 127, 255, cv2.THRESH_BINARY)
cv2.imwrite('/tmp/badge_stretch.png', thresh2)
t4 = pytesseract.image_to_string(thresh2, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'Stretch+thresh: [{t4.strip()}]')

# Method 5: Just threshold at 127 on the scaled image
_, thresh3 = cv2.threshold(scaled, 127, 255, cv2.THRESH_BINARY)
cv2.imwrite('/tmp/badge_simple.png', thresh3)
t5 = pytesseract.image_to_string(thresh3, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'Simple thresh: [{t5.strip()}]')

# Method 6: High contrast - scale to full range
norm = cv2.normalize(scaled, None, 0, 255, cv2.NORM_MINMAX)
_, thresh4 = cv2.threshold(norm, 128, 255, cv2.THRESH_BINARY)
cv2.imwrite('/tmp/badge_norm.png', thresh4)
t6 = pytesseract.image_to_string(thresh4, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'Normalized: [{t6.strip()}]')
