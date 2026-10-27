# VisionTap local color helper handoff

## Current state

The local VisionTap Chrome launcher and dedicated profile are working. The color helper was visually verified on the open color-task page before the remote deployment was paused. On the verified task, it identified shape 24 as yellow at row 4, column 6.

The remote page currently displays `This deployment is temporarily paused`. The `sin1::...` value is the host's changing request/error reference, not a VisionTap or account identifier. No local change can restore a paused remote deployment.

## How to start

Double-click `Start VisionTap Local Chrome.bat` in `C:\VisionTap` and enter the target website URL when prompted. It launches the installed Google Chrome using the dedicated profile at:

    C:\VisionTap\state\local-hide-profile

This profile is separate from the user's normal Chrome profile and is excluded from Git by the existing `state/` ignore rule.

The launcher must be restarted after helper source changes because page initialization scripts are registered when the Chrome context starts.

## Implemented behavior

- Hides visible `<p>` and `<footer>` elements only on the hostname entered into the launcher.
- Limits color-task inspection to one visible `div.flex.flex-col.gap-4` task container containing `.task-image svg`.
- Ignores hidden shapes and unrelated page elements.
- Reads the visible question number from the task heading.
- Orders SVG shapes by their visible positions: top-to-bottom rows, then left-to-right columns. SVG DOM order is not trusted.
- Supports visible `path`, `circle`, `ellipse`, `rect`, and `polygon` shapes.
- Maps displayed RGB fill colors to black, white, red, orange, yellow, green, blue, purple, pink, or brown.
- Reads the complete rendered task regardless of scroll position while still rejecting CSS-hidden elements.
- Refuses to answer when the grid is uneven, incomplete, the fill is ambiguous, or the color confidence is low.
- Scans every 250 ms so client-side task changes are detected without a reload.
- Fills `#task-answer` only when it is visible and empty.
- Dispatches normal `input` and `change` events after filling so the page recognizes the value.
- Waits until the task's visible `Submit` button is enabled, not ARIA-disabled, and accepts pointer events.
- Clicks Submit once for that exact input, SVG, task number, and answer combination.
- Prevents repeated clicks while the same task remains displayed.
- Resumes when a new empty task input appears or the current input is cleared for a new task.
- Shows a fixed top-right status panel with fill, waiting, submitted, or manual-check status.

## Files

- `Start VisionTap Local Chrome.bat` — double-click launcher.
- `slotbrowser/local-hide-test.js` — dedicated local Chrome startup and page initialization.
- `slotbrowser/local-color-helper.js` — visible-grid detection, color classification, loop, and empty-input filling.
- `slotbrowser/tests/local-color-helper.test.js` — verifies visible ordering, hidden-shape filtering, fill/pause/resume, ambiguous-color handling, and absence of submission calls.
- `slotbrowser/tests/local-hide-test.test.js` — verifies URL handling and visual hiding without element deletion.

The generic Chrome pilot also has an optional `VT_HIDE_CONTENT_HOSTS` setting documented in `SERVER.md`; it is disabled when unset.

## Verification completed

Run from `C:\VisionTap`:

    node --check slotbrowser/local-color-helper.js
    node --check slotbrowser/local-hide-test.js
    node --test slotbrowser/tests/local-color-helper.test.js slotbrowser/tests/local-hide-test.test.js

The focused suite passed: 3 tests, 0 failures. The earlier complete slotbrowser suite passed 41 tests before the input-fill addition. The input-fill change was then covered by its focused regression test.

## Continue from here

1. Wait until the remote task page no longer reports that its deployment is paused.
2. Close the existing local VisionTap Chrome window.
3. Start it again with `Start VisionTap Local Chrome.bat` so the latest fill-loop helper is registered.
4. Enter the task URL.
5. Confirm that an empty answer field is populated and the panel says `Filled — you submit`.
6. Submit manually. When the next empty task input appears, the helper should fill it automatically.

Automatic submission was explicitly requested after the fill-only workflow was verified.
