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

const STALL_RESET_MS = 120000;
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
    this.taskStartTime = null;
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
    this.pointsSyncTimer = null;
    this.withdrawableCache = null;
    this._lastPointsPush = 0;
  }

  getWorkUrl() {
    return COLOR_WORK_URL;
  }

  attach() {
    const wc = this.wc;

    // Block any navigation away from solving-colors/math (allow login pages)
    wc.on("will-navigate", (_e, url) => {
      this.log(`NAV-WILL -> ${url}`);
      if (url && /ecnlmediamarket\.com/i.test(url) && !WORK_RE.test(url) && !/(login|signin|auth)/i.test(url)) {
        _e.preventDefault();
        this.log(`NAV-BLOCKED: ${url} -> forcing work page`);
        wc.loadURL(this.getWorkUrl()).catch(() => {});
      }
    });

    wc.on("did-navigate", (_e, url) => {
      this.currentUrl = url || "";
      this.log(`NAV-TOP -> ${url || ""}`);
      // Safety: if landed on non-work ecnl page, redirect
      if (url && /ecnlmediamarket\.com/i.test(url) && !WORK_RE.test(url) && !/(login|signin|auth)/i.test(url)) {
        this.log(`NAV-FIX: redirecting to work page`);
        wc.loadURL(this.getWorkUrl()).catch(() => {});
      }
    });

    wc.on("did-redirect-navigation", (_e, url) => {
      this.log(`NAV-REDIRECT -> ${url}`);
      if (url && /ecnlmediamarket\.com/i.test(url) && !WORK_RE.test(url) && !/(login|signin|auth)/i.test(url)) {
        _e.preventDefault();
        this.log(`NAV-REDIRECT-BLOCKED: ${url}`);
        wc.loadURL(this.getWorkUrl()).catch(() => {});
      }
    });

    wc.on("did-navigate-in-page", (_e, url) => {
      this.currentUrl = url || "";
      this._injected = false;
      this.inject().catch(() => {});
    });

    wc.on("did-finish-load", () => {
      this.currentUrl = wc.getURL() || "";
      this._injected = false;
      this.inject().catch(() => {});
    });

    wc.on("ipc-message", (_e, channel, _id, msg) => {
      if (channel !== "vt-slot-msg") return;
      if (msg && msg.type === "stale_refresh") {
        this.log(`Page reported stale (src=${msg.src || "?"}). Recovery reload.`);
        this.refreshPage(`page-stale:${msg.src || "?"}`, true);
      } else if (msg && msg.type === "ensure_running") {
        this.ensureRunning();
      } else if (msg && msg.type === "vt_log") {
        this.log(msg.msg || "");
      }
    });

    wc.on("render-process-gone", (_e, details) => {
      console.warn(`[${this.name}] renderer gone: reason=${details.reason} exit=${details.exitCode}`);
      this.lastGoneTs = Date.now();
      const now = Date.now();
      if (this.reloadCooldownUntil && now < this.reloadCooldownUntil) return;
      if (this.isLoopRunning && this.lastGoneTs - (this._lastReloadTs || 0) > 10000) {
        this._lastReloadTs = this.lastGoneTs;
        setTimeout(() => { try { this.wc.reload(); } catch (e) {} }, 1500);
      }
    });
  }

  wcIsAlive() {
    try { return this.wc && !this.wc.isDestroyed(); } catch (e) { return false; }
  }

  setZoom(z) { this.zoom = z; try { this.wc.setZoomFactor(z); } catch (e) {} }
  setHud(on) { this.hudEnabled = !!on; }
  setDelay(mult) { this.delayMult = mult > 0 ? mult : 1; }

  async inject() {
    if (!this.wcIsAlive()) return;
    if (this._injected) return;
    try {
      if (this.currentUrl.includes("ecnlmediamarket.com")) {
        const credsJson = JSON.stringify(this._creds || null);
        await this.wc.executeJavaScript(
          `window.__vtCreds = ${credsJson};`
        ).catch(() => {});
        if (AD_BLOCK_JS) {
          await this.wc.executeJavaScript(AD_BLOCK_JS).catch(() => {});
        }
        await this.wc.executeJavaScript(INJECT_JS).catch(() => {});
        this._injected = true;
      }
    } catch (e) {}
  }

  async api(method, arg) {
    if (!this.wcIsAlive()) return null;
    const js = `(async () => {
      if (!window.__vtapi) return null;
      try { return await window.__vtapi.${method}(${arg == null ? "" : JSON.stringify(arg)}); }
      catch (e) { return null; }
    })()`;
    try { return await this.wc.executeJavaScript(js); } catch (e) { return null; }
  }

  ensureRunning() {
    if (!this.isLoopRunning && !this.loopStopRequested) this.startLoop();
  }

  toggleLoop() {
    if (this.isLoopRunning) this.stopLoop("Stopped by user.");
    else this.startLoop();
  }

  startLoop() {
    if (this.isLoopRunning) return;
    if (!this.wcIsAlive()) return;
    this.isLoopRunning = true;
    this.isProcessing = false;
    this.loopStopRequested = false;
    this.loopStartTime = Date.now();
    this.taskCount = 0;
    this.correctCount = 0;
    this.wrongCount = 0;
    this.errorCount = 0;
    this.lastPoints = { done: null, total: null };
    this.lastSubmittedImageHash = null;
    this.touchAction();
    this.touchProgress();
    this.startLiveTimer();
    this.startKeeperClients();
    this.startPointsSync();
    this.status("Loop started. Scanning...");
    this.startStaggered();
    this.tickTimer = setInterval(() => {
      if (!this.isLoopRunning) return;
      this.log(`TICK url=${this.currentUrl || "?"}`);
    }, 120000);
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

  setPaused(p) {
    if (this.paused === p) return;
    console.log(`[Slot ${this.id}] setPaused(${p})`);
    this.paused = p;
    if (p) this.status("Paused (dashboard)");
    else if (this.isLoopRunning) { this.status("Resuming..."); this.startStaggered(1500); }
  }

  // ---- HUD ----
  startLiveTimer() {
    this.stopLiveTimer();
    this.hudTimer = setInterval(() => {
      if (!this.isLoopRunning || this.paused) return;
      const elapsed = this.loopStartTime ? Math.floor((Date.now() - this.loopStartTime) / 1000) : 0;
      const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const ss = String(elapsed % 60).padStart(2, "0");
      this.pushHud({ timerText: `${mm}:${ss}`, isRunning: true });
    }, HUD_TICK_MS);
  }

  stopLiveTimer() { if (this.hudTimer) clearInterval(this.hudTimer); this.hudTimer = null; }

  status(text) { this.lastHudText = text; this.pushHud({}); }

  pushHud(partial) {
    if (!this.hudEnabled || !this.wcIsAlive()) return;
    const elapsed = this.loopStartTime ? Math.floor((Date.now() - this.loopStartTime) / 1000) : 0;
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    const state = {
      slotName: this.name,
      statusText: partial.statusText !== undefined ? partial.statusText : this.lastHudText,
      timerText: partial.timerText || `${mm}:${ss}`,
      correctCount: this.correctCount,
      wrongCount: this.wrongCount,
      errorCount: this.errorCount,
      isRunning: this.isLoopRunning,
      lastTaskCorrect: this.lastTaskCorrect
    };
    this.api("hud", state).catch(() => {});
  }

  // ---- keeper ----
  startKeeperClients() {
    this.stopKeeperClients();
    this.heartbeatTimer = setInterval(() => this.sendKeeperHeartbeat(), HEARTBEAT_MS);
    this.commandTimer = setInterval(() => this.pollKeeperCommand(), COMMAND_POLL_MS);
    this.sendKeeperHeartbeat();
  }

  stopKeeperClients() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.commandTimer) clearInterval(this.commandTimer);
    this.commandTimer = null;
  }

  async sendKeeperHeartbeat() {
    try {
      await fetch(KEEPER_HEARTBEAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ progress: this.lastProgressTs || 0 }),
        cache: "no-store"
      });
    } catch (e) {}
  }

  async pollKeeperCommand() {
    try {
      const res = await fetch(KEEPER_COMMAND_URL, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.command === "reset" && this.isLoopRunning && !this.isProcessing) {
        const now = Date.now();
        const stallProgress = now - (this.lastProgressTs || 0);
        const stallAction = now - (this.lastActionTs || 0);
        if (stallProgress > STALL_RESET_MS && stallAction > STALL_RESET_MS) {
          this.log(`HARD-RESET: no progress for ${Math.round(stallProgress / 1000)}s`);
          this.hardRestart();
        }
      }
    } catch (e) {}
  }

  // ---- report ----
  async sendTaskReport(payload) {
    try {
      let battery = null;
      try {
        const b = await fetch("http://127.0.0.1:8177/battery", { cache: "no-store" });
        const j = await b.json();
        battery = j && j.battery != null ? j.battery : null;
      } catch (e) {}
      payload = Object.assign({}, payload, {
        battery, slot: this.name,
        taskCount: this.taskCount,
        correctCount: this.correctCount,
        wrongCount: this.wrongCount,
        errorCount: this.errorCount
      });
      await fetch(`${SCANNER_URL}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store"
      });
    } catch (e) {}
  }

  captureAndSendReport(report) {
    // Don't use timer — check verdict inline after short delay so submissions don't cancel each other
    const reportData = report;
    (async () => {
      let correct = null, theirs = null, withdrawable = null, pointsDone = null, pointsTotal = null;

      // Wait a moment for the page to show verdict feedback
      await sleep(1500);

      // Check verdict multiple times for accuracy
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const v = await this.api("getVerdict");
          if (v && v.correct !== null) {
            correct = !!v.correct;
            theirs = v.theirs || null;
            break;
          }
        } catch (e) {}
        if (attempt < 2) await sleep(500);
      }

      try {
        const m = await this.api("getTaskMeta");
        if (m) {
          withdrawable = m.withdrawable != null ? String(m.withdrawable) : null;
          pointsDone = m.pointsDone != null ? String(m.pointsDone) : null;
          pointsTotal = m.pointsTotal != null ? String(m.pointsTotal) : null;
        }
      } catch (e) {}
      if (pointsDone == null) pointsDone = this.lastPoints.done;
      if (pointsTotal == null) pointsTotal = this.lastPoints.total;

      // Fallback: points rose = correct answer
      if (correct == null) {
        const oldV = parseInt(String(reportData.pointsBeforeSubmit || ""), 10);
        const newV = parseInt(String(pointsDone || ""), 10);
        if (isFinite(oldV) && isFinite(newV) && newV > oldV) {
          correct = true;
          this.log(`Verdict: points rose ${oldV}->${newV}; counted CORRECT.`);
        } else if (isFinite(oldV) && isFinite(newV) && newV === oldV && oldV > 0) {
          // Points didn't change after submit — likely wrong answer
          correct = false;
          this.log(`Verdict: points unchanged ${newV}; counted WRONG.`);
        }
      }

      if (correct === true) this.correctCount++;
      else if (correct === false) this.wrongCount++;
      else { this.errorCount++; this.log(`Verdict: unknown; counted ERROR.`); }
      this.lastTaskCorrect = correct;
      this.lastPoints.done = pointsDone;
      this.lastPoints.total = pointsTotal;
      this.pushHud({});

      this.sendTaskReport(Object.assign({}, reportData, { correct, theirs, withdrawable, pointsDone, pointsTotal }));
    })().catch(() => {});
  }

  // ---- refresh ----
  async refreshPage(reason, navigate) {
    if (this.isProcessing) { this.log(`SUPPRESSED reload during iteration (${reason}).`); return; }
    this.errorCount++;
    this.log(`RELOAD reason=${reason}${navigate ? " -> solving-colors" : ""} (counted ERROR)`);
    this.pushHud({});
    if (!this.wcIsAlive()) return;
    try { if (navigate) await this.wc.loadURL(this.getWorkUrl()); else this.wc.reload(); } catch (e) {}
    this.touchAction();
  }

  async hardRestart() {
    const wasRunning = this.isLoopRunning;
    this.log(`HARD-RESTART wasRunning=${wasRunning}`);
    this.isLoopRunning = false;
    this.isProcessing = false;
    this.stopLiveTimer();
    this.stopKeeperClients();
    if (!this.wcIsAlive()) return;
    try { this.wc.reload(); } catch (e) {}
    if (!wasRunning) return;
    setTimeout(() => {
      if (this.loopStopRequested || !wasRunning) return;
      this.isLoopRunning = true;
      this.isProcessing = false;
      this.loopStartTime = Date.now();
      this.taskCount = 0;
      this.correctCount = 0;
      this.wrongCount = 0;
      this.errorCount = 0;
      this.lastPoints = { done: null, total: null };
    this.lastSubmittedImageHash = null;
    this.lastSubmittedAnswer = null;
    this.lastTaskCorrect = false;
    this.lastPointsDoneBeforeSubmit = null;
    this.taskStartTime = null;
      this.touchAction();
      this.touchProgress();
      this.startLiveTimer();
      this.startKeeperClients();
      this.status("[Failsafe] Restarting loop...");
      this.runIteration();
    }, 5000);
  }

  async ensureWorkPage() {
    if (!this.wcIsAlive()) return;
    try { await this.wc.loadURL(this.getWorkUrl()); } catch (e) {}
  }

  touchAction() { this.lastActionTs = Date.now(); }
  touchProgress() { this.lastProgressTs = Date.now(); }

  async scanHealth() {
    try { const res = await fetch(`${SCANNER_URL}/health`, { cache: "no-store" }); return res.ok; }
    catch (e) { return false; }
  }

  async scannerEnsure() {
    const online = await this.scanHealth();
    if (online) return true;
    try {
      const { spawn } = require("child_process");
      const scannerDir = path.join(__dirname, "..", "pcapp", "scanner");
      const py = spawn("pythonw", ["server.py"], {
        cwd: scannerDir,
        stdio: "ignore",
        detached: true,
        windowsHide: true
      });
      this._scannerPid = py.pid;
      py.unref();
      for (let i = 0; i < 10; i++) {
        await sleep(1000);
        if (await this.scanHealth()) return true;
      }
    } catch (e) {}
    return false;
  }

  async scannerKill() {
    if (!this._scannerPid) return;
    try {
      process.kill(this._scannerPid, "SIGKILL");
    } catch (e) {}
    this._scannerPid = null;
  }

  startStaggered(delay) {
    if (this.nextTimer) clearTimeout(this.nextTimer);
    const d = delay != null ? delay : (this.id % 4) * 500 + 200;
    this.nextTimer = setTimeout(() => this.runIteration(), d);
  }

  scheduleNext(delay) {
    if (!this.isLoopRunning) return;
    let d = Math.round((delay || 0) * this.delayMult);
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

    try {
      // Check if previous task timed out (>30 seconds)
      if (this.taskStartTime && this.lastTaskCorrect === false) {
        const elapsed = Date.now() - this.taskStartTime;
        if (elapsed > 30000) {
          this.errorCount++;
          this.log(`Task timeout: ${Math.round(elapsed / 1000)}s (counted ERROR)`);
          this.pushHud({});
        }
      }
      this.taskStartTime = Date.now();

      await this.inject();

      let page = null;
      try { page = await this.api("pageReady"); } catch (e) {}
      const throttle = (tag) => {
        const now = Date.now();
        if (this._pageLogs[tag] && now - this._pageLogs[tag] < 30000) return;
        this._pageLogs[tag] = now;
        return true;
      };

      // Page checks - redirect to work page if needed
      if (!page || !page.isECNL) {
        const curUrl = this.currentUrl || "";
        const onECNL = /ecnlmediamarket\.com/i.test(curUrl);
        if (onECNL) {
          // On ECNL but __vtapi not ready yet — retry shortly
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
        if (throttle("auth")) this.log(`PAGE auth url=${page.url || "?"}`);
        this.status("Login page. Auto-login running, waiting...");
        this.touchProgress();
        this.isProcessing = false;
        // After 8 seconds, if still on auth page, force redirect to solving-colors
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
        this.status("Input box not found. Refreshing...");
        this.isProcessing = false;
        this.touchAction();
        await this.refreshPage("input-not-found", true);
        this.scheduleNext(4000);
        return;
      }

      this.status(`[${this.taskCount + 1}] Task ready. Checking scanner...`);

      // Snapshot points
      try {
        const meta = await this.api("getTaskMeta");
        if (meta) {
          if (meta.pointsDone != null) this.lastPoints.done = String(meta.pointsDone);
          if (meta.pointsTotal != null) this.lastPoints.total = String(meta.pointsTotal);
          // Check if points increased since last submission → last answer was correct
          if (this.lastPointsDoneBeforeSubmit !== null && meta.pointsDone != null) {
            const prev = parseInt(this.lastPointsDoneBeforeSubmit, 10);
            const curr = parseInt(String(meta.pointsDone), 10);
            if (!isNaN(prev) && !isNaN(curr) && curr > prev) {
              this.lastTaskCorrect = true;
            }
          }
        }
      } catch (e) {}

      const scannerOnline = await this.scannerEnsure();
      if (!scannerOnline) {
        this.status("Scanner OFFLINE. Starting...");
        this.isProcessing = false;
        this.scheduleNext(5000);
        return;
      }

      // Grab image
      this.status(`[${this.taskCount + 1}] Grabbing image...`);
      let imageData = null;
      try { imageData = await this.api("grabImage", true); imageData = imageData && imageData.imageData; } catch (e) {}

      if (!imageData) {
        this.consecutiveDetectFails++;
        this.status(`[${this.taskCount + 1}] No image. Retry (${this.consecutiveDetectFails})`);
        this.touchAction();
        if (this.consecutiveDetectFails >= 3) {
          this.log("No image 3x. Recovery reload.");
          this.isProcessing = false;
          await this.refreshPage("no-image-x3", true);
          this.consecutiveDetectFails = 0;
          this.scheduleNext(4000);
          return;
        }
        this.isProcessing = false;
        this.scheduleNext(1500);
        return;
      }

      const curHash = hashImage(imageData);
      // Oracle: allow same image to be answered again — no deduplication limit (user requested)
      if (this.lastSubmittedImageHash !== null && curHash === this.lastSubmittedImageHash) {
        this.log(`SAME-IMAGE retry allowed (hash=${curHash}) — submitting again as requested`);
      }

      const imgSizeKB = Math.round((imageData.length * 3 / 4) / 1024);
      this.status(`[${this.taskCount + 1}] Image (${imgSizeKB}KB). Detecting...`);
      this.touchAction();

      const endpoint = "/detect";
      let result;
      try {
        const scanRes = await fetch(`${SCANNER_URL}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: imageData })
        });
        result = await scanRes.json();
      } catch (e) {
        this.status(`[${this.taskCount + 1}] Scanner connection failed.`);
        this.isProcessing = false;
        this.scheduleNext(3000);
        return;
      }

      if (result.error) {
        this.consecutiveDetectFails++;
        this.log(`[${this.taskCount + 1}] Detect FAIL: ${result.error} ${result.message || ""}`);
        this.status(`[${this.taskCount + 1}] Detection failed: ${result.message || result.error}`);
        if (this.consecutiveDetectFails >= 3) {
          this.log("Detection failed 3x. Recovery reload.");
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

      // Build answer (color mode only)
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

      this.status(`[${this.taskCount}] DETECTED: ${answer}. Pasting...`);

      // Save points before submit to detect correctness next iteration
      const pointsBeforeSubmit = this.lastPoints.done;
      this.lastPointsDoneBeforeSubmit = this.lastPoints.done;
      this.lastTaskCorrect = false;

      // Fill and submit
      let pasted = false;
      try {
        const r = await this.api("fill", answer);
        pasted = !!(r && (r.status === "filled"));
      } catch (e) {}

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
      this.isProcessing = false;
      this.scheduleNext(800);
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
    const deadline = Date.now() + 120000;
    let lastInputHud = 0;
    let lastDebugLog = 0;
    while (this.isLoopRunning && !this.paused && Date.now() < deadline) {
      let ready = false;
      try {
        const r = await this.api("checkInputReady");
        // 2026 blank page — immediate auto refresh (user requested)
        if (r && r.isBlank2026) {
          this.log("2026 BLANK detected — immediate reload");
          try { this.wc.reload(); } catch(e) {}
          this.errorCount++;
          return false;
        }
        ready = !!(r && r.ready);
        if (!ready && Date.now() - lastDebugLog > 10000) {
          lastDebugLog = Date.now();
          this.log(`INPUT-CHECK ready=${r && r.ready} hasBox=${r && r.hasBox} hasBtn=${r && r.hasBtn} boxW=${r && r.boxW} boxH=${r && r.boxH} btnW=${r && r.btnW} btnH=${r && r.btnH} empty=${r && r.empty} loaded=${r && r.loaded} url=${(r && r.url) || "?"}`);
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
      accountName: this.accountName || "",
      running: this.isLoopRunning,
      paused: this.paused,
      url: this.currentUrl || "",
      taskCount: this.taskCount,
      correctCount: this.correctCount,
      wrongCount: this.wrongCount,
      errorCount: this.errorCount,
      status: this.lastHudText || "",
      pointsDone: this.lastPoints.done,
      pointsTotal: this.lastPoints.total,
      hudEnabled: this.hudEnabled,
      zoom: this.zoom,
      delayMult: this.delayMult,
      stopRequested: this.loopStopRequested
    };
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
        if ((pd != null && !isNaN(pd) && pd >= 0 && pd <= 500) || wd != null) {
          let changed = false;
          if (pd != null && String(pd) !== String(this.lastPoints.done)) changed = true;
          if (wd != null && String(wd) !== String(this.withdrawableCache)) changed = true;
          if (!changed && Date.now() - (this._lastPointsPush || 0) < 30000) return;
          this._lastPointsPush = Date.now();
          this.withdrawableCache = wd;
          if (pd != null) this.lastPoints.done = String(pd);
          if (pt != null) this.lastPoints.total = String(pt);
          this.pushHud({});
          fetch(`${SCANNER_URL}/report`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              slot: this.id,
              slotName: this.name,
              pointsDone: pd,
              pointsTotal: pt,
              withdrawable: wd != null ? parseFloat(wd) : undefined,
              lastUpdate: new Date().toLocaleTimeString()
            })
          }).catch(() => {});
          this.log(`POINTS-SYNC points=${pd != null ? pd + '/' + (pt || 250) : '?'} bal=${wd || '?'} -> scanner`);
        }
      } catch (e) {}
    }, 8000);
  }

  stopPointsSync() {
    if (this.pointsSyncTimer) { clearInterval(this.pointsSyncTimer); this.pointsSyncTimer = null; }
  }
}

module.exports = { Slot, ensureScripts };
