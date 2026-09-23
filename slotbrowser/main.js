// VisionTap Slots - main process.
// One app window with N isolated WebContentsView slots, each locked to
// ecnlmediamarket.com/solving-colors. OCR via local scanner.

const { app, BrowserWindow, WebContentsView, session, ipcMain, screen, Tray, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const { drain } = require('./command-queue');
const { startupSlots, slotBounds } = require('./slot-config');
const { Slot, ensureScripts } = require("./slot.js");

const COLOR_WORK_URL = "https://ecnlmediamarket.com/solving-colors";
const MATH_WORK_URL = "https://ecnlmediamarket.com/solving-math";
const PMATH_WORK_URL = "https://pmath100.com/games-mathproblem#";
const WORK_RE = /\/solving-(colors|math)|pmath100\.com\/games-mathproblem|pmath100\.com\/convert-coins/;

const STATE_DIR = path.join(app.getPath("userData"), "state");
const SLOTS_FILE = path.join(STATE_DIR, "slots.json");
const CREDS_FILE = path.join(STATE_DIR, "credentials.json");
const SETTINGS_FILE = path.join(STATE_DIR, "settings.json");
const WIN_BOUNDS_FILE = path.join(STATE_DIR, "winbounds.json");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) {}
}

let settings = readJson(SETTINGS_FILE, { adBlock: true, taskMode: "color" });

const INJECT_PATH = path.join(__dirname, "inject", "slot_inject.js");

let win = null;
let settingsWin = null;
let tray = null;
const slots = new Map();
const ghosts = new Map();
let slotSeq = 0;
let pauseOnHidden = (settings.pauseWhenHidden === true);
let startMinimized = (settings.startMinimized === true);

// Low-RAM mode
if (readSettings().lowRamMode !== false) {
  app.disableHardwareAcceleration();
}

// Resource-saving flags
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-extensions");
app.commandLine.appendSwitch("disable-plugins");
app.commandLine.appendSwitch("disable-default-apps");
app.commandLine.appendSwitch("disable-translate");
app.commandLine.appendSwitch("disable-sync");
app.commandLine.appendSwitch("disable-breakpad");
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=64");
app.commandLine.appendSwitch("renderer-process-limit=2");
app.commandLine.appendSwitch("disable-dev-shm-usage");
app.commandLine.appendSwitch("disable-accelerated-2d-canvas");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-gpu-vsync");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("disable-animations");
app.commandLine.appendSwitch("disable-smooth-scrolling");
app.commandLine.appendSwitch("metrics-recording-only");
app.commandLine.appendSwitch("disable-field-trial-config");
app.commandLine.appendSwitch("disable-background-networking");

function readSettings() { return settings; }

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function readSlotsFile() {
  try { return JSON.parse(fs.readFileSync(SLOTS_FILE, "utf8")); } catch (e) { return {}; }
}
function ensureKyaikoMathIntegrity() {
  try {
    const data = readSlotsFile();
    let fixed = false;
    for (const s of (data.active||[])) {
      if (String(s.id)==="14" || String(s.accountName||"").toLowerCase()==="kyaiko") {
        if (s.taskMode !== "math") { s.taskMode="math"; fixed=true; }
      }
    }
    if (fixed) {
      try { fs.writeFileSync(SLOTS_FILE, JSON.stringify(data, null, 2)); } catch(e){}
      appendLog("[integrity]", "Auto-fixed kyaiko taskMode=math");
    }
  } catch(e){}
}

