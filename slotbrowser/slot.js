// VisionTap Slot - per-slot loop controller.
// Drives one WebContentsView: waits for task, OCRs via local scanner,
// fills answer, reports result. Color mode.

const fs = require("fs");
const path = require("path");

const SCANNER_URL = "http://127.0.0.1:5566";
const KEEPER_HEARTBEAT_URL = "http://127.0.0.1:8177/heartbeat";
const KEEPER_COMMAND_URL = "http://127.0.0.1:8177/command";
const COLOR_WORK_URL = "https://ecnlmediamarket.com/solving-colors";
const PMATH_WORK_URL = "https://pmath100.com/games-mathproblem#";
const PMATH_CONVERT_URL = "https://pmath100.com/convert-coins";
const WORK_RE = /\/solving-colors|pmath100\.com\/games-mathproblem|pmath100\.com\/convert-coins/;
const PMATH_RE = /pmath100\.com/;

const STALL_RESET_MS = 15000;
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
    // Single-detect cache: store detected answer and wait for inputbox, don't re-detect while waiting
    this.pendingAnswer = null;
    this.pendingHash = null;
    this.pendingImage = null;
    this.lastHarshRestart = 0;
    this.consecutiveNoProgress = 0;
  }

  getWorkUrl() {
    if (String(this.id) === "14" || String(this.accountName).toLowerCase() === "kyaiko" || this.taskMode === "math") return PMATH_WORK_URL;
    return COLOR_WORK_URL;
  }
  isPmathSlot() {
    return String(this.id) === "14" || String(this.accountName).toLowerCase() === "kyaiko" || this.taskMode === "math" || PMATH_RE.test(this.currentUrl || "");
  }
  async handlePmathConvert() {
    try {
      // Check if on convert page
      const isConvert = (this.currentUrl || "").includes("/convert-coins");
      if (!isConvert) {
        // Navigate to convert page
        this.log("PMATH: navigating to convert page");
        await this.wc.loadURL(PMATH_CONVERT_URL).catch(()=>{});
        await new Promise(r=>setTimeout(r,3000));
      }
      // Try to convert via inject
      const res = await this.api("pmathDoConvert", { amount: 100 });
      if (res && res.status === "converted") {
        this.log(`PMATH: converted ${res.converted || 100} coins`);
        // Report to scanner? Use coins as withdrawable
        try {
          const meta = await this.api("pmathGetMeta");
          if (meta && meta.coins != null) {
            this.lastPoints.done = String(meta.coins);
            this.withdrawableCache = String(meta.coins);
          }
        } catch(e){}
        await new Promise(r=>setTimeout(r,2000));
        await this.wc.loadURL(PMATH_WORK_URL).catch(()=>{});
        this.touchProgress();
        return true;
      }
      // Fallback: try Convert All button directly
      const fallback = await this.api("pmathDoConvertAll");
      if (fallback && fallback.status === "clicked") {
        await new Promise(r=>setTimeout(r,2000));
        await this.wc.loadURL(PMATH_WORK_URL).catch(()=>{});
        return true;
      }
      return false;
    } catch(e) {
      this.log(`PMATH convert error: ${e.message}`);
      return false;
    }
  }

  attach() {
    const wc = this.wc;

    // Block any navigation away from solving-colors/math (allow login pages)
    wc.on("will-navigate", (_e, url) => {
      this.log(`NAV-WILL -> ${url}`);
      if (url && (/ecnlmediamarket\.com|pmath100\.com/i.test(url)) && !WORK_RE.test(url) && !/(login|signin|auth|convert)/i.test(url)) {
        _e.preventDefault();
        this.log(`NAV-BLOCKED: ${url} -> forcing work page`);
        wc.loadURL(this.getWorkUrl()).catch(() => {});
      }
    });

    wc.on("did-navigate", (_e, url) => {
      this.currentUrl = url || "";
      this.log(`NAV-TOP -> ${url || ""}`);
      // Safety: if landed on non-work ecnl/pmath page, redirect
      if (url && (/ecnlmediamarket\.com|pmath100\.com/i.test(url)) && !WORK_RE.test(url) && !/(login|signin|auth|convert)/i.test(url)) {
        this.log(`NAV-FIX: redirecting to work page`);
        wc.loadURL(this.getWorkUrl()).catch(() => {});
      }
    });

    wc.on("did-redirect-navigation", (_e, url) => {
      this.log(`NAV-REDIRECT -> ${url}`);
      if (url && (/ecnlmediamarket\.com|pmath100\.com/i.test(url)) && !WORK_RE.test(url) && !/(login|signin|auth|convert)/i.test(url)) {
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
    }, 30000);
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
    else {
      this.status("Resuming...");
      if (!this.isLoopRunning && !this.loopStopRequested) this.startLoop();
      else this.startStaggered(1500);
      // Ensure isProcessing not stuck
      if (this.isProcessing) {
        const age = Date.now() - (this.taskStartTime || 0);
        if (age > 30000) { this.isProcessing = false; this.log("Reset stuck isProcessing"); }
      }
    }
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
      correctCount: 0, // removed - time only
      wrongCount: 0, // removed - time only
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
        battery, slot: String(this.id),
        taskCount: this.taskCount,
        correctCount: 0, // removed - time only
        wrongCount: 0, // removed - time only
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

      // Wait 1 sec after submit button clicked as user requested
      const fillDelay = reportData.fillDelay || 1500;
      // fill() schedules click after fillDelay, so wait fillDelay + 1000 for verdict to appear
      await sleep(fillDelay + 1000);

      // Check verdict multiple times for accuracy - 5 attempts over ~4s to catch green/red
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const v = await this.api("getVerdict");
          if (v && v.correct !== null) {
            correct = !!v.correct;
            theirs = v.theirs || null;
            break;
          }
        } catch (e) {}
        if (attempt < 4) await sleep(700);
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

      // New cycle: 100+ -> 0-10 (e.g., 195->4) → reset to show current 4/250 not old 195+compiled (user wants current)
      const oldPdForReset = reportData.pointsBeforeSubmit != null ? parseInt(String(reportData.pointsBeforeSubmit), 10) : (this.lastPoints.done != null ? parseInt(String(this.lastPoints.done), 10) : null);
      const newPdForReset = pointsDone != null ? parseInt(String(pointsDone), 10) : null;
      if (oldPdForReset != null && !isNaN(oldPdForReset) && newPdForReset != null && !isNaN(newPdForReset) && oldPdForReset >= 100 && newPdForReset >= 0 && newPdForReset <= 10) {
        this.log(`NEW CYCLE ${oldPdForReset}->${newPdForReset}, reset current counts for dashboard`);
        this.taskCount = 0;
        this.correctCount = 0;
        this.wrongCount = 0;
        this.errorCount = 0;
      }

      // ONLY verdict from website green/red AFTER actual submit - never from detection alone
      if (!reportData.pasted) {
        this.errorCount++;
        this.log(`Verdict: not submitted (pasted=false) counted ERROR`);
      } else if (correct === true) {
        // removed // removed correctCount++ // leave time only
        this.log(`Verdict: CORRECT (green) after submit`);
      } else if (correct === false) {
        // removed // removed wrongCount++ // leave time only
        this.log(`Verdict: INCORRECT (red) after submit`);
      } else {
        this.errorCount++;
        this.log(`Verdict: unknown (no green/red) counted ERROR - points ${reportData.pointsBeforeSubmit}->${pointsDone}`);
      }
      this.lastTaskCorrect = correct;
      this.lastPoints.done = pointsDone;
      this.lastPoints.total = pointsTotal;
      this.pushHud({});

      this.sendTaskReport(Object.assign({}, reportData, { correct, theirs, withdrawable, pointsDone, pointsTotal }));
    })().catch(() => {});
  }

  // ---- refresh ----
  async refreshPage(reason, navigate) {
    if (this.isProcessing) {
      const age = Date.now() - (this.taskStartTime || 0);
      if (age > 30000) { this.isProcessing = false; this.log(`Force reset stuck isProcessing for refresh (${reason}) after ${Math.round(age/1000)}s`); }
      else { this.log(`SUPPRESSED reload during iteration (${reason}).`); return; }
    }
    this.errorCount++;
    this.log(`RELOAD reason=${reason}${navigate ? " -> solving-colors" : ""} (counted ERROR)`);
    this.pushHud({});
    if (!this.wcIsAlive()) return;
    try { if (navigate) await this.wc.loadURL(this.getWorkUrl()); else this.wc.reload(); } catch (e) {}
    this.touchAction();
    // Ensure loop continues after refresh
    this.scheduleNext(2000);
  }

  async maybeHarshRestart(reason) {
    const now = Date.now();
    if (now - (this.lastHarshRestart||0) < 15000) return false;
    this.lastHarshRestart = now;
    this.log(`HARSH-RESTART single ${reason} - reloading`);
    await this.hardRestart();
    return true;
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
    this.pendingAnswer = null;
    this.pendingHash = null;
    this.pendingImage = null;
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
    this.log(`scheduleNext id=${this.id} delay=${delay} loop=${this.isLoopRunning} paused=${this.paused} processing=${this.isProcessing}`);
    if (!this.isLoopRunning) return;
    let d = Math.round((delay || 0) * this.delayMult);
    if (this.paused) {
      // While paused, retry every 3s but don't stack timers
      if (!this.nextTimer) {
        this.nextTimer = setTimeout(() => {
          this.nextTimer = null;
          if (this.paused) this.scheduleNext(3000);
          else if (this.isLoopRunning) this.runIteration();
        }, 3000);
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
    this.log(`runIteration ENTRY id=${this.id} loop=${this.isLoopRunning} paused=${this.paused} processing=${this.isProcessing} url=${this.currentUrl || "?"}`);
    // Auto-reset stuck isProcessing (e.g., previous iteration hung) - schedule retry if still stuck
    if (this.isProcessing) {
      const age = Date.now() - (this.taskStartTime || 0);
      this.log(`runIteration SKIP isProcessing=true age=${Math.round(age/1000)}s paused=${this.paused} loop=${this.isLoopRunning}`);
      if (age > 45000) { this.isProcessing = false; this.log("Auto-reset stuck isProcessing after "+Math.round(age/1000)+"s"); }
      else { this.scheduleNext(3000); return; }
    }
    if (!this.isLoopRunning || this.paused) {
      this.log(`runIteration SKIP loop=${this.isLoopRunning} paused=${this.paused} stopReq=${this.loopStopRequested}`);
      if (!this.isLoopRunning && !this.loopStopRequested) {
        if (Date.now() - (this.lastHarshRestart||0) > 15000) {
          this.log("Not looping - harsh restart");
          await this.maybeHarshRestart("not-looping");
        }
      }
      return;
    }
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
        if (throttle("auth")) this.log(`PAGE auth url=${page.url || "?"} isAuth=${page.isAuth} isECNL=${page.isECNL}`);
        // Immediate retry login via injected tryLogin with timeout
        try {
          const r = await Promise.race([this.api("tryLogin"), new Promise((_,rej)=>setTimeout(()=>rej(new Error("tryLogin timeout")), 8000))]);
          if (r) this.log(`TRY-LOGIN result: ${JSON.stringify(r).substring(0,120)}`);
        } catch(e) { this.log(`TRY-LOGIN error/timeout: ${e.message}`); }
        this.status("Login page. Auto-login running, waiting...");
        this.touchProgress();
        this.isProcessing = false;
        this.log(`SCHEDULING next runIteration in 3000ms for auth page id=${this.id}`);
        this.scheduleNext(3000);
        return;
      }
      this.log(`PAGE DEBUG id=${this.id} url=${page.url || this.currentUrl} isECNL=${page.isECNL} isAuth=${page.isAuth} isWork=${page.isWork} hasBox=${!!page.hasBox} hasBtn=${!!page.hasBtn} ready=${page.ready}`);
      // PMATH convert page handling
      if (this.isPmathSlot() && page.url && page.url.includes("/convert-coins")) {
        this.log("PMATH on convert page, handling convert");
        const conv = await this.handlePmathConvert();
        this.isProcessing = false;
        this.scheduleNext(conv ? 3000 : 2000);
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

      // PMATH: check convert at 100 coins before solving
      if (this.isPmathSlot()) {
        try {
          // If on convert page, handle it
          if ((this.currentUrl || "").includes("/convert-coins")) {
            const conv = await this.handlePmathConvert();
            this.isProcessing = false;
            this.scheduleNext(conv ? 3000 : 2000);
            return;
          }
          // Check coins balance via pmath meta
          const pmeta = await this.api("pmathGetMeta");
          if (pmeta && pmeta.coins != null && Number(pmeta.coins) >= 100) {
            this.log(`PMATH: coins ${pmeta.coins} >=100, converting`);
            const conv = await this.handlePmathConvert();
            this.isProcessing = false;
            this.scheduleNext(3000);
            return;
          }
        } catch(e) {}
      }

      this.status(`[${this.taskCount + 1}] Task ready. Checking scanner...`);

      // Snapshot points 1:1 from web - exact copy of withdrawable balance area (e.g., 49/250)
      try {
        const meta = await this.api("getTaskMeta");
        if (meta) {
          if (meta.pointsDone != null) this.lastPoints.done = String(meta.pointsDone);
          if (meta.pointsTotal != null) this.lastPoints.total = String(meta.pointsTotal);
          // For pmath, also sync coins
          if (this.isPmathSlot() && meta.coins != null) {
            this.lastPoints.done = String(meta.coins);
            this.withdrawableCache = String(meta.coins);
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

      // PMATH instant math solving (separate, no stall limit)
      if (this.isPmathSlot()) {
        let pmathImage = null;
        try { const r = await this.api("grabImage", true); pmathImage = r && r.imageData; } catch(e) {}
        if (!pmathImage) {
          this.status("PMATH No image. Retry");
          this.isProcessing = false;
          this.scheduleNext(1500);
          return;
        }
        const pHash = hashImage(pmathImage);
        let pAnswer = null;
        // Try solve_math
        let pResult;
        try {
          const res = await fetch(`${SCANNER_URL}/solve_math`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: pmathImage })
          });
          pResult = await res.json();
        } catch(e) {
          this.status("PMATH scanner fail");
          this.isProcessing = false;
          this.scheduleNext(2000);
          return;
        }
        if (pResult.error || !pResult.answer) {
          this.log(`PMATH solve fail: ${pResult.error || 'no answer'} raw=${pResult.raw || ''}`);
          this.isProcessing = false;
          this.scheduleNext(1500);
          return;
        }
        pAnswer = String(pResult.answer).trim();
        this.log(`PMATH solved ${pResult.expression || ''} = ${pAnswer} (raw ${pResult.raw})`);
        // Wait for input box (TYPE HERE)
        const pReady = await this.waitForInputBox();
        if (!pReady) {
          this.isProcessing = false;
          this.scheduleNext(1000);
          return;
        }
        // Instant fill (kyaiko no delay)
        let pPasted = false;
        let pDelay = 0;
        try {
          const r = await this.api("fill", pAnswer);
          pPasted = !!(r && r.status === "filled");
          if (r && r.delayMs != null) pDelay = r.delayMs;
        } catch(e) {}
        if (!pPasted) {
          this.isProcessing = false;
          this.scheduleNext(1000);
          return;
        }
        this.taskCount++;
        this.lastSubmittedImageHash = pHash;
        // For pmath, report coins via /report
        try {
          const meta = await this.api("pmathGetMeta");
          const coins = meta && meta.coins != null ? String(meta.coins) : null;
          this.lastPoints.done = coins;
          this.withdrawableCache = coins;
          await fetch(`${SCANNER_URL}/report`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slot: String(this.id), slotName: this.name, pointsDone: coins ? parseInt(coins,10) : undefined, pointsTotal: 250, withdrawable: coins ? parseFloat(coins) : undefined, taskCount: this.taskCount, correctCount: 0, wrongCount: 0, errorCount: this.errorCount, correct: true, color: pResult.expression || '', taskNum: this.taskCount })
          }).catch(()=>{});
        } catch(e) {}
        this.touchAction(); this.touchProgress();
        this.isProcessing = false;
        this.scheduleNext(800);
        return;
      }

      // Single-detect: reuse cached answer for same image while waiting for inputbox
      let imageData = null;
      let curHash = null;
      let answer = null;
      // If we have pending answer for same hash, reuse it (dont re-detect while waiting)
      // First, peek image to get hash for cache check
      this.status(`[${this.taskCount + 1}] Grabbing image...`);
      try { imageData = await this.api("grabImage", true); imageData = imageData && imageData.imageData; } catch (e) {}

      if (!imageData) {
        this.consecutiveDetectFails++;
        this.status(`[${this.taskCount + 1}] No image. Retry (${this.consecutiveDetectFails})`);
        this.touchAction();
        if (this.consecutiveDetectFails >= 3) {
          this.log("No image 3x. Harsh reload.");
          this.isProcessing = false;
          this.consecutiveDetectFails = 0;
          if (!await this.maybeHarshRestart("no-image-x3")) await this.refreshPage("no-image-x3", true);
          this.scheduleNext(4000);
          return;
        }
        this.isProcessing = false;
        this.scheduleNext(1500);
        return;
      }

      curHash = hashImage(imageData);
      // If same image as pending and we already have answer, reuse (dont re-detect)
      if (this.pendingHash !== null && curHash === this.pendingHash && this.pendingAnswer) {
        answer = this.pendingAnswer;
        this.log(`CACHED answer ${answer} for hash=${curHash} - skipping re-detect`);
      } else {
        // Need fresh detect
        // Allow same image retry but use cached answer if pending (dont spam re-detect while waiting)
        if (this.lastSubmittedImageHash !== null && curHash === this.lastSubmittedImageHash) {
          if (this.pendingAnswer) {
            this.log(`SAME-IMAGE same hash=${curHash} - reusing cached ${this.pendingAnswer} (no re-detect)`);
          } else {
            this.log(`SAME-IMAGE same hash=${curHash} - allowing retry as new task`);
          }
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
        answer = result.color;
        this.consecutiveDetectFails = 0;
        // Cache detected answer - wait for inputbox then submit, dont re-detect
        this.pendingAnswer = answer;
        this.pendingHash = curHash;
        this.pendingImage = imageData;
      }
      // At this point answer is either cached or freshly detected - DONT increment yet, wait until after submit
      if (!answer || answer === "unknown") {
        this.status(`[${this.taskCount + 1}] Unknown result. Skipping...`);
        this.pendingAnswer = null;
        this.pendingHash = null;
        this.pendingImage = null;
        this.isProcessing = false;
        this.scheduleNext(1500);
        return;
      }

      this.status(`[${this.taskCount + 1}] DETECTED: ${answer}. Waiting for input box...`);
      // Wait for inputbox AFTER detection (single-detect flow) - get image detect then wait
      const inputReadyAfterDetect = await this.waitForInputBox();
      if (!inputReadyAfterDetect) {
        this.status(`[${this.taskCount + 1}] Input not ready after detect, will retry submit (keep cached ${answer})`);
        this.isProcessing = false;
        this.scheduleNext(1500);
        return;
      }
      this.status(`[${this.taskCount + 1}] Input ready, pasting ${answer}...`);
      // Per-slot submit delay after input ready — 11 instant as requested
      {
        const idStr = String(this.id);
        const nameLow = String(this.accountName || "").toLowerCase();
        let waitMs = 0;
        if (idStr === "11" || nameLow === "adaihbi") waitMs = 0;
        else if (idStr === "14" || nameLow === "kyaiko") waitMs = 0;
        else if (idStr === "12" || nameLow === "temi") waitMs = 2500;
        else if (idStr === "13" || nameLow === "danicajgb") waitMs = 4500;
        if (waitMs > 0) {
          this.log(`Slot ${idStr} (${nameLow||idStr}) waiting ${waitMs/1000}s before submit`);
          await sleep(waitMs);
        } else {
          this.log(`Slot ${idStr} instant submit (no wait)`);
        }
      }
      // Save points before submit - 1:1 exact copy after
      const pointsBeforeSubmit = this.lastPoints.done;
      this.lastPointsDoneBeforeSubmit = this.lastPoints.done;
      this.lastTaskCorrect = false;
      // Fill and submit - ONLY now increment taskCount after actual submit attempt
      let pasted = false;
      let fillDelay = 1500;
      try {
        const r = await this.api("fill", answer);
        pasted = !!(r && (r.status === "filled"));
        if (r && r.delayMs) fillDelay = r.delayMs;
      } catch (e) {}
      if (!pasted) {
        this.status(`[${this.taskCount + 1}] Fill failed for ${answer}, will retry`);
        this.isProcessing = false;
        this.scheduleNext(1500);
        return;
      }
      this.taskCount++;
      this.lastSubmittedImageHash = curHash;
      this.lastSubmittedAnswer = answer;

      this.captureAndSendReport({
        questionId: curHash != null ? String(curHash) : String(this.taskCount),
        taskNum: this.taskCount,
        color: answer,
        image: imageData,
        pasted,
        fillDelay,
        pointsBeforeSubmit,
        ts: Date.now()
      });

      this.status(`[${this.taskCount}] Submitted: ${answer}. Next task...`);
      // Strict: clear pending and wait for next task's new image before next detect
      this.pendingAnswer = null;
      this.pendingHash = null;
      this.pendingImage = null;
      // Wait for new image hash to appear (dont re-detect same image)
      for (let w = 0; w < 10; w++) {
        await sleep(600);
        try {
          const nd = await this.api("grabImage", true);
          const ndData = nd && nd.imageData;
          if (!ndData) continue;
          const nh = hashImage(ndData);
          if (nh && nh !== curHash) {
            this.log(`New task image ready hash=${nh} (prev ${curHash})`);
            break;
          }
        } catch (e) {}
      }
      this.touchAction();
      this.touchProgress();
      this.isProcessing = false;
      this.scheduleNext(2000);
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
    const deadline = Date.now() + 5000;
    let lastInputHud = 0;
    let lastDebugLog = 0;
    while (this.isLoopRunning && !this.paused && Date.now() < deadline) {
      let ready = false;
      let checking = false;
      try {
        const r = await this.api("checkInputReady");
        // 2026 immediate auto-refresh (user: 2026 coming back)
        if (r && r.isBlank2026) {
          this.log("2026 BLANK immediate reload");
          try { this.wc.reload(); } catch(e) {}
          this.errorCount++;
          return false;
        }
        // REMOVED: waiting for server to clear checking state 120s — instant reload, no wait
        if (r && r.checking) {
          checking = true;
          this.log("CHECKING state detected — instant reload, no 120s wait");
          try { this.wc.reload(); } catch(e) {}
          this.errorCount++;
          return false;
        }
        ready = !!(r && r.ready);
        if (!ready && Date.now() - lastDebugLog > 5000) {
          lastDebugLog = Date.now();
          this.log(`INPUT-CHECK ready=${r && r.ready} hasBox=${r && r.hasBox} hasBtn=${r && r.hasBtn} boxW=${r && r.boxW} boxH=${r && r.boxH} btnW=${r && r.btnW} btnH=${r && r.btnH} empty=${r && r.empty} loaded=${r && r.loaded} url=${(r && r.url) || "?"}`);
        }
      } catch (e) {
        if (Date.now() - lastDebugLog > 5000) {
          lastDebugLog = Date.now();
          this.log(`INPUT-CHECK error: ${e.message}`);
        }
      }
      if (ready) return true;
      if (checking) return false;
      if (Date.now() - lastInputHud > 2000) {
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
      correctCount: 0, // removed - time only
      wrongCount: 0, // removed - time only
      errorCount: this.errorCount,
      status: this.lastHudText || "",
      pointsDone: this.lastPoints.done,
      pointsTotal: this.lastPoints.total,
      hudEnabled: this.hudEnabled,
      zoom: this.zoom,
      delayMult: this.delayMult,
      stopRequested: this.loopStopRequested,
      timerText: (()=>{ const e=this.loopStartTime?Math.floor((Date.now()-this.loopStartTime)/1000):0; const m=String(Math.floor(e/60)).padStart(2,"0"); const s=String(e%60).padStart(2,"0"); return `${m}:${s}`; })(),
      elapsed: this.loopStartTime?Math.floor((Date.now()-this.loopStartTime)/1000):0,
      loopStartTime: this.loopStartTime
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
          // New cycle detection for dashboard current (user wants 4/250 not 195+old, delete old cache)
          const oldPdNum = this.lastPoints.done != null ? parseInt(String(this.lastPoints.done), 10) : null;
          if (oldPdNum != null && !isNaN(oldPdNum) && pd != null && !isNaN(pd) && oldPdNum >= 100 && pd >= 0 && pd <= 10) {
            this.log(`NEW CYCLE ${oldPdNum}->${pd}, reset current counts for dashboard`);
            this.taskCount = 0;
            this.correctCount = 0;
            this.wrongCount = 0;
            this.errorCount = 0;
          }
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
              taskCount: this.taskCount,
              correctCount: 0, // removed - time only
              wrongCount: 0, // removed - time only
              errorCount: this.errorCount,
              lastUpdate: new Date().toLocaleTimeString(),
              timerText: (()=>{ const e=this.loopStartTime?Math.floor((Date.now()-this.loopStartTime)/1000):0; const m=String(Math.floor(e/60)).padStart(2,"0"); const s=String(e%60).padStart(2,"0"); return `${m}:${s}`; })(),
              elapsed: this.loopStartTime?Math.floor((Date.now()-this.loopStartTime)/1000):0,
              loopStartTime: this.loopStartTime
            })
          }).catch(() => {});
          this.log(`POINTS-SYNC points=${pd != null ? pd + '/' + (pt || 250) : '?'} bal=${wd || '?'} -> scanner`);
        }
      } catch (e) {}
    }, 3000);
  }

  stopPointsSync() {
    if (this.pointsSyncTimer) { clearInterval(this.pointsSyncTimer); this.pointsSyncTimer = null; }
  }
}

module.exports = { Slot, ensureScripts };
