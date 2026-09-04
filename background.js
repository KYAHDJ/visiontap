let isLoopRunning = false;
let isProcessing = false;
let loopStartTime = null;
let taskCount = 0;
let currentSourceTabId = null;
let loopStopRequested = false;

const SCANNER_URL = "http://127.0.0.1:5555";

// ---- Failsafe config ----
const IDLE_REFRESH_MS = 60000;      // 1-min: if no scan/paste action, refresh page & retry
const FINAL_STALL_MS = 120000;      // 2-min final failsafe via keeper
let lastActionTs = 0;               // last time we did real work (scan/paste/refresh)
let lastProgressTs = 0;             // progress timestamp pushed to keeper
let lastSubmittedImageHash = null;  // hash of the image we last submitted on

// Simple deterministic hash for image identity (byte-order independent of string).
function hashImage(dataUrl) {
  if (!dataUrl) return null;
  const s = dataUrl.slice(dataUrl.indexOf(',') + 1);
  let h = 0;
  // Sample across the whole string to keep it cheap on large base64 data.
  const step = Math.max(1, Math.floor(s.length / 512));
  for (let i = 0; i < s.length; i += step) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

// ---- Live timer ----
let hudTimer = null;

// ---- Keeper (final failsafe) integration ----
const KEEPER_HEARTBEAT_URL = "http://127.0.0.1:8177/heartbeat";
const KEEPER_COMMAND_URL = "http://127.0.0.1:8177/command";
const HEARTBEAT_MS = 8000;
const COMMAND_POLL_MS = 5000;
let heartbeatTimer = null;
let commandTimer = null;

// ---- Alt+M command handler ----
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "trigger-scan") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes("ecnlmediamarket.com")) {
      toggleLoop(tab.id);
    }
  }
});

// ---- Message handler ----
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "trigger_scan") {
    const tabId = request.tabId || sender.tab?.id;
    if (tabId) toggleLoop(tabId);
    sendResponse({ status: isLoopRunning ? "running" : "stopped" });
    return true;
  }

  if (request.action === "manual_stop") {
    stopLoop(request.tabId || sender.tab?.id, "Stopped by user.");
    sendResponse({ status: "stopped" });
    return true;
  }

  if (request.action === "ecnl_stale_refresh") {
    console.warn("[VisionTap] ECNL page reported stale. Refreshing...");
    refreshECNL();
    sendResponse({ status: "refreshing" });
    return true;
  }

  if (request.action === "check_scanner") {
    checkScanner().then(ok => sendResponse({ online: ok }));
    return true;
  }

  return true;
});

function toggleLoop(tabId) {
  if (isLoopRunning) {
    stopLoop(tabId, "Stopped by user.");
  } else {
    startLoop(tabId);
  }
}

// ---- Loop control ----
function startLoop(tabId) {
  if (isLoopRunning) return;
  isLoopRunning = true;
  isProcessing = false;
  loopStopRequested = false;
  loopStartTime = Date.now();
  taskCount = 0;
  lastSubmittedImageHash = null;
  currentSourceTabId = tabId;
  touchAction();
  touchProgress();
  startLiveTimer();
  startKeeperClients();
  updateHUD(`Loop started. Starting scan...`, true);
  runIteration();
}

function stopLoop(tabId, reason) {
  isLoopRunning = false;
  isProcessing = false;
  loopStopRequested = true;
  stopLiveTimer();
  stopKeeperClients();
  updateHUD(`Stopped: ${reason}`, false);
}

// ---- Live per-second timer ----
function startLiveTimer() {
  stopLiveTimer();
  hudTimer = setInterval(() => {
    if (!isLoopRunning) return;
    const elapsed = loopStartTime ? Math.floor((Date.now() - loopStartTime) / 1000) : 0;
    const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const seconds = String(elapsed % 60).padStart(2, '0');
    broadcastHUD({
      timerText: `${minutes}:${seconds}`,
      tasksCompleted: taskCount,
      isRunning: true
    });
  }, 1000);
}

function stopLiveTimer() {
  if (hudTimer) clearInterval(hudTimer);
  hudTimer = null;
}

// ---- Progress / action tracking ----
function touchAction() { lastActionTs = Date.now(); }
function touchProgress() { lastProgressTs = Date.now(); }

// ---- Keeper final failsafe clients ----
function startKeeperClients() {
  stopKeeperClients();
  flushKeeperCommand();
  heartbeatTimer = setInterval(sendKeeperHeartbeat, HEARTBEAT_MS);
  commandTimer = setInterval(pollKeeperCommand, COMMAND_POLL_MS);
  sendKeeperHeartbeat();
}
function stopKeeperClients() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (commandTimer) clearInterval(commandTimer);
  commandTimer = null;
}

