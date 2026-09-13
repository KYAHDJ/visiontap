import cv2, pytesseract, numpy as np

badge = cv2.imread('/tmp/test_badge.png')
gray = cv2.cvtColor(badge, cv2.COLOR_BGR2GRAY) if len(badge.shape) == 3 else badge

# White text on gray bg -> invert so text is black on white
# First, make the background truly white by thresholding
# Text is bright (>200), bg is medium gray (80-150)
# So: set everything > 180 to 255 (text becomes white), then invert
mask = np.where(gray > 180, 255, 0).astype(np.uint8)
scaled = cv2.resize(mask, None, fx=4.0, fy=4.0, interpolation=cv2.INTER_CUBIC)
cv2.imwrite('/tmp/badge_mask.png', scaled)
r = pytesseract.image_to_string(scaled, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'Mask white-only: [{r.strip()}]')

# Invert the mask so text is black
inv = cv2.bitwise_not(scaled)
cv2.imwrite('/tmp/badge_mask_inv.png', inv)
r = pytesseract.image_to_string(inv, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'Mask inverted: [{r.strip()}]')

# Try blur + threshold
blurred = cv2.GaussianBlur(gray, (3,3), 0)
_, thresh_otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
scaled2 = cv2.resize(thresh_otsu, None, fx=4.0, fy=4.0, interpolation=cv2.INTER_CUBIC)
cv2.imwrite('/tmp/badge_blur_otsu.png', scaled2)
r = pytesseract.image_to_string(scaled2, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'Blur+Otsu: [{r.strip()}]')

# Try psm 8 (single word) and psm 13 (raw line)
for psm in [7, 8, 13]:
    r = pytesseract.image_to_string(inv, config=f'--psm {psm} -c tessedit_char_whitelist=0123456789')
    print(f'Mask inv psm{psm}: [{r.strip()}]')
