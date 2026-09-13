import pytesseract, cv2, numpy as np

# Simple test with number 42
img = np.zeros((100, 200), dtype=np.uint8)
img[:] = 255
cv2.putText(img, '42', (50, 75), cv2.FONT_HERSHEY_SIMPLEX, 2, 0, 3)
cv2.imwrite('/tmp/test_simple.png', img)
result = pytesseract.image_to_string(img, config='--psm 7 -c tessedit_char_whitelist=0123456789')
print(f'Simple test: [{result.strip()}]')

# Now test with the actual badge but with different PSM modes
badge = cv2.imread('/tmp/badge_thresh.png')
for psm in [6, 7, 8, 10, 11, 13]:
    r = pytesseract.image_to_string(badge, config=f'--psm {psm} -c tessedit_char_whitelist=0123456789')
    print(f'PSM {psm}: [{r.strip()}]')
