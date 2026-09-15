import cv2
import numpy as np
import pytesseract
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

for fname in ['-548334919.png', '246227139.png', '-841405229.png']:
    img = cv2.imread(f'C:/VisionTap/sampletask/{fname}')
    h, w = img.shape[:2]
    roi = img[int(h*0.25):int(h*0.75), int(w*0.02):int(w*0.98)]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

    _, mask = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5,5))
    dilated = cv2.dilate(mask, kernel, iterations=1)

    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = sorted([cv2.boundingRect(c) for c in contours if cv2.contourArea(c) > 300], key=lambda b: b[0])
    print(f'{fname}: {len(boxes)} boxes')

    digits = []
    for x, y, bw, bh in boxes:
        box_mask = mask[y:y+bh, x:x+bw]
        inv = cv2.bitwise_not(box_mask)
        scaled = cv2.resize(inv, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
        text = pytesseract.image_to_string(scaled, config='--psm 10 -c tessedit_char_whitelist=0123456789+-').strip()
        if not text:
            text = pytesseract.image_to_string(scaled, config='--psm 8 -c tessedit_char_whitelist=0123456789+-').strip()
        print(f'  Box ({x},{y}) {bw}x{bh}: "{text}"')
        if text:
            digits.append(text)

    print(f'  -> {digits}')
    print()