function writeSlotsFile() {
  const active = [];
  for (const s of slots.values()) {
    active.push({ id: s.id, name: s.name, accountName: s.accountName || "", taskMode: s.taskMode || "color", stopRequested: s.loopStopRequested, paused: s.dashboardPaused || s.paused, bootsOnStart: s.bootsOnStart !== false });
  }
  for (const g of ghosts.values()) {
    active.push({ id: g.id, name: g.name, accountName: g.accountName || "", taskMode: g.taskMode || "color", stopRequested: true, bootsOnStart: false });
  }
  const data = { pauseOnHidden, active };
  try { fs.writeFileSync(SLOTS_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

function applyLoginItem() {
  if (!app.isPackaged) return;
  try { app.setLoginItemSettings({ openAtLogin: settings.autoStart !== false }); } catch (e) {}
}

function readCreds() {
  try { return JSON.parse(fs.readFileSync(CREDS_FILE, "utf8")); } catch (e) { return {}; }
}

let appLogStream = null;
function appendLog(label, msg) {
  const line = `[${new Date().toISOString()}] ${label} ${msg}`;
  try { console.warn(line); } catch (e) { if (e && e.code !== 'EPIPE' && e.errno !== 'EPIPE') {} }
  try {
    if (!appLogStream) {
      appLogStream = fs.createWriteStream(path.join(STATE_DIR, "app.log"), { flags: "a" });
      appLogStream.on('error', () => { appLogStream = null; });
    }
    if (appLogStream && !appLogStream.destroyed) {
      const ok = appLogStream.write(line + "\n");
      if (!ok) { /* backpressure, ignore */ }
    }
  } catch (e) { if (e && e.code !== 'EPIPE') {} }
}
// Prevent EPIPE crash when parent pipe closed (hidden launch via pythonw)
try {
  process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') return; });
  process.stderr.on('error', (e) => { if (e && e.code === 'EPIPE') return; });
} catch (e) {}
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EPIPE') return;
  console.error('[uncaught]', err);
});

function statePayload() {
  return {
    pauseOnHidden,
    settings,
    slots: Array.from(slots.values()).map(s => s.snapshot()),
    ghosts: Array.from(ghosts.values())
  };
}

function broadcastState() {
  const p = statePayload();
  for (const w of [win, settingsWin]) {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send("vt-state", p); } catch (e) {}
    }
  }
}

// ---- Grid layout ----
const TOOLBAR_H = 82;
const PHONE_W = 480;
const PHONE_ASPECT = 0.7;
const GUTTER = 8;
let scrollOffset = 0;

function layout() {
  if (!win || win.isDestroyed()) return;
  const list = Array.from(slots.values());
  if (!list.length) return;
  const [w, h] = win.getContentSize();
  const bounds = slotBounds(list.length, w, h, TOOLBAR_H, GUTTER);
  list.forEach((slot, i) => {
    try { slot.view.setBounds(bounds[i]); slot.view.setVisible(true); } catch (e) {}
  });
}

function scrollSlots(delta) {
  scrollOffset += delta;
  layout();
}

function autoFitWindow() {
  if (!win || win.isDestroyed()) return;
  const n = slots.size;
  if (n === 0) return;
  layout();
}

function wireSession(ses) {
  ses.setSpellCheckerEnabled(false);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
}

