# VisionTap for Android — Automate Flow (Gemini Website Route)

Target device: Cherry Mobile A850 (Unisoc SC9832E, 32-bit, 2GB RAM, Android 10)
App: "Automate" by LlamaLab (free, Google Play). Uses Accessibility + screen blocks.
No root, no PC. Flow is built as blocks inside Automate (visual flowchart).

Rating: WORKS but FRAGILE. Coordinate taps must be calibrated to your exact screen.
Everything below is the authoritative reference. Build the blocks to match.

================================================================
1. MASTER PROMPT (paste into Gemini, alongside the image)
================================================================
Keep it identical to your desktop pipeline so behavior matches:

  Look at this image carefully. Solve the math problem or count the items shown.
  OUTPUT the positive digit numbers. Nothing else. No words, no explanation, no labels, no formatting.
  Just output the raw digit like: 7 or 1000 anything that is a number and the proper answer to the question in the image

NOTE: Gemini will still sometimes reply with [THINKING]... or [FINAL ANSWER: x] or extra words.
Adapt the "read answer" step (section 5) to strip that down to the number.

================================================================
2. PREREQUISITES on the tablet
================================================================
- Install "Automate" from Google Play.
- Open its Permissions flow: enable the Automate Accessibility service
  (Settings > Accessibility > Automate) and "Display over other apps".
- Have a browser with TWO tabs open and kept alive:
      Tab A = https://ecnlmediamarket.com
      Tab B = https://gemini.google.com
  Tip: a light Chromium browser (the one that didn't crash). Keep both pinned.
- Your Groq key is NOT used in this route (we go through Gemini's website).
- Verify the phone can take a screenshot via Automate:
      Automate > "Engine/Screen capture" block — must return a bitmap.
  Android 10 Play Store Automate supports the MediaProjection/Vulkan capture.
  Test ONE screenshot block manually before building the loop.

================================================================
3. FLOW LAYOUT (build these blocks, top to bottom)
================================================================
Below, [V] = value, [BLOCK] = Automate block name.

A. BLOCK: "Set variable"  screenshot_path  =  /storage/emulated/0/DCIM/vtasnappy.png
   BLOCK: "Set variable"  latest         =  (empty)
   BLOCK: "Loop" (forever)  << ENTER LOOP >>

B. BLOCK: "App start" / "Bring to front"  -> opens your BROWSER (ecnlmediamarket tab is assumed active)
   BLOCK: "Delay" 3000 ms

C. BLOCK: "Screen capture" -> store into variable "shot"
     Settings: capture full screen (MediaProjection). NOT "interact alone".
   BLOCK: "File write"  write "shot" bitmap to  screenshot_path

D. -- Open Gemini in the SAME browser, switch to Tab B --
   BLOCK: "Interact" tap -> on the browser's TAB SWITCHER button (calibrate X,Y)
   BLOCK: "Delay" 1500
   BLOCK: "Interact" tap -> on the Gemini TAB (calibrate X,Y)
   BLOCK: "Delay" 2500

E. -- Attach the image to Gemini --
   IMPORTANT: On Android, pasting a raw image into Gemini's web chat is unreliable.
   The most reliable route is the PAPERCLIP / file-upload dialog:
   BLOCK: "Interact" tap -> on Gemini's input area (calibrate X,Y)
   BLOCK: "Interact" tap -> on the "+"/paperclip (attach) icon (calibrate X,Y)
   BLOCK: "Interact" tap -> on "Files"/"Photos"/"Browse" (calibrate)
   BLOCK: "Interact" tap -> on screenshot_path file entry (calibrate)
   BLOCK: "Delay" 3000  (let it upload)

   FAILBACK: If Gemini shows no attach icon, use clipboard paste:
     BLOCK: "Set clipboard" text -> (trigger)
     BLOCK: "Interact" long-press -> input area, then tap "Paste"
     (This is the fragile path. Prefer the paperclip route.)

F. -- Send the prompt --
   BLOCK: "Interact" focus input
   BLOCK: "Interact" type -> text = MASTER PROMPT (section 1)
   BLOCK: "Delay" 500
   BLOCK: "Interact" tap -> on Gemini's SEND button (calibrate X,Y)
   BLOCK: "Variable" isGeneratingStart = now

G. -- Wait for Gemini to finish --
   BLOCK: "Loop while" (repeat) do [ Delay 1000 ; check "Stop" button still visible via accessibility ]
           Until the response has a "Copy" button OR a Stop button disappears.
   (Calibrate a sensible max time, e.g. 90s.)

H. -- Read the last Gemini reply --
   BLOCK: "Interact" tap -> on the "Copy" button of the LAST Gemini response (calibrate)
   BLOCK: "Delay" 700
   BLOCK: "Clipboard" read -> into "raw"
   BLOCK: "Variable" set raw = trim(raw)
   --> Adaptive extraction:
       "Variable" expression: match(raw, '[1-9]\d*') -> number
       If no match, fall back to the whole trimmed text (Gemini may have put words around it).

I. -- Back to ECNL tab, fill + submit --
   BLOCK: "Interact" tap -> browser TAB SWITCHER (calibrate X,Y)
   BLOCK: "Delay" 1200
   BLOCK: "Interact" tap -> on the ECNL TAB (calibrate X,Y)
   BLOCK: "Delay" 3000

   BLOCK: "Interact" focus -> the answer input field (calibrate X,Y or use accessibility bounds)
   BLOCK: "Interact" type -> text = number (from extract)
   BLOCK: "Delay" 300
   BLOCK: "Interact" tap -> SUBMIT button (calibrate X,Y)

J. -- Clear / advance for next task --
   BLOCK: "Interact" tap -> "Next Task"/refresh button OR reload page (calibrate)
   BLOCK: "Delay" 1500

K. -- Back to loop top --
   BLOCK: "End loop"

================================================================
4. PEAK FRAGILE POINTS (THE THINGS THAT WILL BREAK)
================================================================
1) Gemini image upload (paperclip) — coordinate taps to file picker are the least
   stable. Test section E in isolation on your tablet first.
2) Reading Gemini's reply (section H) — Gemini on mobile may render without a
   discrete "Copy" button per response. Then you must read the visible text via
   OCR (Automate "OCR text" block on a screenshot of the Gemini pane) and regex it.
