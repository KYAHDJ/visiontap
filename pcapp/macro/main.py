import sys
import os
import json
import time
import ctypes

# Set DPI awareness before Qt creates any windows (avoids the Access Denied warning)
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass

import cv2
import numpy as np
import pyautogui
import pyperclip
import keyboard
from PyQt6.QtWidgets import (QApplication, QWidget, QPushButton, QVBoxLayout, 
                             QLabel, QFileDialog, QTextEdit, QHBoxLayout)
from PyQt6.QtCore import Qt, QThread, pyqtSignal

CONFIG_FILE = "config.json"

# --- WORKER THREAD FOR GLOBAL HOTKEY LISTENERS ---
class HotkeyWorker(QThread):
    triggered = pyqtSignal()

    def run(self):
        # Listens globally for F9 keypress
        keyboard.add_hotkey('F9', lambda: self.triggered.emit())
        keyboard.wait()

# --- STEP 2: MAIN APPLICATION GUI ---
# Note: region selection is handled inside open_selector() below using a
# two-click QMessageBox flow (top-left then bottom-right), because the older
# fullscreen transparent overlay crashed on Windows/DPI setups.
class MacroApp(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Vision Macro Automation Tool")
        self.setGeometry(100, 100, 500, 620)
        self.setWindowFlags(Qt.WindowType.WindowStaysOnTopHint)

        # App State / Config Data
        self.config = {
            "text_region": None,
            "sprite_region": None,
            "input_region": None,
            "text_folder": "",
            "sprite_folder": "",
            "submit_image_path": ""
        }

        self.load_config()
        self.init_ui()
        self.init_hotkey()

    def init_ui(self):
        layout = QVBoxLayout()

        # Title Label
        info_label = QLabel("Press <b>F9</b> on keyboard anytime to run pipeline")
        info_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        info_label.setStyleSheet("font-size: 13px; color: #1976D2; padding: 5px;")
        layout.addWidget(info_label)

        # Region Buttons
        self.btn_text_region = QPushButton("1. Select Text Scan Region")
        self.btn_text_region.clicked.connect(lambda: self.open_selector('text_region'))
        layout.addWidget(self.btn_text_region)

        self.btn_sprite_region = QPushButton("2. Select Sprite Scan Region")
        self.btn_sprite_region.clicked.connect(lambda: self.open_selector('sprite_region'))
        layout.addWidget(self.btn_sprite_region)

        self.btn_input_region = QPushButton("3. Select Input Field Region (Optional)")
        self.btn_input_region.clicked.connect(lambda: self.open_selector('input_region'))
        layout.addWidget(self.btn_input_region)

        # Directory Pickers
        self.btn_text_folder = QPushButton("4. Select Text Folder")
        self.btn_text_folder.clicked.connect(self.select_text_folder)
        layout.addWidget(self.btn_text_folder)

        self.btn_sprite_folder = QPushButton("5. Select Sprite Folder")
        self.btn_sprite_folder.clicked.connect(self.select_sprite_folder)
        layout.addWidget(self.btn_sprite_folder)

        self.btn_submit_img = QPushButton("6. Select Submit Button Template")
        self.btn_submit_img.clicked.connect(self.select_submit_image)
        layout.addWidget(self.btn_submit_img)

        # Execution Controls
        btn_box = QHBoxLayout()
        self.btn_run = QPushButton("RUN PIPELINE (F9)")
        self.btn_run.setStyleSheet("background-color: #2E7D32; color: white; font-weight: bold; padding: 10px;")
        self.btn_run.clicked.connect(self.run_automation)
        
        self.btn_save = QPushButton("SAVE SETTINGS")
        self.btn_save.setStyleSheet("background-color: #1565C0; color: white; font-weight: bold; padding: 10px;")
        self.btn_save.clicked.connect(self.save_config)

        btn_box.addWidget(self.btn_run)
        btn_box.addWidget(self.btn_save)
        layout.addLayout(btn_box)

        # Log Output
        self.log_box = QTextEdit()
        self.log_box.setReadOnly(True)
        layout.addWidget(self.log_box)

        self.setLayout(layout)
        self.update_button_labels()

    def log(self, message):
        self.log_box.append(f"[{time.strftime('%H:%M:%S')}] {message}")

    def init_hotkey(self):
        self.hotkey_thread = HotkeyWorker()
        self.hotkey_thread.triggered.connect(self.run_automation)
        self.hotkey_thread.start()

    def update_button_labels(self):
        if self.config["text_region"]:
            self.btn_text_region.setText(f"Text Region: {self.config['text_region']}")
        if self.config["sprite_region"]:
            self.btn_sprite_region.setText(f"Sprite Region: {self.config['sprite_region']}")
        if self.config["input_region"]:
            self.btn_input_region.setText(f"Input Region: {self.config['input_region']}")
        if self.config["text_folder"]:
            self.btn_text_folder.setText(f"Text Folder: ...{self.config['text_folder'][-25:]}")
        if self.config["sprite_folder"]:
            self.btn_sprite_folder.setText(f"Sprite Folder: ...{self.config['sprite_folder'][-25:]}")
        if self.config["submit_image_path"]:
            self.btn_submit_img.setText(f"Submit Img: ...{self.config['submit_image_path'][-25:]}")

    # --- CONFIGURATION PERSISTENCE ---
    def save_config(self):
        try:
            with open(CONFIG_FILE, "w") as f:
                json.dump(self.config, f, indent=4)
            self.log("[SUCCESS] Config saved to config.json")
        except Exception as e:
            self.log(f"[ERROR] Failed to save config: {e}")

    def load_config(self):
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r") as f:
                    saved = json.load(f)
                    self.config.update(saved)
            except Exception as e:
                print(f"Error loading config: {e}")

    # --- REGION AND ASSET SELECTION HANDLERS ---
    def open_selector(self, key_name):
        from PyQt6.QtWidgets import QMessageBox

        self.hide()
        time.sleep(0.2)

        # Step 1: tell the user we'll start at the top-left corner.
        msg1 = QMessageBox()
        msg1.setWindowTitle("Select Region")
        msg1.setText("Region: TOP-LEFT CORNER\n\n"
                     "Position the mouse over the top-left corner of the area, "
                     "then press OK.")
        msg1.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
        ok = msg1.exec()
        if ok != QMessageBox.StandardButton.Ok:
            self.show()
            return
        time.sleep(0.2)
        x1, y1 = pyautogui.position()

        # Step 2: bottom-right corner.
        msg2 = QMessageBox()
        msg2.setWindowTitle("Select Region")
        msg2.setText("Region: BOTTOM-RIGHT CORNER\n\n"
                     "Now position the mouse over the bottom-right corner of the "
                     "area, then press OK.")
        msg2.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
        ok2 = msg2.exec()
        if ok2 != QMessageBox.StandardButton.Ok:
            self.show()
            return
        time.sleep(0.2)
        x2, y2 = pyautogui.position()

        left = min(x1, x2)
        top = min(y1, y2)
        width = abs(x2 - x1)
        height = abs(y2 - y1)
        region = [left, top, width, height]
        self.log(f"[SET] {key_name} -> {region}")
        self.config[key_name] = region
        self.update_button_labels()
        self.show()

    def select_text_folder(self):
        folder = QFileDialog.getExistingDirectory(self, "Select Folder Containing Text Label Images")
        if folder:
            self.config["text_folder"] = folder
            self.update_button_labels()
            self.log(f"[SET] Text Folder -> {folder}")

    def select_sprite_folder(self):
        folder = QFileDialog.getExistingDirectory(self, "Select Folder Containing Sprite Images")
        if folder:
            self.config["sprite_folder"] = folder
            self.update_button_labels()
            self.log(f"[SET] Sprite Folder -> {folder}")

    def select_submit_image(self):
        file, _ = QFileDialog.getOpenFileName(self, "Select Submit Button Image", "", "Images (*.png *.jpg)")
        if file:
            self.config["submit_image_path"] = file
            self.update_button_labels()
            self.log(f"[SET] Submit Image -> {file}")

    # --- OPENCV MULTI-TARGET DETECTION WITH NMS ---
    def count_sprites_nms(self, scene_bgr, template_path, threshold=0.80, nms_threshold=0.3):
        template = cv2.imread(template_path, cv2.IMREAD_COLOR)
        if template is None:
            return 0

        th, tw, _ = template.shape
        result = cv2.matchTemplate(scene_bgr, template, cv2.TM_CCOEFF_NORMED)
        
        y_idxs, x_idxs = np.where(result >= threshold)
        boxes = []
        scores = []

        for x, y in zip(x_idxs, y_idxs):
            boxes.append([int(x), int(y), int(tw), int(th)])
            scores.append(float(result[y, x]))

        if not boxes:
            return 0

        # Eliminate duplicate hits over the same physical sprite using NMS
        indices = cv2.dnn.NMSBoxes(boxes, scores, score_threshold=threshold, nms_threshold=nms_threshold)
        return len(indices)

    # --- FULL EXECUTION PIPELINE ---
    def run_automation(self):
        # Validation
        if not self.config["text_region"] or not self.config["sprite_region"]:
            self.log("[ERROR] Set both Text and Sprite regions first.")
            return

        if not self.config["text_folder"] or not self.config["sprite_folder"]:
            self.log("[ERROR] Set both Text and Sprite image folders first.")
            return

        self.log("--- Starting Pipeline Execution ---")

        # 1. Capture & Detect Text Label
        tx, ty, tw, th = self.config["text_region"]
        text_shot = pyautogui.screenshot(region=(tx, ty, tw, th))
        text_bgr = cv2.cvtColor(np.array(text_shot), cv2.COLOR_RGB2BGR)

        detected_animal = None

        for file in os.listdir(self.config["text_folder"]):
            if file.lower().endswith(('.png', '.jpg', '.jpeg')):
                img_path = os.path.join(self.config["text_folder"], file)
                template = cv2.imread(img_path, cv2.IMREAD_COLOR)
                if template is None:
                    continue

                res = cv2.matchTemplate(text_bgr, template, cv2.TM_CCOEFF_NORMED)
                _, max_val, _, _ = cv2.minMaxLoc(res)

                if max_val >= 0.80:
                    detected_animal = os.path.splitext(file)[0]
                    self.log(f"[STEP 1] Detected target text: '{detected_animal}' (Score: {max_val:.2f})")
                    break

        if not detected_animal:
            self.log("[FAILED] No text image matched in the designated region.")
            return

        # 2. Capture & Count Matching Sprites
        sx, sy, sw, sh = self.config["sprite_region"]
        sprite_shot = pyautogui.screenshot(region=(sx, sy, sw, sh))
        sprite_bgr = cv2.cvtColor(np.array(sprite_shot), cv2.COLOR_RGB2BGR)

        sprite_file = f"{detected_animal}.png"
        sprite_path = os.path.join(self.config["sprite_folder"], sprite_file)

        if not os.path.exists(sprite_path):
            self.log(f"[ERROR] Sprite file missing: {sprite_file}")
            return

        count = self.count_sprites_nms(sprite_bgr, sprite_path, threshold=0.80)
        self.log(f"[STEP 2] Counted {count} instances of '{detected_animal}'.")

        # 3. Copy Result to Clipboard
        pyperclip.copy(str(count))
        self.log(f"[STEP 3] Copied result '{count}' to clipboard.")

        # 4. Optional: Click Input Field & Paste Result
        if self.config["input_region"]:
            ix, iy, iw, ih = self.config["input_region"]
            click_x = ix + (iw // 2)
            click_y = iy + (ih // 2)

            pyautogui.click(click_x, click_y)
            time.sleep(0.1)
            pyautogui.hotkey('ctrl', 'v')
            self.log(f"[STEP 4] Pasted count into input box at ({click_x}, {click_y}).")

        # 5. Optional: Detect & Click Submit Button
        if self.config["submit_image_path"] and os.path.exists(self.config["submit_image_path"]):
            time.sleep(0.1)
            full_screen = pyautogui.screenshot()
            full_bgr = cv2.cvtColor(np.array(full_screen), cv2.COLOR_RGB2BGR)
            sub_template = cv2.imread(self.config["submit_image_path"], cv2.IMREAD_COLOR)
            sh_h, sh_w, _ = sub_template.shape

            res = cv2.matchTemplate(full_bgr, sub_template, cv2.TM_CCOEFF_NORMED)
            _, max_val, _, max_loc = cv2.minMaxLoc(res)

            if max_val >= 0.80:
                sub_x = max_loc[0] + (sh_w // 2)
                sub_y = max_loc[1] + (sh_h // 2)
                pyautogui.click(sub_x, sub_y)
                self.log(f"[STEP 5] Clicked Submit button at ({sub_x}, {sub_y}).")
            else:
                self.log("[WARNING] Could not locate Submit button on screen.")

        self.log("--- Pipeline Complete ---\n")

# --- SCRIPT ENTRY POINT ---
if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = MacroApp()
    window.show()
    sys.exit(app.exec())
