import cv2, pytesseract, numpy as np

# Read the saved badge crop from test_ocr.py
badge = cv2.imread('/tmp/test_badge.png')
print(f'Badge shape: {badge.shape}')

# Try raw grayscale
gray = cv2.cvtColor(badge, cv2.COLOR_BGR2GRAY) if len(badge.shape) == 3 else badge
print(f'Gray range: {gray.min()} - {gray.max()}')
print(f'Gray mean: {gray.mean():.1f}')

# The badge has white text on gray bg - try simple threshold to make text black on white
_, thresh = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY)
cv2.imwrite('/tmp/badge_t200.png', thresh)
r = pytesseract.image_to_string(thresh, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'Thresh 200: [{r.strip()}]')

# Try threshold at 150
_, thresh150 = cv2.threshold(gray, 150, 255, cv2.THRESH_BINARY)
cv2.imwrite('/tmp/badge_t150.png', thresh150)
r = pytesseract.image_to_string(thresh150, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'Thresh 150: [{r.strip()}]')

# Try just raw grayscale (no threshold)
scaled = cv2.resize(gray, None, fx=3.0, fy=3.0, interpolation=cv2.INTER_CUBIC)
cv2.imwrite('/tmp/badge_raw.png', scaled)
r = pytesseract.image_to_string(scaled, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'Raw scaled: [{r.strip()}]')

# Try inverting the raw
inv = cv2.bitwise_not(scaled)
cv2.imwrite('/tmp/badge_inv_raw.png', inv)
r = pytesseract.image_to_string(inv, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'Inverted raw: [{r.strip()}]')

# Try higher threshold to isolate just the bright white text
_, thresh_high = cv2.threshold(gray, 220, 255, cv2.THRESH_BINARY)
scaled_h = cv2.resize(thresh_high, None, fx=3.0, fy=3.0, interpolation=cv2.INTER_CUBIC)
cv2.imwrite('/tmp/badge_high.png', scaled_h)
r = pytesseract.image_to_string(scaled_h, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'High thresh: [{r.strip()}]')