// ---- Slot management ----
function createSlot(id, name, stopRequested, opts) {
  opts = opts || {};
  // Prevent duplicate renderers: if slot with same id already exists, clean old view first
  if (slots.has(String(id))) {
    const old = slots.get(String(id));
    try { if (win && !win.isDestroyed() && old.view) win.contentView.removeChildView(old.view); } catch(e) {}
    try { if (old.view && old.view.webContents && !old.view.webContents.isDestroyed()) old.view.webContents.close({waitForBeforeunload:false}); } catch(e) {}
    slots.delete(String(id));
    try { const g = ghosts.get(String(id)); if (g) ghosts.delete(String(id)); } catch(e) {}
  }
  const partition = `persist:vt-slot-${id}`;
  const ses = session.fromPartition(partition);
  wireSession(ses);

  const preload = path.join(__dirname, "preload", "slotpreload.js");
  const view = new WebContentsView({
    webPreferences: {
      partition,
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: true,
      additionalArguments: [`--vt-slot=${id}`],
      spellcheck: false,
      enableWebSQL: false,
      cache: false,
      webSecurity: false
    }
  });

  const isPmathOpt = opts.taskMode === "math" || String(id) === "14" || String(opts.accountName||"").toLowerCase() === "kyaiko";
  // Block popups and non-solving-colors/math navigation
  view.webContents.setWindowOpenHandler(({ url }) => {
    appendLog(`[${name}]`, `POPUP-DENIED: ${url}`);
    if (WORK_RE.test(url) || /(login|signin|auth|convert)/i.test(url)) {
      view.webContents.loadURL(url).catch(() => {});
    } else if (/ecnlmediamarket\.com|pmath100\.com/i.test(url)) {
      appendLog(`[${name}]`, `REDIRECT non-work -> work page: ${url}`);
      const isPmath = isPmathOpt || /pmath100\.com/i.test(url);
      view.webContents.loadURL(isPmath ? PMATH_WORK_URL : COLOR_WORK_URL).catch(() => {});
    }
    return { action: "deny" };
  });

  // Block navigation away from work pages (allow login/convert)
  view.webContents.on("will-navigate", (_e, url) => {
    if (url && (/ecnlmediamarket\.com|pmath100\.com/i.test(url)) && !WORK_RE.test(url) && !/(login|signin|auth|convert)/i.test(url)) {
      _e.preventDefault();
      appendLog(`[${name}]`, `NAV-BLOCKED: ${url}`);
      const isPmath = isPmathOpt || /pmath100\.com/i.test(url);
      view.webContents.loadURL(isPmath ? PMATH_WORK_URL : COLOR_WORK_URL).catch(() => {});
    }
  });

  const slot = new Slot({ id, name, view, logger: (m) => appendLog(`[${name}]`, m) });
  slot.bootsOnStart = opts.bootsOnStart !== false;
  slot.accountName = opts.accountName || "";
  if (slot.accountName) slot.name = slot.accountName;
  slot.taskMode = opts.taskMode || (String(id) === "14" || String(opts.accountName||"").toLowerCase() === "kyaiko" ? "math" : "color");
  // Don't force paused at boot - let window show handler manage it
  slot.pausedByWindow = false;
  slot.dashboardPaused = !!opts.paused;
  slot.paused = !!opts.paused;
  slot.attach();
  view.setVisible(true);
  win.contentView.addChildView(view);

  const s = (settings.slots && settings.slots[id]) || {};
  const defZoom = settings.zoomDefault ? Number(settings.zoomDefault) / 100 : 1;
  const defDelay = settings.delayMult || 1;
  slot.setZoom(s.zoom ? Number(s.zoom) : defZoom);
  slot.setHud(s.hud !== false);
  slot.setDelay(s.delayMult ? Number(s.delayMult) : defDelay);
  slot.taskMode = "color";

  if (stopRequested) {
    slot.loopStopRequested = true;
    slot.status("Stopped by user. Click Start to resume.");
  } else {
    slot.ensureRunning();
  }

  slots.set(id, slot);
  ghosts.delete(id);
  slotSeq = Math.max(slotSeq, Number(id) + 1);
  autoFitWindow();
  layout();
  broadcastState();

  // Always load work page (color or math based on mode)
  slot.view.webContents.loadURL(slot.getWorkUrl()).catch(() => {});
  return slot;
}

function removeSlot(id) {
  const slot = slots.get(id);
  ghosts.delete(id);
  if (!slot) return;
  slot.stopLoop("Slot removed.");
  const v = slot.view;
  slots.delete(id);
  try { win.contentView.removeChildView(v); } catch (e) {}
  if (!v.webContents.isDestroyed()) v.webContents.close({ waitForBeforeunload: false });
  autoFitWindow();
  layout();
  broadcastState();
  writeSlotsFile();
}

function bootSlot(id, name) {
  const g = ghosts.get(id);
  if (g) {
    createSlot(g.id, g.name || name, g.stopRequested || false, { bootsOnStart: true, taskMode: g.taskMode || "color", accountName: g.accountName });
    writeSlotsFile();
    return;
  }
  if (!slots.has(id)) {
    createSlot(String(id), name || `Slot ${slots.size + ghosts.size + 1}`, false, { bootsOnStart: true, taskMode: "color" });
    writeSlotsFile();
  }
}

