import sys, os
path = "/home/opc/VisionTap/slotbrowser/inject/slot_inject.js"
work = "/root/adpatch2_slot_inject.js"
s = open(path, encoding="utf-8").read()
if "google-anno" in s:
    print("already patched"); sys.exit(0)
anchor = "'.fc-monetization-dialog-container', '.fc-dialog-overlay', '.fc-ab-root', 'div[class*=\"fc-dialog\"]'"
assert s.count(anchor) == 1, "anchor matches: %d" % s.count(anchor)
s = s.replace(anchor, anchor + ",\n    '[class*=\"google-anno\"]', 'iframe[name^=\"google_ads\"]', 'iframe[id^=\"google_ads\"]', 'iframe[src*=\"safeframe\"]', 'iframe[src*=\"pagead\"]', 'iframe[src*=\"googletagservices\"]', 'ins[data-anchor-status]', 'ins[data-vignette-loaded]'")
open(work, "w", encoding="utf-8").write(s)
print("patched work copy")