async function sendKeeperHeartbeat() {
  try {
    await fetch(KEEPER_HEARTBEAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ progress: lastProgressTs || 0 }),
      cache: "no-store"
    });
  } catch (e) { /* keeper not running */ }
}

async function pollKeeperCommand() {
  try {
    const res = await fetch(KEEPER_COMMAND_URL, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.command === "reset" && isLoopRunning) {
      console.warn("[VisionTap] External 2-min failsafe triggered reset. Restarting everything.");
      hardRestart();
    }
  } catch (e) { /* keeper not running */ }
}

async function flushKeeperCommand() {
  try { await fetch(KEEPER_COMMAND_URL, { cache: "no-store" }); } catch (e) { /* ignore */ }
}

// ---- Task report to local form sender (Google Form) ----
// Fire-and-forget: never blocks or delays the loop. POSTs the task result to
// the scanner's /report endpoint, which forwards it to the Google Form.
async function sendTaskReport(payload) {
  try {
    // Best-effort battery read from the keeper (128 chars cheap local call).
    let battery = null;
    try {
      const b = await fetch("http://127.0.0.1:8177/battery", { cache: "no-store" });
      const j = await b.json();
      battery = j && j.battery != null ? j.battery : null;
    } catch (e) {}
    const report = Object.assign({}, payload, { battery });
    await fetch(`${SCANNER_URL}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      cache: "no-store"
    });
  } catch (e) { /* offline/busy - report skipped, loop unaffected */ }
}

// After submit, give ECNL ~2.5s to post Correct/Wrong feedback, read it plus
// the task's withdrawable/points meta, then send the report. Runs on its own
// timer so the loop isn't blocked. Missing values are sent as null.
function captureAndSendReport(tabId, report) {
  setTimeout(async () => {
    let correct = null, theirs = null, withdrawable = null, pointsDone = null, pointsTotal = null;
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { action: "get_verdict" });
      if (resp) {
        correct = resp.correct == null ? null : !!resp.correct;
        theirs = resp.theirs || null;
      }
    } catch (e) {}
    try {
      const meta = await chrome.tabs.sendMessage(tabId, { action: "get_task_meta" });
      if (meta) {
        withdrawable = meta.withdrawable != null ? String(meta.withdrawable) : null;
        pointsDone = meta.pointsDone != null ? String(meta.pointsDone) : null;
        pointsTotal = meta.pointsTotal != null ? String(meta.pointsTotal) : null;
      }
    } catch (e) {}
    sendTaskReport(Object.assign({}, report, { correct, theirs, withdrawable, pointsDone, pointsTotal }));
  }, 2500);
}


// ---- Hard restart (final failsafe): reload all ECNL + restart loop from 0 ----
async function hardRestart() {
  const wasRunning = isLoopRunning;
  isLoopRunning = false;
  isProcessing = false;
  stopLiveTimer();
  stopKeeperClients();

  let ecnlTabId = currentSourceTabId;
  try {
    const tabs = await chrome.tabs.query({});
    const reloadTargets = [];
    for (const t of tabs) {
      if (t.url && t.url.includes("ecnlmediamarket.com")) {
        reloadTargets.push(t.id);
        if (ecnlTabId == null) ecnlTabId = t.id;
      }
    }
    await Promise.all(reloadTargets.map(id => chrome.tabs.reload(id).catch(() => {})));
  } catch (e) {}

  if (!wasRunning) return;

  // Wait for pages to reload, then restart the loop from scratch.
  setTimeout(() => {
    if (loopStopRequested || !wasRunning) return;
    isLoopRunning = true;
    isProcessing = false;
    loopStartTime = Date.now();
    taskCount = 0;
    lastSubmittedImageHash = null;
    currentSourceTabId = ecnlTabId;
    touchAction();
    touchProgress();
    startLiveTimer();
    startKeeperClients();
    updateHUD("[Failsafe] Tabs refreshed. Restarting loop...", true);
    runIteration();
  }, 5000);
}

// ---- Refresh ECNL tab(s) ----
async function refreshECNL() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.url && t.url.includes("ecnlmediamarket.com")) {
        chrome.tabs.reload(t.id).catch(() => {});
      }
    }
  } catch (e) {}
}

// ---- HUD helpers ----
async function broadcastHUD(partial) {
  const elapsed = loopStartTime ? Math.floor((Date.now() - loopStartTime) / 1000) : 0;
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const seconds = String(elapsed % 60).padStart(2, '0');
  const hudData = {
    action: "update_hud",
    statusText: partial.statusText || previousStatus || "Idle.",
    timerText: partial.timerText || `${minutes}:${seconds}`,
    tasksCompleted: partial.tasksCompleted !== undefined ? partial.tasksCompleted : taskCount,
    isRunning: partial.isRunning !== undefined ? partial.isRunning : isLoopRunning
  };
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id && (t.url || "").includes("ecnlmediamarket.com")) {
        try {
          await chrome.tabs.sendMessage(t.id, hudData);
        } catch (e) {
          try {
            await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["task_script.js"] });
            await chrome.tabs.sendMessage(t.id, hudData);
          } catch (e2) {}
        }
      }
    }
  } catch (e) {}
}

let previousStatus = "";

function updateHUD(statusText, isRunning) {
  previousStatus = statusText;
  broadcastHUD({ statusText, isRunning });
}

// ---- Scanner server health check ----
async function checkScanner() {
  try {
    const res = await fetch(`${SCANNER_URL}/health`, { cache: "no-store" });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// ---- Main loop iteration ----
async function runIteration() {
  if (!isLoopRunning || isProcessing) return;
  isProcessing = true;

  const tabId = await getActiveECNLTab();
  if (!tabId) {
    updateHUD("No ECNL tab found. Waiting...", true);
    isProcessing = false;
    scheduleNext(0);
    return;
  }
  currentSourceTabId = tabId;

  // Per-task phase timing (seconds). wait = time until answer box is ready,
  // scan = upload+detect round trip, paste = fill+submit.
  const tWaitStart = Date.now();
  let tWaitSec = 0, tScanSec = 0, tPasteSec = 0;
  let tScanStart = 0, tPasteStart = 0;

  try {
    // STEP A: Wait until the answer input box EXISTS (task is loaded & ready).
    // Only then do we detect. This avoids wasting cycles on stale/transition
    // screens that show an old image before the task loads.
    const inputReady = await waitForInputBox(tabId);
    tWaitSec = Math.round((Date.now() - tWaitStart) / 1000);
    if (!inputReady) {
      // Timed out / could not confirm input box -> refresh & retry.
      updateHUD("Input box not found. Refreshing page...", true);
      touchAction();
      refreshECNL();
      isProcessing = false;
      scheduleNext(4000);
      return;
    }

    // Scanner online check
    updateHUD(`[${taskCount + 1}] Task ready. Checking scanner...`, true);
    const scannerOnline = await checkScanner();
    if (!scannerOnline) {
      updateHUD("Scanner OFFLINE. Run pcapp/scanner/start.bat", false);
      isProcessing = false;
      scheduleNext(5000);
      return;
    }

    // Grab the task image
    updateHUD(`[${taskCount + 1}] Grabbing task image...`, true);
    tScanStart = Date.now();
    let imageData = null;
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { action: "grab_image", nukeAds: true });
      imageData = resp && resp.imageData;
    } catch (e) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["task_script.js"] });
        const resp2 = await chrome.tabs.sendMessage(tabId, { action: "grab_image", nukeAds: true });
        imageData = resp2 && resp2.imageData;
      } catch (e2) {
        imageData = null;
      }
    }

    if (!imageData) {
      updateHUD(`[${taskCount + 1}] No image. Retrying...`, true);
      touchAction();
      isProcessing = false;
      scheduleNext(1500);
      return;
    }

    // Image-change gate: if this is the same image we already answered on,
    // it's a stale transition screen -- do NOT detect again, keep waiting
    // for the real next task.
    const curHash = hashImage(imageData);
    if (lastSubmittedImageHash !== null && curHash === lastSubmittedImageHash) {
      updateHUD("Same task image still showing. Waiting for next task...", false);
      isProcessing = false;
      scheduleNext(2000);
      return;
    }

    const imgSizeKB = Math.round((imageData.length * 3 / 4) / 1024);
    updateHUD(`[${taskCount + 1}] Image (${imgSizeKB}KB). Detecting...`, true);
    touchAction();

    // Detect via scanner
    let result;
    try {
      const scanRes = await fetch(`${SCANNER_URL}/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: imageData })
      });
      result = await scanRes.json();
    } catch (e) {
      updateHUD(`[${taskCount + 1}] Scanner connection failed.`, true);
      isProcessing = false;
      scheduleNext(3000);
      return;
    }
    tScanSec = Math.round((Date.now() - tScanStart) / 1000);

    if (result.error) {
      updateHUD(`[${taskCount + 1}] Detection failed: ${result.message || result.error}`, true);
      isProcessing = false;
      scheduleNext(1500);
      return;
    }

    const animal = result.animal;
    const count = result.count;
    taskCount++;
    lastSubmittedImageHash = curHash; // remember the image we just answered on
    updateHUD(`[${taskCount}] DETECTED ${count} ${animal}(s). Pasting...`, true);

    // Fill the answer
    tPasteStart = Date.now();
    let pasted = false;
    try {
      await chrome.tabs.sendMessage(tabId, { action: "fill_answer", answer: String(count) });
      pasted = true;
    } catch (e) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["task_script.js"] });
        await chrome.tabs.sendMessage(tabId, { action: "fill_answer", answer: String(count) });
        pasted = true;
      } catch (e2) {}
    }
    tPasteSec = Math.round((Date.now() - tPasteStart) / 1000);

    // Fire-and-forget report to the local form sender (Google Form). Deferred
    // a couple seconds so ECNL can post its Correct/Wrong feedback, which we
    // capture for the accuracy percentage. This runs while the loop is already
    // waiting for the next task, so it never slows anything down.
    const report = {
      questionId: curHash != null ? String(curHash) : String(taskCount),
      taskNum: taskCount,
      animal,
      count,
      image: imageData,
      tWaitSec, tScanSec, tPasteSec,
      totalSec: tWaitSec + tScanSec + tPasteSec,
      pasted,
      ts: Date.now()
    };
    captureAndSendReport(tabId, report);

    updateHUD(`[${taskCount}] Submitted: ${count} ${animal}(s). Waiting for next task...`, false);
    touchAction();
    touchProgress();

    isProcessing = false;
    scheduleNext(2000);
    return;

  } catch (err) {
    console.error("[VisionTap] Iteration error:", err);
    updateHUD(`[${taskCount + 1}] Error: ${err.message}`, true);
    isProcessing = false;
    scheduleNext(3000);
  }
}

