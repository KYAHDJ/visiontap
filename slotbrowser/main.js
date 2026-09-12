// VisionTap Slots - main process.
// One app window with N isolated WebContentsView slots, each locked to
// ecnlmediamarket.com/solving-colors. OCR via local scanner.

const { app, BrowserWindow, WebContentsView, session, ipcMain, screen, Tray, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const { Slot, ensureScripts } = require("./slot.js");

const WORK_URL = "https://ecnlmediamarket.com/solving-colors";
const COLORS_RE = /\/solving-colors/;

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

let settings = readJson(SETTINGS_FILE, { adBlock: true });

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

function writeSlotsFile() {
  const active = [];
  for (const s of slots.values()) {
    active.push({ id: s.id, name: s.name, stopRequested: s.loopStopRequested, bootsOnStart: s.bootsOnStart !== false });
  }
  for (const g of ghosts.values()) {
    active.push({ id: g.id, name: g.name, stopRequested: true, bootsOnStart: false });
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

function appendLog(label, msg) {
  const line = `[${new Date().toISOString()}] ${label} ${msg}`;
  console.warn(line);
  try { fs.appendFileSync(path.join(STATE_DIR, "app.log"), line + "\n"); } catch (e) {}
}

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
const PHONE_W = 360;
const PHONE_ASPECT = 0.52;
const GUTTER = 8;

function layout() {
  if (!win || win.isDestroyed()) return;
  const list = Array.from(slots.values());
  if (!list.length) return;
  const [w, h] = win.getContentSize();
  const ch = h - TOOLBAR_H;
  const phoneW = Math.round(Math.min(PHONE_W, ch * PHONE_ASPECT));
  const cols = Math.min(list.length, Math.max(1, Math.floor((w + GUTTER) / (phoneW + GUTTER))));
  const rows = Math.ceil(list.length / cols);
  const cw = w / cols;
  const cellH = ch / rows;
  const slotW = Math.min(cw, Math.round(cellH * PHONE_ASPECT), phoneW);
  list.forEach((s, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    s.view.setBounds({
      x: Math.round(c * cw + (cw - slotW) / 2),
      y: Math.round(TOOLBAR_H + r * cellH),
      width: slotW,
      height: Math.round(cellH)
    });
  });
}

function autoFitWindow() {
  if (!win || win.isDestroyed() || win.isMaximized()) return;
  const n = slots.size;
  if (n === 0) return;
  const { width: scrW, height: scrH } = screen.getPrimaryDisplay().workAreaSize;
  const phoneW = Math.round(Math.min(PHONE_W, (scrH * 0.85 - TOOLBAR_H) * PHONE_ASPECT));
  const cols = Math.min(n, Math.max(1, Math.floor((scrW - GUTTER) / (phoneW + GUTTER))));
  const targetW = Math.max(380, cols * (phoneW + GUTTER) + GUTTER);
  const targetH = Math.min(1000, Math.max(560, Math.round(scrH * 0.85)));
  const newX = Math.round(scrW / 2 - targetW / 2);
  const newY = Math.round(scrH / 2 - targetH / 2);
  const [curW, curH] = win.getContentSize();
  const [curX, curY] = win.getPosition();
  const needResize = Math.abs(curW - targetW) > 5 || Math.abs(curH - targetH) > 5;
  const needMove = Math.abs(curX - newX) > 10 || Math.abs(curY - newY) > 10;
  if (needResize || needMove) {
    win.setBounds({ x: newX, y: newY, width: targetW, height: targetH });
    win.once("resize", () => layout());
    setTimeout(() => layout(), 100);
  } else {
    layout();
  }
}

function wireSession(ses) {
  ses.setSpellCheckerEnabled(false);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
}

// ---- Slot management ----
function createSlot(id, name, stopRequested, opts) {
  opts = opts || {};
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

  // Block popups and non-solving-colors navigation
  view.webContents.setWindowOpenHandler(({ url }) => {
    appendLog(`[${name}]`, `POPUP-DENIED: ${url}`);
    if (COLORS_RE.test(url) || /(login|signin|auth)/i.test(url)) {
      view.webContents.loadURL(url).catch(() => {});
    } else if (/ecnlmediamarket\.com/i.test(url)) {
      appendLog(`[${name}]`, `REDIRECT non-colors -> solving-colors: ${url}`);
      view.webContents.loadURL(WORK_URL).catch(() => {});
    }
    return { action: "deny" };
  });

  // Block navigation away from solving-colors (allow login pages)
  view.webContents.on("will-navigate", (_e, url) => {
    if (url && /ecnlmediamarket\.com/i.test(url) && !COLORS_RE.test(url) && !/(login|signin|auth)/i.test(url)) {
      _e.preventDefault();
      appendLog(`[${name}]`, `NAV-BLOCKED: ${url}`);
      view.webContents.loadURL(WORK_URL).catch(() => {});
    }
  });

  const slot = new Slot({ id, name, view, logger: (m) => appendLog(`[${name}]`, m) });
  slot.bootsOnStart = opts.bootsOnStart !== false;
  slot.setPaused(!(win && win.isVisible()));
  slot.attach();
  view.setVisible(true);
  win.contentView.addChildView(view);

  const s = (settings.slots && settings.slots[id]) || {};
  const defZoom = settings.zoomDefault ? Number(settings.zoomDefault) / 100 : 1;
  const defDelay = settings.delayMult || 1;
  slot.setZoom(s.zoom ? Number(s.zoom) : defZoom);
  slot.setHud(s.hud !== false);
  slot.setDelay(s.delayMult ? Number(s.delayMult) : defDelay);

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

  // Always load solving-colors
  slot.view.webContents.loadURL(WORK_URL).catch(() => {});
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
    createSlot(g.id, g.name || name, g.stopRequested || false, { bootsOnStart: true });
    writeSlotsFile();
    return;
  }
  if (!slots.has(id)) {
    createSlot(String(id), name || `Slot ${slots.size + ghosts.size + 1}`, false, { bootsOnStart: true });
    writeSlotsFile();
  }
}

// ---- IPC ----
function initIpc() {
  ipcMain.handle("vt-slot-add", () => {
    const id = String(slotSeq++);
    const n = slots.size + 1;
    createSlot(id, `Slot ${n}`, false);
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
    const creds = readCreds();
    creds[id] = { user: String(user || ""), pass: String(pass || "") };
    writeJson(CREDS_FILE, creds);
    const s = id != null ? slots.get(id) : null;
    if (s) s.refreshPage("creds-updated", true);
    return statePayload();
  });
  ipcMain.handle("vt-slot-set-flags", (_e, id, flags) => {
    const s = id != null ? slots.get(id) : null;
    if (!s) return statePayload();
    if (flags) {
      if (flags.zoom) s.setZoom(Number(flags.zoom));
      if (flags.hud !== undefined) s.setHud(!!flags.hud);
      if (flags.delayMult) s.setDelay(Number(flags.delayMult));
      const sp = (settings.slots = settings.slots || {});
      sp[id] = Object.assign({}, sp[id], {
        zoom: flags.zoom || 1,
        hud: flags.hud !== false,
        delayMult: flags.delayMult || 1
      });
      writeJson(SETTINGS_FILE, settings);
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
  ipcMain.handle("vt-get-creds", (_e, id) => {
    const creds = readCreds();
    return creds[id] || null;
  });
  ipcMain.handle("vt-win-minimize", () => { if (win) win.minimize(); });
  ipcMain.handle("vt-win-close", () => { if (win) win.close(); });
  ipcMain.handle("vt-server-restart", () => {
    if (win) win.webContents.send("vt-server-action", "restart");
    for (const [id, slot] of slots) { slot.reload(); }
  });
  ipcMain.handle("vt-server-stop", () => {
    if (win) win.webContents.send("vt-server-action", "stop");
    for (const [id, slot] of slots) { slot.setPaused(true); }
    stopRequested = true;
  });
  ipcMain.handle("vt-server-start", () => {
    if (win) win.webContents.send("vt-server-action", "start");
    stopRequested = false;
    for (const [id, slot] of slots) { slot.setPaused(false); slot.ensureRunning(); }
  });
  ipcMain.handle("vt-win-minimize-to-tray", () => { if (win) win.hide(); });
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
  const def = { width: 380, height: 700 };
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
    minWidth: 340,
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
    else win.show();
  });

  win.on("resize", layout);
  win.on("maximize", layout);
  win.on("unmaximize", layout);
  win.on("show", () => { for (const s of slots.values()) s.setPaused(false); });
  win.on("minimize", () => { if (pauseOnHidden) for (const s of slots.values()) s.setPaused(true); });
  win.on("closed", () => { win = null; });
  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    writeJson(WIN_BOUNDS_FILE, win.getBounds());
  };
  win.on("resize", () => { clearTimeout(win._bsT); win._bsT = setTimeout(saveBounds, 800); });
  win.on("move", () => { clearTimeout(win._bsT); win._bsT = setTimeout(saveBounds, 800); });
  win.on("close", saveBounds);
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
  ensureScripts(INJECT_PATH);
  initIpc();
  createTray();
  createWindow();
  layout();
  applyLoginItem();

  const saved = readSlotsFile();
  if (saved.active) {
    for (const s of saved.active) {
      const boots = s.bootsOnStart !== false;
      if (boots) {
        createSlot(s.id, s.name || `Slot ${slotSeq + 1}`, !!s.stopRequested, { bootsOnStart: true });
      } else {
        ghosts.set(s.id, { id: s.id, name: s.name || `Slot ${slotSeq + 1}` });
      }
    }
  }
  if (slots.size === 0 && ghosts.size === 0) {
    createSlot(String(slotSeq++), "Slot 1", false, { bootsOnStart: true });
  }
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
