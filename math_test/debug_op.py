import cv2
import numpy as np
import io
import sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

img = cv2.imread('C:/VisionTap/sampletask/246227139.png')
h, w = img.shape[:2]
roi = img[int(h*0.25):int(h*0.75), int(w*0.02):int(w*0.98)]
gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

_, mask = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5,5))
dilated = cv2.dilate(mask, kernel, iterations=1)
contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
boxes = sorted([cv2.boundingRect(c) for c in contours if cv2.contourArea(c) > 300], key=lambda b: b[0])

for x, y, bw, bh in boxes:
    op_region = gray[y:y+bh, x:x+bw]
    dark_ratio = np.sum(op_region < 128) / max(op_region.size, 1)
    is_small = bw < 45 and bh < 45
    label = "MUL" if dark_ratio > 0.3 else "MINUS" if is_small else "DIGIT"
    print(f"Box ({x},{y}) {bw}x{bh} dark_ratio={dark_ratio:.3f} -> {label}")
