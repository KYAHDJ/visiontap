# VisionTap — Chrome Extension (Manifest V3)

Captures the current Chrome tab, sends a screenshot to the **Groq Vision API**,
extracts the numeric digits in the encoding box, auto-fills the input, and
submits the answer on `ecnlmediamarket.com`.

Dependency-free (no build step, no npm). Load it directly via **Load unpacked**.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select this folder (`C:\VisionTap`)
4. Open the **VisionTap** popup, paste your **Groq API key**, pick a model, click **Save Key**

## Usage

- Click the **VisionTap** toolbar icon → **Scan & Auto-Fill**, **or**
- Press **Alt + S** on `ecnlmediamarket.com` (shortcut shown in the popup)

The flow: screenshot → Groq Vision (`llama-3.2-11b-vision-instruct`, or
`qwen/qwen3.6-27b` for higher accuracy) → digits extracted → `content.js` fills
the input and clicks Submit.

> Note: `llama-3.2-90b-vision-instruct` is **not** served by Groq (returns 404),
> and the old `*-vision-preview` models are decommissioned. The extension
> auto-migrates any stale/unsupported model IDs to `llama-3.2-11b-vision-instruct`.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest: `activeTab`, `scripting`, `storage`; `Alt+S` command; content script host matches |
| `popup.html` / `popup.js` | Trigger scan; store Groq API key & model in `chrome.storage.local` |
| `background.js` | Service worker: `captureVisibleTab` → downscale → Base64 → Groq API; relays digits to content script; handles `Alt+S` |
| `content.js` | Finds the encoding input, sets the value via the native setter (so React/Vue register it), dispatches `input`/`change`, clicks Submit |

## Notes

- The API key is stored locally in `chrome.storage.local` on your own device.
- Screenshots are sent only to the Groq API endpoint you authenticated to.
- This is a manual, per-invocation tool (popup click or `Alt+S`), not an
  autonomous/looping solver.
