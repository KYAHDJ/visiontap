import sys, shutil, os, re

base = "/home/opc/VisionTap/slotbrowser/inject/"
work = "/root/adpatch/"
os.makedirs(work, exist_ok=True)

def load(name):
    return open(base + name, encoding="utf-8").read()

def save_work(name, text):
    open(work + name, "w", encoding="utf-8").write(text)

# ---- slot_inject.js ----
s = load("slot_inject.js")
if "fc-monetization-dialog-container" in s:
    print("slot_inject.js already patched")
else:
    old_text = "txt.includes('unlock more contents')"
    assert s.count(old_text) == 1, "unlock text matches: %d" % s.count(old_text)
    s = s.replace(old_text, "txt.includes('unlock more content') || txt.includes('take action to continue')")
    old_sel = "'div[class*=\"allow-ads\"]', 'div[id*=\"allow-ads\"]', 'div[class*=\"please-allow\"]'"
    assert s.count(old_sel) == 1, "selector anchor matches: %d" % s.count(old_sel)
    s = s.replace(old_sel, old_sel + ",\n    'iframe[src*=\"googlesyndication\"]', 'iframe[src*=\"doubleclick\"]', 'iframe[src*=\"adservice\"]', 'div[id^=\"aswift\"]',\n    '.fc-monetization-dialog-container', '.fc-dialog-overlay', '.fc-ab-root', 'div[class*=\"fc-dialog\"]'")
    save_work("slot_inject.js", s)
    print("slot_inject.js patched (work copy)")

# ---- ad_blocker.js ----
a = load("ad_blocker.js")
if "unlock more content'" in a and "unlock more contents'" not in a:
    print("ad_blocker.js already patched")
else:
    assert a.count("txt.includes('unlock more contents')") == 1
    a = a.replace("txt.includes('unlock more contents')", "txt.includes('unlock more content') || txt.includes('take action to continue')")
    save_work("ad_blocker.js", a)
    print("ad_blocker.js patched (work copy)")
