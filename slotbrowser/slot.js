// VisionTap Slot - per-slot loop controller.
// Drives one WebContentsView: waits for task, OCRs via local scanner,
// fills answer, reports result. Color mode.

const fs = require("fs");
const path = require("path");

const SCANNER_URL = "http://127.0.0.1:5566";
const KEEPER_HEARTBEAT_URL = "http://127.0.0.1:8177/heartbeat";
const KEEPER_COMMAND_URL = "http://127.0.0.1:8177/command";
const COLOR_WORK_URL = "https://ecnlmediamarket.com/solving-colors";
const WORK_RE = /\/solving-colors/;

const STALL_RESET_MS = 30000;
const HEARTBEAT_MS = 30000;
const COMMAND_POLL_MS = 15000;
const HUD_TICK_MS = 5000;

let INJECT_JS = "";
let AD_BLOCK_JS = "";

function ensureScripts(injectPath) {
  if (!INJECT_JS) INJECT_JS = fs.readFileSync(injectPath, "utf8");
  if (!AD_BLOCK_JS) {
    try {
      const adPath = require("path").join(require("path").dirname(injectPath), "..", "ad_blocker.js");
      AD_BLOCK_JS = fs.readFileSync(adPath, "utf8");
    } catch (e) {}
  }
}

function hashImage(dataUrl) {
  if (!dataUrl) return null;
  const s = dataUrl.slice(dataUrl.indexOf(",") + 1);
  let h = 0;
  const step = Math.max(1, Math.floor(s.length / 512));
  for (let i = 0; i < s.length; i += step) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class Slot {
  constructor({ id, name, view, logger }) {
    this.id = id;
    this.name = name;
    this.accountName = "";
    this.view = view;
    this.wc = view.webContents;
    this.logger = logger || null;
    this.log = (msg) => { if (this.logger) this.logger(msg); else console.warn(msg); };

    this._creds = null;
    this.taskMode = "color";

    this.isLoopRunning = false;
    this.isProcessing = false;
    this.loopStartTime = null;
    this.taskCount = 0;
    this.correctCount = 0;
    this.wrongCount = 0;
    this.errorCount = 0;
    this.loopStopRequested = false;
    this.lastPoints = { done: null, total: null };
    this.lastActionTs = 0;
    this.lastProgressTs = 0;
    this.lastSubmittedImageHash = null;
    this.lastSubmittedAnswer = null;
    this.lastTaskCorrect = false;
    this.lastPointsDoneBeforeSubmit = null;
    this.reportGeneration = 0;
    this.taskStartTime = null;
    this.lastTaskSubmitTs = 0;
    this.paused = false;
    this.lastHudText = "";
    this.currentUrl = "";
    this.hudEnabled = true;
    this.delayMult = 1;
    this.zoom = 1;

    this.hudTimer = null;
    this.heartbeatTimer = null;
    this.commandTimer = null;
    this.nextTimer = null;
    this.consecutiveDetectFails = 0;
    this._pageLogs = {};
    this._lastBlockerLog = 0;
    this._injected = false;
    this._scannerPid = null;
    this.dashboardPaused = false;
    this.loginCycleCount = 0;
    this.lastLoginCycleTs = 0;
  }

  attach() {
    this.startLiveTimer();
    this.pushHud({});

    if (this.wcIsAlive()) {
      this.wc.on("did-navigate", (_e, url) => {
        this.currentUrl = url || "";
        this.resetInjected();
      });
      this.wc.on("did-navigate-in-page", (_e, url) => {
        this.currentUrl = url || this.currentUrl;
        this.resetInjected();
      });
      this.wc.on("did-navigate", (_e, url) => {
        this.currentUrl = url || "";
      });
    }
  }

  getWorkUrl() {
    return COLOR_WORK_URL;
  }

  setZoom(z) {
    this.zoom = z || 1;
    try { this.wc.setZoomFactor(this.zoom); } catch (e) {}
  }

  setHud(on) {
    this.hudEnabled = on !== false;
    this.pushHud({});
  }

  setDelay(d) {
    this.delayMult = d || 1;
  }

  setPaused(p) {
    if (this.paused === p) return;
    console.log(`[Slot ${this.id}] setPaused(${p})`);
    this.paused = p;
    if (!p && this.isLoopRunning) {
      this.touchAction();
      if (!this.nextTimer) this.scheduleNext(2000);
    }
    this.pushHud({});
  }

  status(text) {
    this.lastHudText = text || "";
    this.pushHud({});
  }

  pushHud(extra) {
    if (!this.hudEnabled) return;
    const now = new Date();
    const ts = now.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const pointsText = this.lastPoints.done != null && this.lastPoints.total != null ? `${this.lastPoints.done}/${this.lastPoints.total}` : "--/--";
    const lines = [
      `VisionTap Slot ${this.id}${this.paused ? " PAUSED" : ""}`,
      `${this.paused ? "PAUSED" : "SCANNING"}`,
      `Time: ${this.getTimeRunning()} | Correct: ${this.correctCount} | Wrong: ${this.wrongCount} | Error: ${this.errorCount}`,
    ];
    if (extra && extra.line4) lines.push(extra.line4);
    if (this.lastHudText && !this.lastHudText.startsWith("[")) lines.push(this.lastHudText);
    else if (this.lastHudText) lines.push(this.lastHudText);
    try {
      this.wc.executeJavaScript(`
        const el = document.getElementById('visiontap-hud');
        if (el) {
          const pre = el.querySelector('pre');
          if (pre) pre.textContent = ${JSON.stringify(lines.join("\n"))};
        }
      `).catch(() => {});
    } catch (e) {}
  }

  getTimeRunning() {
    if (!this.loopStartTime) return "00:00";
    const sec = Math.floor((Date.now() - this.loopStartTime) / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  touchAction() { this.lastActionTs = Date.now(); }
  touchProgress() { this.lastProgressTs = Date.now(); }

  wcIsAlive() {
    try { return this.wc && !this.wc.isDestroyed(); } catch (e) { return false; }
  }

  async inject() {
    if (this._injected || !this.wcIsAlive()) return;
    try {
      // Ensure __vtapi exists before running inject
      await this.wc.executeJavaScript('window.__vtapi = window.__vtapi || {};');
      if (this._creds && this._creds.user) {
        await this.wc.executeJavaScript(`window.__vtCreds = ${JSON.stringify(this._creds)};`);
      }
      await this.wc.executeJavaScript(INJECT_JS);
      if (AD_BLOCK_JS) await this.wc.executeJavaScript(AD_BLOCK_JS);
      this._injected = true;
    } catch (e) {
      this.log(`INJECT-ERROR: ${e.message}`);
    }
  }

  resetInjected() { this._injected = false; }

  async api(method, arg) {
    if (!this.wcIsAlive()) return null;
    const js = `(async () => {
      if (!window.__vtapi) return null;
      try { return await window.__vtapi.${method}(${arg == null ? "" : JSON.stringify(arg)}); }
      catch (e) { return null; }
    })()`;
    try { return await this.wc.executeJavaScript(js); } catch (e) { return null; }
  }

  startLoop() {
    if (this.isLoopRunning) return;
    if (!this.wcIsAlive()) return;
    this.isLoopRunning = true;
    this.loopStartTime = Date.now();
    this.loopStopRequested = false;
    this.log("Loop started.");
    this.status("Starting...");
    this.pushHud({});
    this.touchAction();
    this.scheduleNext(1000);
    this.startHeartbeat();
    this.startCommandPoll();
    this.startPointsSync();
  }

  stopLoop(reason) {
    this.isLoopRunning = false;
    this.isProcessing = false;
    this.loopStopRequested = true;
    this.stopLiveTimer();
    this.stopKeeperClients();
    this.stopPointsSync();
    if (this.nextTimer) { clearTimeout(this.nextTimer); this.nextTimer = null; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.status(`Stopped: ${reason}`);
  }

  toggleLoop() {
    if (this.isLoopRunning) this.stopLoop("Stopped by user.");
    else this.startLoop();
  }

  ensureRunning() {
    if (!this.isLoopRunning && !this.loopStopRequested) this.startLoop();
  }

  scheduleNext(d) {
    if (this.nextTimer) clearTimeout(this.nextTimer);
    if (this.paused) {
      if (!this.nextTimer) {
        this.nextTimer = setTimeout(() => {
          this.nextTimer = null;
          if (this.paused) this.scheduleNext(5000);
          else if (this.isLoopRunning) this.runIteration();
        }, 5000);
      }
      return;
    }
    this.log(`SCHEDULE-NEXT in ${d}ms`);
    this.nextTimer = setTimeout(() => {
      this.nextTimer = null;
      if (this.isLoopRunning) this.runIteration();
    }, d);
  }

  // ---- main loop ----
  async runIteration() {
    if (!this.isLoopRunning || this.isProcessing || this.paused) return;
    if (!this.wcIsAlive()) return;
    this.isProcessing = true;
    this.log(`ITERATION-START loop=${this.isLoopRunning} processing=${this.isProcessing} paused=${this.paused}`);

    try {
      this.taskStartTime = Date.now();

      await this.inject();

      let page = null;
      try { page = await this.api("pageReady"); 
        this.log(`PAGE-CHECK page=${page ? 'found' : 'null'} isECNL=${page ? page.isECNL : 'N/A'} curUrl=${this.currentUrl || ''}`); 
      } catch (e) { this.log(`API-ERROR pageReady: ${e.message}`); }
      const throttle = (tag) => {
        const now = Date.now();
        if (this._pageLogs[tag] && now - this._pageLogs[tag] < 30000) return;
        this._pageLogs[tag] = now;
        return true;
      };

      if (!page || !page.isECNL) {
        const curUrl = this.currentUrl || "";
        const onECNL = /ecnlmediamarket\.com/i.test(curUrl);
        this.log(`PAGE-CHECK page=${JSON.stringify(page)} curUrl=${curUrl}`);
        if (onECNL) {
          if (throttle("noecnl")) this.log(`PAGE __vtapi not ready on ECNL, retrying url=${curUrl}`);
          this.status("Waiting for page script...");
          this.isProcessing = false;
          this.scheduleNext(1500);
          return;
        }
        if (throttle("noecnl")) this.log(`PAGE noECNL url=${(page && page.url) || curUrl || "?"}`);
        this.status("Not on ECNL. Loading work page...");
        await this.ensureWorkPage();
        this.isProcessing = false;
        this.scheduleNext(4000);
        return;
      }
      if (page.isAuth) {
        const now = Date.now();
        if (throttle("auth")) this.log(`PAGE auth url=${page.url || "?"}`);
        this.status("Login page. Auto-login running, waiting...");
        this.touchProgress();
        this.isProcessing = false;
        this.scheduleNext(8000);
        return;
      }
      if (!page.isWork) {
        if (throttle("other")) this.log(`PAGE other url=${page.url || "?"}`);
        this.status("Not on work page. Redirecting...");
        await this.ensureWorkPage();
        this.isProcessing = false;
        this.scheduleNext(4000);
        return;
      }

      // Wait for input box
      const inputReady = await this.waitForInputBox();
      if (!inputReady) {
        this.status("Input box not found. Reloading page...");
        this.isProcessing = false;
        this.touchAction();
        try { this.wc.reload(); } catch (e) {}
        this.scheduleNext(5000);
        return;
      }

      this.status(`[${this.taskCount + 1}] Task ready. Checking scanner...`);

      const scannerOnline = await this.scannerEnsure();
      if (!scannerOnline) {
        this.status("Scanner OFFLINE. Starting...");
        this.isProcessing = false;
        this.scheduleNext(5000);
        return;
      }

      this.status(`[${this.taskCount + 1}] Grabbing image...`);
      let imageData = null;
      try { imageData = await this.api("grabImage", true); imageData = imageData && imageData.imageData; } catch (e) {}

      if (!imageData) {
        this.consecutiveDetectFails++;
        this.log(`[${this.taskCount + 1}] No image. Retry (${this.consecutiveDetectFails})`);
        if (this.consecutiveDetectFails <= 1) {
          try {
            const pg = await this.api("pageReady");
            if (pg && pg.grabDebug) this.log(`[${this.taskCount + 1}] GRAB-DEBUG: ${pg.grabDebug}`);
          } catch (e) {}
        }
        this.touchAction();
        if (this.consecutiveDetectFails >= 3) {
          this.isProcessing = false;
          await this.refreshPage("detect-fail-x3", true);
          this.consecutiveDetectFails = 0;
          this.scheduleNext(4000);
          return;
        }
        this.isProcessing = false;
        this.scheduleNext(1500);
        return;
      }

      const curHash = hashImage(imageData);

      if (this.lastSubmittedImageHash === curHash) {
        this.status(`[${this.taskCount + 1}] Same image. Waiting...`);
        this.isProcessing = false;
        this.scheduleNext(2000);
        return;
      }

      this.status(`[${this.taskCount + 1}] Detecting...`);
      let result = null;
      try {
        result = await fetch(`${SCANNER_URL}/detect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: imageData })
        }).then(r => r.json());
      } catch (e) {
        this.log(`Scanner detect error: ${e.message}`);
      }

      if (!result || result.error) {
        this.consecutiveDetectFails++;
        this.log(`[${this.taskCount + 1}] Detect FAIL: ${result && result.error} ${result && result.message || ""}`);
        this.status(`[${this.taskCount + 1}] Detection failed: ${result && (result.message || result.error)}`);
        if (this.consecutiveDetectFails >= 3) {
          this.isProcessing = false;
          await this.refreshPage("detect-fail-x3", true);
          this.consecutiveDetectFails = 0;
          this.scheduleNext(4000);
          return;
        }
        this.isProcessing = false;
        this.scheduleNext(1500);
        return;
      }

      let answer = result.color;
      this.consecutiveDetectFails = 0;
      this.taskCount++;
      this.lastSubmittedImageHash = curHash;
      this.lastSubmittedAnswer = answer;

      if (!answer || answer === "unknown") {
        this.status(`[${this.taskCount}] Unknown result. Skipping...`);
        this.isProcessing = false;
        this.scheduleNext(1500);
        return;
      }

      this.status(`[${this.taskCount}] DETECTED: ${answer}. Waiting 2s...`);

      // Wait 2 seconds before submitting (human-like)
      await sleep(2000);

      this.status(`[${this.taskCount}] Pasting answer: ${answer}...`);

      const pointsBeforeSubmit = this.lastPoints.done;
      this.lastPointsDoneBeforeSubmit = this.lastPoints.done;
      this.lastTaskCorrect = false;

      let pasted = false;
      try {
        const r = await this.api("fill", answer);
        pasted = !!(r && (r.status === "filled"));
      } catch (e) {}

      this.reportGeneration++;
      this.captureAndSendReport({
        questionId: curHash != null ? String(curHash) : String(this.taskCount),
        taskNum: this.taskCount,
        color: answer,
        image: imageData,
        pasted,
        pointsBeforeSubmit,
        ts: Date.now()
      });

      this.status(`[${this.taskCount}] Submitted: ${answer}. Next task...`);
      this.touchAction();
      this.touchProgress();
      this.lastTaskSubmitTs = Date.now();
      this.isProcessing = false;
      this.scheduleNext(3000);
      return;
    } catch (err) {
      console.error(`[${this.name}] Iteration error:`, err);
      this.errorCount++;
      this.status(`[${this.taskCount + 1}] Error: ${err.message}`);
      this.isProcessing = false;
      this.scheduleNext(3000);
    }
  }

  async waitForInputBox() {
    const deadline = Date.now() + 25000;
    let lastInputHud = 0;
    let lastDebugLog = 0;
    let checkingCount = 0;
    while (this.isLoopRunning && !this.paused && Date.now() < deadline) {
      let ready = false;
      try {
        const r = await this.api("checkInputReady");
        ready = !!(r && r.ready);
        if (r && (r.isBlank2026 || r.isBlankNoTask)) {
          if (!this._blankWaitStart) this._blankWaitStart = Date.now();
          const blankWaitMs = Date.now() - this._blankWaitStart;
          if (blankWaitMs > 8000) {
            this.log("BLANK-PAGE: Waited 8s. Reloading...");
            this._blankWaitStart = null;
            this.isProcessing = false;
            try { this.wc.reload(); } catch (e) {}
            return false;
          }
        } else {
          this._blankWaitStart = null;
        }
        if (r && r.checking) {
          checkingCount++;
          if (checkingCount >= 20) {
            this.log("CHECKING-STUCK: Reloading...");
            this.isProcessing = false;
            try { this.wc.reload(); } catch (e) {}
            return false;
          }
        } else {
          checkingCount = 0;
        }
        if (!ready && Date.now() - lastDebugLog > 10000) {
          lastDebugLog = Date.now();
          this.log(`INPUT-CHECK ready=${r && r.ready} hasBox=${r && r.hasBox} hasBtn=${r && r.hasBtn} checking=${r && r.checking} boxVal="${(r && r.boxVal) || ''}" url=${(r && r.url) || "?"}`);
        }
      } catch (e) {
        if (Date.now() - lastDebugLog > 10000) {
          lastDebugLog = Date.now();
          this.log(`INPUT-CHECK error: ${e.message}`);
        }
      }
      if (ready) return true;
      if (Date.now() - lastInputHud > 3000) {
        lastInputHud = Date.now();
        this.status("Waiting for task input box...");
      }
      this.touchProgress();
      await sleep(200);
    }
    return false;
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      accountName: this.accountName,
      isLoopRunning: this.isLoopRunning,
      isProcessing: this.isProcessing,
      paused: this.paused,
      taskCount: this.taskCount,
      correctCount: this.correctCount,
      wrongCount: this.wrongCount,
      errorCount: this.errorCount,
      lastPoints: this.lastPoints,
      lastHudText: this.lastHudText,
      currentUrl: this.currentUrl,
      zoom: this.zoom,
      delayMult: this.delayMult,
      hudEnabled: this.hudEnabled,
      timeRunning: this.getTimeRunning(),
      // Backward compat for shell UI + dashboard legacy keys
      running: this.isLoopRunning,
      url: this.currentUrl || "",
      status: this.lastHudText || "",
      pointsDone: this.lastPoints.done,
      pointsTotal: this.lastPoints.total,
      stopRequested: this.loopStopRequested
    };
  }

  // ---- refresh ----
  async refreshPage(reason, navigate) {
    if (this.isProcessing) { this.log(`SUPPRESSED reload during iteration (${reason}).`); return; }
    this.errorCount++;
    this.log(`RELOAD reason=${reason} (counted ERROR)`);
    this.pushHud({});
    if (!this.wcIsAlive()) return;
    try { this.wc.reload(); } catch (e) {}
    this.touchAction();
  }

  async ensureWorkPage() {
    if (!this.wcIsAlive()) return;
    try { await this.wc.loadURL(this.getWorkUrl()); } catch (e) {}
  }

  async checkPage() {
    if (!this.wcIsAlive()) return null;
    try {
      return await this.wc.executeJavaScript(`
        (function() {
          const u = window.location.href;
          return {
            url: u,
            isECNL: /ecnlmediamarket\\.com/i.test(u),
            isWork: /\\/solving-colors/i.test(u),
            isAuth: /login\\.php/i.test(u) || (document.querySelector('input[type="password"]') !== null && /ecnlmediamarket\\.com/i.test(u))
          };
        })()
      `);
    } catch (e) { return null; }
  }

  // ---- scanner ----
  async scannerEnsure() {
    try {
      const r = await fetch(`${SCANNER_URL}/health`, { cache: "no-store" });
      if (r.ok) return true;
    } catch (e) {}
    try {
      const r2 = await fetch(`${SCANNER_URL}/stats`).then(r => r.json());
      return !!(r2 && r2.slots != null);
    } catch (e) { return false; }
  }

  async captureAndSendReport(data) {
    this.lastSubmittedImageHash = hashImage(data.image);
    this.lastSubmittedAnswer = data.color;
    const reportData = { ...data, slot: this.id, slotName: this.name };

    (async () => {
      // Initial report: mark task submitted (for live taskCount)
      try {
        await fetch(`${SCANNER_URL}/report`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Object.assign({}, reportData, {
            taskCount: this.taskCount,
            correctCount: this.correctCount,
            wrongCount: this.wrongCount,
            errorCount: this.errorCount
          }))
        });
      } catch (e) {}

      await new Promise(r => setTimeout(r, 3000));

      let correct = null;
      let theirs = null;
      let withdrawable = null;
      let pointsDone = null;
      let pointsTotal = null;

      try {
        const meta = await this.api("getTaskMeta");
        if (meta) {
          if (meta.pointsDone != null) pointsDone = parseInt(String(meta.pointsDone), 10);
          if (meta.pointsTotal != null) pointsTotal = parseInt(String(meta.pointsTotal), 10);
          if (meta.withdrawable != null) withdrawable = String(meta.withdrawable);
        }
      } catch (e) {}

      // Fallback: try to read withdrawable/points from scanner stats if meta missed
      if (withdrawable == null) {
        try {
          const stats = await fetch(`${SCANNER_URL}/stats`).then(r => r.json());
          if (stats && stats.slots) {
            const s = stats.slots[this.id] || stats.slots[`Slot ${this.id}`] || stats.slots[this.name] || null;
            if (s) {
              if (s.withdrawable != null) withdrawable = String(s.withdrawable);
              theirs = s.lastUpdate || null;
            }
          }
        } catch (e) {}
      }

      const oldV = parseInt(String(reportData.pointsBeforeSubmit || ""), 10);
      if (pointsDone != null) {
        const newV = parseInt(String(pointsDone || ""), 10);
        if (isFinite(oldV) && isFinite(newV) && newV > oldV) {
          correct = true;
          this.log(`Verdict: points rose ${oldV}->${newV}; counted CORRECT.`);
        } else if (isFinite(oldV) && isFinite(newV) && newV === oldV && oldV > 0) {
          correct = false;
          this.log(`Verdict: points unchanged ${newV}; counted WRONG.`);
        }
      }

      if (correct === true) this.correctCount++;
      else if (correct === false) this.wrongCount++;
      else { this.errorCount++; this.log(`Verdict: unknown; counted ERROR.`); }
      this.lastTaskCorrect = correct;
      if (pointsDone != null) this.lastPoints.done = String(pointsDone);
      if (pointsTotal != null) this.lastPoints.total = String(pointsTotal);
      this.pushHud({});

      const finalPayload = Object.assign({}, reportData, {
        correct, theirs, withdrawable, pointsDone, pointsTotal,
        taskCount: this.taskCount,
        correctCount: this.correctCount,
        wrongCount: this.wrongCount,
        errorCount: this.errorCount
      });
      this.sendTaskReport(finalPayload);
    })().catch(() => {});
  }

  async sendTaskReport(data) {
    // 100% live: push final verdict to scanner stats AND local file for dashboard polling
    try {
      await fetch(`${SCANNER_URL}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
    } catch (e) {}
    try {
      const reportFile = path.join(require("os").homedir(), ".config", "VisionTap Slots", "state", `task_report_${this.id}.json`);
      fs.writeFileSync(reportFile, JSON.stringify(data, null, 2));
    } catch (e) {}
  }

  // ---- heartbeat ----
  startHeartbeat() {
    this.stopKeeperClients();
    this.heartbeatTimer = setInterval(() => {
      try {
        fetch(KEEPER_HEARTBEAT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slot: this.id, ts: Date.now() })
        }).catch(() => {});
      } catch (e) {}
    }, HEARTBEAT_MS);
  }

  stopKeeperClients() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.commandTimer) { clearInterval(this.commandTimer); this.commandTimer = null; }
  }

  startCommandPoll() {
    this.commandTimer = setInterval(async () => {
      try {
        const r = await fetch(KEEPER_COMMAND_URL).then(r => r.json());
        if (r && r.command) {
          if (r.command === "stop") this.stopLoop("Stopped by keeper.");
          else if (r.command === "reload") this.refreshPage("keeper-reload", true);
          else if (r.command === "pause") this.setPaused(true);
          else if (r.command === "resume") this.setPaused(false);
        }
      } catch (e) {}
    }, COMMAND_POLL_MS);
  }

  // ---- live timer ----
  startLiveTimer() {
    this.stopLiveTimer();
    this.tickTimer = setInterval(() => this.pushHud({}), HUD_TICK_MS);
  }

  stopLiveTimer() {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  // ---- points sync: keep dashboard 100% live even between tasks ----
  startPointsSync() {
    this.stopPointsSync();
    this.pointsSyncTimer = setInterval(async () => {
      if (!this.isLoopRunning || this.paused || !this.wcIsAlive()) return;
      try {
        const meta = await this.api("getTaskMeta");
        if (!meta) return;
        const pd = meta.pointsDone != null ? parseInt(String(meta.pointsDone), 10) : null;
        const pt = meta.pointsTotal != null ? parseInt(String(meta.pointsTotal), 10) : null;
        const wd = meta.withdrawable != null ? String(meta.withdrawable) : null;
        // Only push if we got a plausible points value (0-250) or withdrawable
        if ((pd != null && !isNaN(pd) && pd >= 0 && pd <= 500) || wd != null) {
          let changed = false;
          if (pd != null && String(pd) !== String(this.lastPoints.done)) changed = true;
          if (wd != null && String(wd) !== String(this.withdrawableCache)) changed = true;
          if (!changed) {
            // Still push every 30s to keep dashboard live even if unchanged
            if (Date.now() - (this._lastPointsPush || 0) < 30000) return;
          }
          this._lastPointsPush = Date.now();
          this.withdrawableCache = wd;
          if (pd != null) this.lastPoints.done = String(pd);
          if (pt != null) this.lastPoints.total = String(pt);
          this.pushHud({});
          // Fire-and-forget report to scanner for dashboard merge
          fetch(`${SCANNER_URL}/report`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              slot: this.id,
              slotName: this.name,
              pointsDone: pd,
              pointsTotal: pt,
              withdrawable: wd != null ? parseFloat(wd) : undefined,
              taskCount: this.taskCount,
              correctCount: this.correctCount,
              wrongCount: this.wrongCount,
              errorCount: this.errorCount,
              lastUpdate: new Date().toLocaleTimeString()
            })
          }).catch(() => {});
          this.log(`POINTS-SYNC points=${pd != null ? pd + '/' + (pt || 250) : '?'} bal=${wd || '?'} -> scanner`);
        }
        // Debug raw if points null
        if (pd == null && meta) {
          try {
            const raw = await this.wc.executeJavaScript('window.__vtapi && window.__vtapi._lastMetaRaw ? JSON.stringify(window.__vtapi._lastMetaRaw) : null');
            if (raw) this.log(`META-RAW ${raw.substring(0, 300)}`);
          } catch (e) {}
        }
      } catch (e) {}
    }, 8000);
  }

  stopPointsSync() {
    if (this.pointsSyncTimer) { clearInterval(this.pointsSyncTimer); this.pointsSyncTimer = null; }
  }
}

module.exports = { Slot, ensureScripts };