// ---- IPC ----
function initIpc() {
  ipcMain.handle("vt-slot-add", () => {
    const id = String(slotSeq++);
    const n = slots.size + 1;
    createSlot(id, `Slot ${n}`, false, { taskMode: "color" });
    writeSlotsFile();
    return statePayload();
  });
  ipcMain.handle("vt-slot-add-ecnl", () => {
    const id = String(slotSeq++);
    const n = slots.size + 1;
    createSlot(id, `Slot ${n}`, false, { taskMode: "color" });
    writeSlotsFile();
    return statePayload();
  });
  ipcMain.handle("vt-slot-add-pmath", () => {
    const id = String(slotSeq++);
    const n = slots.size + 1;
    createSlot(id, `Slot ${n}`, false, { taskMode: "math" });
    writeSlotsFile();
    return statePayload();
  });
  ipcMain.handle("vt-slot-remove", (_e, id) => {
    if (id != null) removeSlot(id);
    return statePayload();
  });
  ipcMain.handle("vt-slot-toggle", (_e, id) => {
    const s = id != null ? slots.get(id) : null;
    if (s) { s.toggleLoop(); writeSlotsFile(); }
    return statePayload();
  });
  ipcMain.handle("vt-slot-reload", (_e, id) => {
    const s = id != null ? slots.get(id) : null;
    if (s) s.refreshPage("manual", true);
    return statePayload();
  });
  ipcMain.handle("vt-slot-focus", (_e, id) => {
    const s = id != null ? slots.get(id) : null;
    if (s && s.wcIsAlive()) s.view.webContents.focus();
    return statePayload();
  });
  ipcMain.handle("vt-pause-all", (_e, paused) => {
    pauseOnHidden = paused;
    settings.pauseWhenHidden = paused;
    writeJson(SETTINGS_FILE, settings);
    writeSlotsFile();
    return statePayload();
  });
  ipcMain.handle("vt-settings-get", () => Object.assign({}, settings));
  ipcMain.handle("vt-settings-set", (_e, patch) => {
    if (patch && typeof patch === "object") {
      settings = Object.assign({}, settings, patch);
      if (patch.gridColumns !== undefined) settings.gridColumns = Math.max(1, Math.min(6, Number(patch.gridColumns) || 0));
      if (patch.pauseWhenHidden !== undefined) pauseOnHidden = !!patch.pauseWhenHidden;
      if (patch.windowSize && win) {
        const s = patch.windowSize;
        if (s.width >= 700 && s.height >= 500) win.setSize(Math.round(s.width), Math.round(s.height));
      }
      if (patch.autoStart !== undefined) applyLoginItem();
      if (patch.adBlock !== undefined) {
        writeJson(SETTINGS_FILE, settings);
      }
      writeJson(SETTINGS_FILE, settings);
      const sp = (settings.slots = settings.slots || {});
      const defZoom = settings.zoomDefault ? Number(settings.zoomDefault) / 100 : 1;
      const defDelay = settings.delayMult || 1;
      for (const [id, s] of slots.entries()) {
        const cfg = sp[id] || {};
        s.setZoom(cfg.zoom ? Number(cfg.zoom) : defZoom);
        s.setHud(cfg.hud !== false);
        s.setDelay(cfg.delayMult ? Number(cfg.delayMult) : defDelay);
      }
      layout();
    }
    return statePayload();
  });
  ipcMain.handle("vt-slot-set-creds", (_e, id, user, pass) => {
    const s = id != null ? slots.get(id) : null;
    if (s) {
      s._creds = { user: String(user || ""), pass: String(pass || "") };
      s.refreshPage("creds-updated", true);
    }
    return statePayload();
  });
  ipcMain.handle("vt-slot-set-flags", (_e, id, flags) => {
    const s = id != null ? slots.get(id) : null;
    if (!s) return statePayload();
    if (flags) {
      if (flags.zoom) s.setZoom(Number(flags.zoom));
      if (flags.hud !== undefined) s.setHud(!!flags.hud);
      if (flags.delayMult) s.setDelay(Number(flags.delayMult));
      if (flags.accountName !== undefined) {
        s.accountName = String(flags.accountName || "");
        s.name = s.accountName || `Slot ${slots.size + ghosts.size + 1}`;
      }
      const sp = (settings.slots = settings.slots || {});
      sp[id] = Object.assign({}, sp[id], {
        zoom: flags.zoom || 1,
        hud: flags.hud !== false,
        delayMult: flags.delayMult || 1,
        accountName: flags.accountName || ""
      });
      writeJson(SETTINGS_FILE, settings);
      writeSlotsFile();
    }
    return statePayload();
  });
  ipcMain.handle("vt-slot-boot", (_e, id) => {
    bootSlot(id, `Slot ${slots.size + ghosts.size + 1}`);
    return statePayload();
  });
  ipcMain.handle("vt-slot-logout", async (_e, id) => {
    const s = id != null ? slots.get(id) : null;
    if (s) {
      try {
        const ses = s.view.webContents.session;
        await ses.clearStorageData();
        s.status("Logged out. Reloading...");
      } catch (e) {}
      s.refreshPage("logout", true);
    }
    return statePayload();
  });
  ipcMain.handle("vt-state-get", () => statePayload());
  ipcMain.handle("vt-slot-settings", () => ({}));
  ipcMain.handle("vt-scroll-slots", (_e, delta) => { scrollSlots(delta); });
  ipcMain.handle("vt-get-creds", (_e, id) => {
    const s = id != null ? slots.get(id) : null;
    return s && s._creds ? s._creds : null;
  });
  ipcMain.handle("vt-win-minimize", () => { if (win) win.minimize(); });
  ipcMain.handle("vt-win-close", () => { if (win) win.close(); });
  ipcMain.handle("vt-server-restart", () => {
    if (win) win.webContents.send("vt-server-action", "restart");
    for (const [id, slot] of slots) { slot.refreshPage("manual-restart", true); }
  });
  ipcMain.handle("vt-server-stop", () => {
    if (win) win.webContents.send("vt-server-action", "stop");
    for (const [id, slot] of slots) { slot.manualPause(); }
    writeSlotsFile();
  });
  ipcMain.handle("vt-server-start", () => {
    if (win) win.webContents.send("vt-server-action", "start");
    writeSlotsFile();
    for (const [id, slot] of slots) { slot.manualResume(); }
  });
  ipcMain.handle("vt-win-minimize-to-tray", () => { if (win) win.hide(); });
  ipcMain.handle("vt-set-task-mode", (_e, mode) => {
    settings.taskMode = (mode === "math") ? "math" : "color";
    writeJson(SETTINGS_FILE, settings);
    for (const [, s] of slots) { s.taskMode = settings.taskMode; }
    return { taskMode: settings.taskMode };
  });
  ipcMain.handle("vt-get-task-mode", () => ({ taskMode: settings.taskMode || "color" }));
  ipcMain.handle("vt-debug-images", async () => {
    const firstSlot = slots.values().next().value;
    if (!firstSlot) return { error: "no slots" };
    try {
      const images = await firstSlot.api("debugListImages");
      return { images, slotUrl: firstSlot.currentUrl };
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle("vt-settings-set-start-minimized", (_e, enabled) => {
    settings.startMinimized = !!enabled;
    startMinimized = !!enabled;
    writeJson(SETTINGS_FILE, settings);
    return { success: true };
  });
  ipcMain.handle("vt-settings-open", () => { openSettings(); });
  ipcMain.handle("vt-settings-close", () => { closeSettingsWin(); });
  ipcMain.handle("vt-desktop-shortcut", () => {
    return new Promise((resolve) => {
      try {
        const desktop = path.join(app.getPath("desktop"), "VisionTap Slots.lnk");
        const target = process.execPath;
        const args = app.isPackaged ? "" : ".";
        const cwd = app.isPackaged ? path.dirname(process.execPath) : __dirname;
        const script =
          `$w = New-Object -ComObject WScript.Shell; ` +
          `$s = $w.CreateShortcut('${desktop.replace(/'/g, "''")}'); ` +
          `$s.TargetPath = '${target.replace(/'/g, "''")}'; ` +
          `$s.Arguments = '${args}'; ` +
          `$s.WorkingDirectory = '${cwd.replace(/'/g, "''")}'; ` +
          `$s.IconLocation = '${target.replace(/'/g, "''")},0'; ` +
          `$s.Description = 'VisionTap Slots'; $s.Save()`;
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], (err) => {
          resolve(!err);
        });
      } catch (e) { resolve(false); }
    });
  });
}

// ---- Window ----
function createWindow() {
  const def = { width: 1440, height: 800 };
  let w = def.width;
  let h = def.height;
  const ws = settings.windowSize || {};
  if (ws.width >= 340 && ws.height >= 560) {
    w = Math.round(ws.width);
    h = Math.round(ws.height);
  } else {
    const bounds = readJson(WIN_BOUNDS_FILE, {});
    if (bounds.width >= 340 && bounds.width <= 700 && bounds.height >= 560 && bounds.height <= 1200) {
      w = Math.round(bounds.width);
      h = Math.round(bounds.height);
    }
  }
  try {
    const area = screen.getDisplayMatching({ x: 0, y: 0, width: w, height: h }).workArea;
    w = Math.min(w, area.width);
    h = Math.min(h, area.height);
  } catch (e) {}
  win = new BrowserWindow({
    width: w,
    height: h,
    center: true,
    minWidth: 700,
    minHeight: 560,
    frame: false,
    show: false,
    backgroundColor: "#0b1020",
    webPreferences: {
      preload: path.join(__dirname, "preload", "shellpreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      offscreen: false,
      webSecurity: false,
      allowRunningInsecureContent: false,
      spellcheck: false,
      enableWebSQL: false,
      cache: false
    }
  });
  win.loadFile(path.join(__dirname, "shell", "shell.html"));

  win.on("ready-to-show", () => {
    if (startMinimized) { win.minimize(); win.hide(); }
    else { win.maximize(); win.show(); }
  });

  win.on("resize", layout);
  win.on("maximize", layout);
  win.on("unmaximize", layout);
  // Mouse wheel scrolls all slots together
  win.on("wheel", (_e, details) => {
    if (details.deltaY !== 0) scrollSlots(details.deltaY * 2);
  });
  win.on("show", () => { for (const s of slots.values()) { if (s.pausedByWindow && !s.dashboardPaused) s.setPaused(false); } });
  win.on("minimize", () => { if (pauseOnHidden) for (const s of slots.values()) { s.pausedByWindow = true; s.setPaused(true); } });
  win.on("closed", () => { win = null; });
  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    writeJson(WIN_BOUNDS_FILE, win.getBounds());
  };
  win.on("resize", () => { clearTimeout(win._bsT); win._bsT = setTimeout(saveBounds, 800); });
  win.on("move", () => { clearTimeout(win._bsT); win._bsT = setTimeout(saveBounds, 800); });
  win.on("close", saveBounds);
  // Poll credentials.json for dashboard edits — hot-reload into running slots
  let lastCredMtime = 0;
  setInterval(() => {
    try {
      const stat = fs.statSync(CREDS_FILE);
      const mt = stat.mtimeMs;
      if (mt !== lastCredMtime) {
        lastCredMtime = mt;
        const allCreds = readCreds();
        // Account passwords are loaded only from the private credentials file.
        for (const [id, slot] of slots) {
          const c = allCreds[id] || allCreds[slot.accountName] || null;
          if (c && (c.user !== (slot._creds && slot._creds.user) || c.pass !== (slot._creds && slot._creds.pass))) {
            const wasEmpty = !(slot._creds && slot._creds.user);
            slot._creds = { user: String(c.user || ""), pass: String(c.pass || "") };
            if (!wasEmpty) {
              console.log(`[CREDS] Updated slot ${id} user=${c.user}, refreshing...`);
              setTimeout(() => slot.refreshPage("creds-updated", true), 0);
            } else {
              console.log(`[CREDS] Initial load slot ${id} user=${c.user}`);
            }
          }
        }
      }
    } catch (e) { console.error(`[CREDS] Error:`, e.message); }
  }, 2000);
  // Separate command files prevent rapid dashboard clicks from overwriting one another.
  function applyDashboardCommand(cmd) {
    const targets = cmd.slot === 'all' ? [...slots.values()] : [slots.get(String(cmd.slot))].filter(Boolean);
    for (const slot of targets) {
      if (cmd.action === 'pause') slot.manualPause();
      else if (cmd.action === 'resume') slot.manualResume();
      else if (cmd.action === 'restart' || cmd.action === 'refresh') slot.hardRestart();
      else if (cmd.action === 'remove') removeSlot(String(slot.id));
    }
    writeSlotsFile();
    broadcastState();
    appendLog('[CMD]', cmd.action + ' slot=' + cmd.slot + ' applied');
  }
  setInterval(() => {
    try { drain(path.join(STATE_DIR, 'commands'), applyDashboardCommand); }
    catch (e) { appendLog('[CMD]', e.message); }
  }, 250);

}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 460, height: 720, minWidth: 380, minHeight: 480,
    frame: false, alwaysOnTop: true, backgroundColor: "#0b1020",
    webPreferences: {
      preload: path.join(__dirname, "preload", "shellpreload.js"),
      contextIsolation: true, nodeIntegration: false
    }
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, "shell", "shell.html"), { query: { mode: "settings" } });
  settingsWin.on("closed", () => { settingsWin = null; });
}

