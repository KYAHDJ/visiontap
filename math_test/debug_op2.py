import cv2
import numpy as np
import io
import sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

img = cv2.imread('C:/VisionTap/sampletask/246227139.png')
h, w = img.shape[:2]

# The operator is in the center of the image between digit groups
# Look at center 10% width, 30-70% height
center_band = img[int(h*0.3):int(h*0.7), int(w*0.4):int(w*0.6)]
gray = cv2.cvtColor(center_band, cv2.COLOR_BGR2GRAY)

# The operator is dark on white bg
_, thresh = cv2.threshold(gray, 128, 255, cv2.THRESH_BINARY_INV)

# Count dark pixels
dark_ratio = np.sum(thresh > 0) / thresh.size
print(f"Center dark_ratio: {dark_ratio:.3f}")

# Save for visual
cv2.imwrite('C:/VisionTap/math_test/debug/center_band.png', center_band)
cv2.imwrite('C:/VisionTap/math_test/debug/center_thresh.png', thresh)

# For comparison, check the same region on an image with x
img2 = cv2.imread('C:/VisionTap/sampletask/1406471571.png')
h2, w2 = img2.shape[:2]
center2 = img2[int(h2*0.3):int(h2*0.7), int(w2*0.4):int(w2*0.6)]
gray2 = cv2.cvtColor(center2, cv2.COLOR_BGR2GRAY)
_, thresh2 = cv2.threshold(gray2, 128, 255, cv2.THRESH_BINARY_INV)
dark_ratio2 = np.sum(thresh2 > 0) / thresh2.size
print(f"12x6 center dark_ratio: {dark_ratio2:.3f}")

# Check + image
img3 = cv2.imread('C:/VisionTap/sampletask/1118029390.png')
h3, w3 = img3.shape[:2]
center3 = img3[int(h3*0.3):int(h3*0.7), int(w3*0.4):int(w3*0.6)]
gray3 = cv2.cvtColor(center3, cv2.COLOR_BGR2GRAY)
_, thresh3 = cv2.threshold(gray3, 128, 255, cv2.THRESH_BINARY_INV)
dark_ratio3 = np.sum(thresh3 > 0) / thresh3.size
print(f"13+7 center dark_ratio: {dark_ratio3:.3f}")