3) Browser-internal TAB SWITCHING — coordinate taps assume tab positions. If tabs
   reorder or close, breaks. Use a browser with STABLE tab positions.
4) 2GB RAM / SC9832E slowness — increase all "Delay" values on the old tablet.
   Screenshots + OCR + media + Gemini may be slow. Start delays generous.

================================================================
5. FAILSAFE fallback for reading the answer
================================================================
If H can't find a Copy button reliably, replace H with:
   BLOCK: "Screen capture" (Gemini pane only)
   BLOCK: "OCR text" -> "recognized"
   "Variable" expression: match(recognized, '[1-9]\d*')
   -- take the LAST number in the pane (Gemini's answer is the final message)

================================================================
6. IMPORTANT LIMITATIONS (so you don't over-invest)
================================================================
- This is bounds/coordinate GUI automation. Changing Gemini/Ecnl page layout, resizing
  the browser window, or tab reordering will break taps and require recalibration.
- It is strictly heavier and more fragile than the desktop extension you already have.
- Automate free edition: fine for a single loop. Paid removes some limits if you
  need many devices/time limits.

================================================================
7. Calibration checklist on the A850 — do THIS first before trusting the loop
================================================================
[ ] Enable Automate Accessibility + overlay (prereq).
[ ] Verify ONE "Screen capture" block returns a real bitmap (section 2 test).
[ ] Manually verify Gemini accepts the screenshot via the paperclip route once.
[ ] Manually capture the X,Y of: tab switcher, Gemini tab, Gemini input,
    attach icon, Send button, Copy button, ECNL input, ECNL submit, Next.
[ ] Run a single iteration in Automate's "step through" / execute-one mode.
[ ] Then enable the forever loop.