function closeSettingsWin() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
}

// ---- System tray ----
function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, "shell", "icon.png");
  try {
    tray = new Tray(iconPath);
    tray.setToolTip("VisionTap Slots");
    const contextMenu = Menu.buildFromTemplate([
      { label: "Show Window", click: () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } } },
      { label: "Hide to Tray", click: () => { if (win && !win.isDestroyed()) { win.hide(); } } },
      { type: "separator" },
      { label: "Quit", click: () => { app.quit(); } }
    ]);
    tray.setContextMenu(contextMenu);
    tray.on("double-click", () => {
      if (win && !win.isDestroyed()) {
        if (win.isVisible()) win.hide();
        else { win.show(); win.focus(); }
      }
    });
  } catch (e) {
    console.warn("[VisionTap] Tray creation failed:", e.message);
  }
}

// ---- Boot ----
const BUILD_STAMP = "2026-09-11-colors-only";
app.whenReady().then(() => {
  appendLog("[boot]", `BUILD ${BUILD_STAMP}`);
  ensureStateDir();
  ensureKyaikoMathIntegrity();
  ensureScripts(INJECT_PATH);
  initIpc();
  createTray();
  createWindow();
  layout();
  applyLoginItem();

  const saved = readSlotsFile();
  for (const s of startupSlots(saved)) {
    createSlot(s.id, s.accountName, !!s.stopRequested, {
      bootsOnStart: true, accountName: s.accountName, taskMode: s.taskMode || (String(s.id)==="14"||String(s.accountName||"").toLowerCase()==="kyaiko" ? "math" : "color"), paused: !!s.paused
    });
  }
  slotSeq = Math.max(slotSeq, 17);
  broadcastState();
  writeSlotsFile();
}).catch((err) => {
  console.error("[VisionTap] boot error:", err);
});

app.on("window-all-closed", () => {
  if (tray) return;
  for (const s of slots.values()) s.stopLoop("App closing.");
  app.quit();
});
