let isLoopRunning = false;
let isProcessing = false;
const SCANNER_URL = "http://127.0.0.1:5566";
const POLL_INTERVAL = 5000;
const IDLE_CHECK_INTERVAL = 15000;

let stats = {
  correct: 0,
  wrong: 0,
  error: 0,
  total: 0,
  startTime: null,
  pointsPerMinute: 0
};

chrome.commands.onCommand.addListener((command) => {
  if (command === "trigger-scan") {
    toggleLoop();
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "trigger_scan") {
    toggleLoop();
    sendResponse({ running: isLoopRunning, stats });
    return true;
  }
  if (request.action === "check_scanner") {
    fetch(`${SCANNER_URL}/health`, { cache: "no-store" })
      .then(res => sendResponse({ online: res.ok }))
      .catch(() => sendResponse({ online: false }));
    return true;
  }
  if (request.action === "get_stats") {
    sendResponse({ stats });
    return true;
  }
});

function toggleLoop() {
  isLoopRunning = !isLoopRunning;
  console.log("[BACKGROUND] Loop toggled. Active status:", isLoopRunning);
  if (isLoopRunning) {
    stats.startTime = stats.startTime || new Date();
    runIteration();
  }
}

function updateStats(result) {
  stats.total++;
  if (result.correct === true) {
    stats.correct++;
  } else if (result.correct === false) {
    stats.wrong++;
  } else {
    stats.error++;
  }
  
  if (stats.startTime && stats.total > 0) {
    const elapsedMinutes = (Date.now() - stats.startTime.getTime()) / 60000;
    if (elapsedMinutes > 0) {
      stats.pointsPerMinute = Math.floor(stats.correct / elapsedMinutes);
    }
  }
}

async function runIteration() {
  if (!isLoopRunning || isProcessing) return;
  isProcessing = true;

  try {
    const tabs = await chrome.tabs.query({});
    const ecnlTab = tabs.find(t => t.url && t.url.includes("ecnlmediamarket.com"));

    if (!ecnlTab) {
      console.log("[BACKGROUND] No target ECNL tab active.");
      isProcessing = false;
      if (isLoopRunning) setTimeout(runIteration, POLL_INTERVAL * 2);
      return;
    }

    let taskData = null;
    try {
      taskData = await chrome.tabs.sendMessage(ecnlTab.id, { action: "get_task_data" });
    } catch (err) {
      console.log("[BACKGROUND] Injecting task_script.js into target tab:", ecnlTab.id);
      await chrome.scripting.executeScript({
        target: { tabId: ecnlTab.id },
        files: ["task_script.js"]
      });
      await new Promise(r => setTimeout(r, 800));
      taskData = await chrome.tabs.sendMessage(ecnlTab.id, { action: "get_task_data" });
    }

    if (!taskData || !taskData.imageData || taskData.error) {
      console.log("[BACKGROUND] Error or missing image, refreshing tab...");
      updateStats({ correct: null });
      await chrome.tabs.reload(ecnlTab.id);
      isProcessing = false;
      if (isLoopRunning) setTimeout(runIteration, POLL_INTERVAL * 2);
      return;
    }

    console.log(`[BACKGROUND] Dispatching payload to Flask server...`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(`${SCANNER_URL}/detect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: taskData.imageData,
        target_num: taskData.targetNum,
        task_text: taskData.taskText
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const result = await response.json();
    console.log("[BACKGROUND] Received Scanner Result:", result);

    let answer = null;
    if (result && result.color && result.color !== "unknown" && result.color !== "undefined" && result.color !== "null") {
      answer = result.color;
    } else if (result && result.count !== undefined && result.count !== null && result.count !== 0 && result.count !== "0") {
      answer = String(result.count);
    }

    if (answer && answer !== "undefined" && answer !== "null" && answer !== "0" && answer !== "NaN") {
      await chrome.tabs.sendMessage(ecnlTab.id, {
        action: "paste_and_submit",
        color: answer
      });
      
      setTimeout(async () => {
        try {
          const verdictData = await chrome.tabs.sendMessage(ecnlTab.id, { action: "get_verdict" });
          updateStats(verdictData || { correct: null });
        } catch (e) {
          updateStats({ correct: null });
        }
      }, 2000);
    } else {
      updateStats({ correct: null });
    }

  } catch (e) {
    console.warn("[BACKGROUND] Iteration cycle error:", e);
    updateStats({ correct: null });
  }

  isProcessing = false;
  if (isLoopRunning) {
    setTimeout(runIteration, POLL_INTERVAL);
  }
}

let idleWatcher = null;
function startIdleWatcher() {
  if (idleWatcher) clearInterval(idleWatcher);
  idleWatcher = setInterval(async () => {
    if (!isLoopRunning) return;
    try {
      const tabs = await chrome.tabs.query({});
      const ecnlTab = tabs.find(t => t.url && t.url.includes("ecnlmediamarket.com"));
      if (ecnlTab) {
        const taskData = await chrome.tabs.sendMessage(ecnlTab.id, { action: "get_task_data" }).catch(() => null);
        if (!taskData || !taskData.imageData) {
          updateStats({ correct: null });
          await chrome.tabs.reload(ecnlTab.id);
        }
      }
    } catch (e) {}
  }, IDLE_CHECK_INTERVAL);
}
startIdleWatcher();