// Poll for the answer input box (task ready). Returns true once present.
async function waitForInputBox(tabId) {
  const deadline = Date.now() + 120000; // up to 2 min for a task to load
  let lastHud = 0;
  while (isLoopRunning && Date.now() < deadline) {
    let ready = false;
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { action: "check_input_ready" });
      ready = !!(resp && resp.ready);
    } catch (e) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["task_script.js"] });
        const resp2 = await chrome.tabs.sendMessage(tabId, { action: "check_input_ready" });
        ready = !!(resp2 && resp2.ready);
      } catch (e2) {
        ready = false;
      }
    }
    if (ready) return true;
    // Update HUD periodically so it's clear we're waiting for the next task.
    if (Date.now() - lastHud > 3000) {
      lastHud = Date.now();
      updateHUD(`Waiting for next task's input box...`, true);
    }
    touchProgress(); // we are actively waiting, keep the watchdog happy
    await sleep(1000);
  }
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getActiveECNLTab() {
  try {
    const tabs = await chrome.tabs.query({});
    const isWorkPage = (url) => /solving-animals|solving-math/.test(url || "");
    const ecnl = tabs.find(t => t.url && t.url.includes("ecnlmediamarket.com") && t.active);
    if (ecnl) {
      // ECNL non-work page failsafe: if it ever lands on /dashboard or anywhere
      // else, force it straight back to /solving-animals.
      if (!isWorkPage(ecnl.url)) {
        console.warn("[VisionTap] ECNL tab on non-work page, forcing /solving-animals:", ecnl.url);
        return ensureWorkPage(ecnl.id);
      }
      return ecnl.id;
    }
    const any = tabs.find(t => t.url && t.url.includes("ecnlmediamarket.com"));
    if (any && !isWorkPage(any.url)) {
      return ensureWorkPage(any.id);
    }
    return any ? any.id : null;
  } catch (e) {
    return null;
  }
}

// Navigate the tab to /solving-animals and wait for it to settle. Returns the
// tab id once loaded (used as a self-healing guard). Best effort.
async function ensureWorkPage(tabId) {
  try {
    await chrome.tabs.update(tabId, { url: "https://ecnlmediamarket.com/solving-animals" });
    await sleep(3000);
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["task_script.js"] });
    } catch (e2) {}
  } catch (e) {
    console.warn("[VisionTap] ensureWorkPage failed:", e);
  }
  return tabId;
}

// ---- Scheduling + 1-min inactivity failsafe ----
function scheduleNext(delay) {
  if (!isLoopRunning) return;

  // 1-minute inactivity failsafe: if we've been idle (no scan/paste action)
  // for longer than IDLE_REFRESH_MS, refresh the page and continue.
  let d = delay;
  const idleFor = Date.now() - lastActionTs;
  if (idleFor >= IDLE_REFRESH_MS) {
    console.warn(`[VisionTap] No scan/paste action for ${idleFor}ms. Refreshing page.`);
    updateHUD(`No action for 1 min. Refreshing page...`, true);
    refreshECNL();
    touchAction();
    d = 4000;
  }

  setTimeout(runIteration, d);
}
