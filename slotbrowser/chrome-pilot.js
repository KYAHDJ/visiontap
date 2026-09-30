#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const { ChromeEncashmentController } = require('./chrome-encashment');

const ACCOUNT = String(process.env.VT_ACCOUNT || 'adaihbi').trim().toLowerCase();
const SLOT_ID = String(process.env.VT_SLOT_ID || '11');
const TASK_MODE = process.env.VT_TASK_MODE === 'math' || ACCOUNT === 'kyaiko' ? 'math' : 'color';
const LOGIN_URL = TASK_MODE === 'math' ? 'https://pmath100.com/login' : 'https://ecnlmediamarket.com/login';
const WORK_URL = TASK_MODE === 'math' ? 'https://pmath100.com/games-mathproblem#' : 'https://ecnlmediamarket.com/solving-colors';
const SUBMIT_DELAYS = { adaihbi: 0, temi: 400, axceling1001: 700, darlenejoyce: 0, kyaiko: 0 };
const SUBMIT_DELAY_MS = Number(process.env.VT_SUBMIT_DELAY_MS ?? SUBMIT_DELAYS[ACCOUNT] ?? 0);
const ENCASHMENT_ACCOUNTS = new Set(['adaihbi', 'temi', 'axceling1001']);
const STALL_RESET_MS = 15000;
const SCANNER_URL = 'http://127.0.0.1:5566';
const IS_WIN = process.platform === 'win32';
const DEFAULT_USER_DATA = IS_WIN
  ? path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')
  : path.join(os.homedir(), '.config', 'VisionTap-Chrome', ACCOUNT);
const DEFAULT_CHROME = IS_WIN
  ? path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
  : '/opt/google/chrome/chrome';
const INJECT_PATH = path.join(__dirname, 'inject', 'slot_inject.js');
const AD_BLOCK_PATH = path.join(__dirname, 'inject', 'ad_blocker.js');
const SCANNER_PATH = path.join(__dirname, '..', 'pcapp', 'scanner', 'server.py');
const PILOT_STATE_DIR = process.env.VT_PILOT_STATE_DIR || (IS_WIN
  ? path.join(process.env.APPDATA || os.homedir(), 'VisionTap Slots', 'state')
  : path.join(os.homedir(), '.config', 'VisionTap Slots', 'state'));
const PILOT_STATE_FILE = path.join(PILOT_STATE_DIR, `chrome_${ACCOUNT}_state.json`);
const PILOT_COMMAND_FILE = path.join(PILOT_STATE_DIR, `chrome_${ACCOUNT}_command.json`);
const CREDENTIALS_FILE = path.join(PILOT_STATE_DIR, 'credentials.json');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hashImage = data => {
  if (!data) return null;
  const s = data.slice(data.indexOf(',') + 1);
  let h = 0;
  const step = Math.max(1, Math.floor(s.length / 512));
  for (let i = 0; i < s.length; i += step) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
};

function isVerificationUrl(url) {
  return /challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform|\/cdn-cgi\/challenge/i.test(String(url || ''));
}

async function fetchJson(url, init = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

class ChromePilot {
  constructor(options = {}) {
    this.userDataDir = options.userDataDir || process.env.VT_CHROME_USER_DATA || DEFAULT_USER_DATA;
    this.profile = options.profile || process.env.VT_CHROME_PROFILE || 'Default';
    this.executablePath = options.executablePath || process.env.VT_CHROME_PATH || DEFAULT_CHROME;
    this.workUrl = WORK_URL;
    this.headless = options.headless === true;
    this.context = null;
    this.page = null;
    this.scannerProcess = null;
    this.running = true;
    this.paused = false;
    this.verificationHold = false;
    this.processing = false;
    this.stopped = false;
    this.epoch = 1;
    this.taskCount = 0;
    this.errorCount = 0;
    this.pending = null;
    this.lastSubmittedHash = null;
    this.lastErrorHash = null;
    this.lastObservedHash = null;
    this.consecutiveDetectFails = 0;
    this.consecutiveNoImage = 0;
    this.notReadySince = 0;
    this.nextIterationAt = 0;
    this.lastActivityAt = Date.now();
    this.lastProgressAt = this.lastActivityAt;
    this.lastReloadAt = 0;
    this.recoveryReloads = 0;
    this.startedAt = Date.now();
    this.loopStartTime = this.startedAt;
    this.lastDashboardSyncAt = 0;
    this.lastDashboardMetaKey = '';
    this.pointsDone = null;
    this.pointsTotal = 250;
    this.withdrawable = null;
    this.statusText = `Starting ${ACCOUNT} Chrome pilot…`;
    this.injectSource = fs.readFileSync(INJECT_PATH, 'utf8');
    this.adBlockSource = fs.readFileSync(AD_BLOCK_PATH, 'utf8');
    this.lastCommandNonce = null;
    this.verificationClearStreak = 0;
    this.lastHoldScreenshotAt = 0;
    this.resumeArmed = false;
    this.encashment = ENCASHMENT_ACCOUNTS.has(ACCOUNT) ? new ChromeEncashmentController(this, PILOT_STATE_DIR, ACCOUNT) : null;
  }

  log(message) {
    const line = `[${new Date().toISOString()}] [${ACCOUNT}-chrome] ${message}`;
    process.stdout.write(`${line}\n`);
  }

  async scannerReady() {
    try { return (await fetchJson(`${SCANNER_URL}/health`, {}, 2500)).status === 'online'; }
    catch (_) { return false; }
  }

  async ensureScanner() {
    if (await this.scannerReady()) return true;
    if (!fs.existsSync(SCANNER_PATH)) throw new Error(`Scanner not found: ${SCANNER_PATH}`);
    const python = process.env.VT_PYTHON || path.join(process.env.LOCALAPPDATA || '', 'Python', 'bin', 'pythonw.exe');
    this.log('Local scanner is offline; starting it.');
    this.scannerProcess = spawn(fs.existsSync(python) ? python : 'python', [SCANNER_PATH], {
      cwd: path.dirname(SCANNER_PATH), detached: false, stdio: 'ignore', windowsHide: true
    });
    this.scannerProcess.unref();
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      if (await this.scannerReady()) return true;
    }
    return false;
  }

  async restoreDashboardCounters() {
    try {
      const stats = await fetchJson(`${SCANNER_URL}/stats`, {}, 5000);
      const saved = stats?.slots?.[SLOT_ID];
      if (!saved) return;
      this.taskCount = Number(saved.taskCount) || 0;
      // Ignore stale transient errors left by a previous worker.
      // Keep completed work, but let this Chrome pilot own its error count.
      this.errorCount = 0;
      this.pointsDone = saved.pointsDone ?? null;
      this.pointsTotal = saved.pointsTotal || 250;
      this.withdrawable = saved.withdrawable ?? null;
      this.log(`Restored dashboard counters: tasks=${this.taskCount}, points=${this.pointsDone ?? '?'}/${this.pointsTotal}`);
    } catch (_) {}
  }

  async start() {
    if (!fs.existsSync(this.userDataDir)) throw new Error(`Chrome user-data directory not found: ${this.userDataDir}`);
    if (!fs.existsSync(this.executablePath)) throw new Error(`Chrome executable not found: ${this.executablePath}`);
    this.log(`Using existing Chrome profile ${this.profile} at ${this.userDataDir}`);
    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      executablePath: this.executablePath,
      headless: this.headless,
      viewport: null,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        `--profile-directory=${this.profile}`,
        ...(process.env.VT_WINDOW_SIZE ? [`--window-size=${process.env.VT_WINDOW_SIZE}`] : []),
        ...(process.env.VT_WINDOW_POSITION ? [`--window-position=${process.env.VT_WINDOW_POSITION}`] : []),
        ...(IS_WIN ? [] : ['--no-sandbox', '--disable-dev-shm-usage']),
        '--disable-blink-features=AutomationControlled',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows'
        ,'--disable-notifications'
        ,'--hide-crash-restore-bubble'
        ,'--disable-session-crashed-bubble'
      ]
    });
    this.log('Chrome context is connected.');

    const pages = this.context.pages();
    this.page = pages.find(p => /ecnlmediamarket\.com|pmath100\.com/i.test(p.url())) || pages[0] || await this.context.newPage();
    for (const extra of pages) if (extra !== this.page && extra.url() === 'about:blank') await extra.close().catch(() => {});
    await this.positionWindow();

    this.log('Dashboard file controls are connected.');
    this.context.on('page', p => this.guardPage(p));
    await this.guardPage(this.page);
    this.log(`Initial tab selected: ${this.page.url()}`);

    if (!/\/login/i.test(this.page.url())) {
      this.log(`Opening the ${ACCOUNT} login verification entry page.`);
      await this.page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 30000 });
      await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    }
    this.log(`Login entry reached: ${this.page.url()}`);
    this.verificationHold = true;
    await this.setStatus('Complete verification on the login page. The work loop will start automatically afterward.');
    if (!await this.ensureScanner()) this.log('Scanner remains offline; the loop will keep retrying without submitting.');
    else await this.restoreDashboardCounters();
    this.encashment?.start();
    this.log(`${ACCOUNT} pilot started. Close Chrome or use Stop in the dashboard to end it.`);
    await this.loop();
  }

  async guardPage(page) {
    await page.exposeFunction('__vtSignal', msg => this.handlePageSignal(msg)).catch(() => {});
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        this.lastActivityAt = Date.now();
        this.pending = null;
      }
    });
    page.on('close', () => { if (page === this.page) this.stopped = true; });
  }

  async handlePageSignal(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'vt_log') { this.log(msg.msg || 'Page message'); return; }
    if (msg.type !== 'stale_refresh' || TASK_MODE !== 'math') return;
    if (this.paused || this.verificationHold || Date.now() - this.lastProgressAt < 60000) return;
    await this.restartStalledWorker(`page-stale:${msg.src || '?'}`);
  }

  async restartStalledWorker(reason) {
    if (this.paused || this.verificationHold || await this.detectVerification()) return false;
    this.log(`INACTIVITY-GUARD: no PMath progress for 60 seconds (${reason}); restarting only ${ACCOUNT}.`);
    process.exitCode = 75;
    this.running = false;
    await this.setStatus(`Restarting ${ACCOUNT} after 60 seconds without PMath progress…`);
    await this.context?.close().catch(() => {});
    return true;
  }

  async positionWindow() {
    const size = String(process.env.VT_WINDOW_SIZE || '').split(',').map(Number);
    const position = String(process.env.VT_WINDOW_POSITION || '').split(',').map(Number);
    if (size.length !== 2 || position.length !== 2 || [...size, ...position].some(Number.isNaN)) return;
    try {
      const session = await this.context.newCDPSession(this.page);
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', { windowId, bounds: { left:position[0], top:position[1], width:size[0], height:size[1], windowState:'normal' } });
      await session.detach();
      this.log(`Window positioned at ${position.join(',')} size ${size.join(',')}`);
    } catch (error) { this.log(`Window positioning warning: ${error.message}`); }
  }

  bootstrapScript() {
    return `(() => {
      if (window.__vtChromePilotBootstrapped) return;
      window.__vtChromePilotBootstrapped = true;
      window.__vtAutomation = { enabled: true, epoch: 1 };
      const verification = () => {
        const text = (document.body?.innerText || '').toLowerCase();
        return /verify you are human|performing security verification|checking your browser|security check|just a moment/.test(text) ||
          !!document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="/cdn-cgi/challenge-platform"], input[name="cf-turnstile-response"], .cf-turnstile');
      };
      const removeAds = () => {
        const selectors = ['iframe[src*="googleads"]','iframe[src*="doubleclick"]','iframe[id*="aswift"]','.adsbygoogle','ins.adsbygoogle','#google_vignette','.google-auto-placed','[aria-label*="advertisement" i]'];
        for (const sel of selectors) document.querySelectorAll(sel).forEach(el => el.remove());
        document.querySelectorAll('div,section,aside').forEach(el => {
          const text = (el.innerText || '').toLowerCase();
          if (!/unlock more contents|view a short ad|watch ad to unlock|please allow ads|disable.{0,12}ad.?block/.test(text)) return;
          if (el.querySelector('input,canvas,#vt-pilot-dashboard')) return;
          const s = getComputedStyle(el), r = el.getBoundingClientRect();
          if (s.position === 'fixed' || s.position === 'absolute' || Number(s.zIndex) > 50 || (r.width > 200 && r.height > 100)) el.remove();
        });
      };
      const dashboard = () => {
        return null;
        let root = document.getElementById('vt-pilot-dashboard');
        if (!root) {
          root = document.createElement('section'); root.id = 'vt-pilot-dashboard';
          root.innerHTML = '<div class="vt-card"><div class="vt-kicker">VISIONTAP · ADAIHBI</div><h1 id="vt-title">Chrome pilot</h1><p id="vt-status">Starting…</p><div class="vt-stats"><span>Tasks <b id="vt-tasks">0</b></span><span>Errors <b id="vt-errors">0</b></span><span>Time <b id="vt-time">00:00</b></span></div><div class="vt-actions"><button data-a="pause">Pause</button><button data-a="resume">Resume</button><button data-a="reload">Safe reload</button><button data-a="stop" class="danger">Stop</button></div><p class="vt-help">Automation and auto-refresh stay paused while verification is visible. Complete it manually; solving resumes automatically.</p></div>';
          const style = document.createElement('style'); style.id = 'vt-pilot-style';
          style.textContent = '#vt-pilot-dashboard{position:fixed;right:16px;top:16px;z-index:2147483647;font:13px system-ui;color:#eef2ff;pointer-events:none}#vt-pilot-dashboard .vt-card{width:300px;background:rgba(9,12,20,.96);border:1px solid #334155;border-radius:16px;padding:18px;box-shadow:0 20px 70px rgba(0,0,0,.55);pointer-events:auto}#vt-pilot-dashboard.verify{inset:0;display:grid;place-items:center;background:rgba(2,6,23,.72);backdrop-filter:blur(7px);pointer-events:auto}#vt-pilot-dashboard.verify .vt-card{width:min(440px,calc(100vw - 48px));text-align:center;border-color:#f59e0b;box-shadow:0 28px 100px rgba(0,0,0,.75)}#vt-pilot-dashboard .vt-kicker{font-size:11px;letter-spacing:.16em;color:#38bdf8;font-weight:800}#vt-pilot-dashboard h1{font-size:22px;margin:7px 0}#vt-pilot-dashboard p{margin:6px 0 14px;color:#a5b4c8;line-height:1.45}#vt-pilot-dashboard .vt-stats{display:flex;gap:8px;margin:12px 0}#vt-pilot-dashboard .vt-stats span{flex:1;background:#111827;border:1px solid #263244;border-radius:9px;padding:8px 5px;text-align:center;color:#94a3b8}#vt-pilot-dashboard .vt-stats b{display:block;color:#f8fafc;margin-top:3px}#vt-pilot-dashboard .vt-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}#vt-pilot-dashboard button{border:1px solid #475569;border-radius:9px;background:#1e293b;color:#f8fafc;padding:9px;cursor:pointer;font-weight:700}#vt-pilot-dashboard button:hover{background:#334155}#vt-pilot-dashboard button.danger{border-color:#7f1d1d;color:#fecaca}#vt-pilot-dashboard .vt-help{font-size:12px;margin:12px 0 0}';
          document.documentElement.appendChild(style); document.body.appendChild(root);
          root.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => window.__vtPilotControl(btn.dataset.a)));
        }
        return root;
      };
      window.__vtPilotUI = state => {
        return;
        const root = dashboard();
        root.classList.toggle('verify', !!state.verification);
        root.querySelector('#vt-title').textContent = state.verification ? 'Manual verification required' : (state.paused ? 'Pilot paused' : 'Chrome pilot running');
        root.querySelector('#vt-status').textContent = state.status || '';
        root.querySelector('#vt-tasks').textContent = state.tasks || 0;
        root.querySelector('#vt-errors').textContent = state.errors || 0;
        root.querySelector('#vt-time').textContent = state.time || '00:00';
      };
      let timer = null; const scan = () => { timer = null; if (!verification()) removeAds(); };
      new MutationObserver(() => { if (timer == null) timer = setTimeout(scan, 250); }).observe(document.documentElement,{childList:true,subtree:true});
      addEventListener('DOMContentLoaded', () => { removeAds(); dashboard(); }, {once:true});
    })();`;
  }

  async installPageRuntime() {
    if (!this.page || this.page.isClosed()) return;
    if (!isVerificationUrl(this.page.url()) && /ecnlmediamarket\.com|pmath100\.com/i.test(this.page.url())) {
      await this.page.evaluate(() => { window.__vtHost = { signal: msg => window.__vtSignal(msg) }; }).catch(() => {});
      await this.page.evaluate(this.adBlockSource).catch(() => {});
      await this.page.evaluate(this.injectSource).catch(() => {});
      await this.page.evaluate(account => { if (!document.title.startsWith(`[${account}] `)) document.title = `[${account}] ${document.title}`; }, ACCOUNT).catch(() => {});
      await this.page.evaluate(({ epoch, enabled }) => { window.__vtAutomation = { epoch, enabled }; }, { epoch: this.epoch, enabled: !this.paused }).catch(() => {});
    }
    await this.updateOverlay();
  }

  async detectVerification() {
    if (!this.page || this.page.isClosed()) return false;
    if (isVerificationUrl(this.page.url())) return true;
    return this.page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      const visible = el => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
      const challenge = Array.from(document.querySelectorAll('iframe[src*="challenges.cloudflare.com"], iframe[src*="/cdn-cgi/challenge-platform"], .cf-turnstile')).some(visible);
      return /verify you are human|performing security verification|checking your browser|just a moment/.test(text) || challenge;
    }).catch(() => false);
  }

  loadCredentials() {
    try {
      const all = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
      const creds = all[SLOT_ID] || all[ACCOUNT] || {};
      return creds.user && creds.pass ? { user: String(creds.user), pass: String(creds.pass) } : null;
    } catch (_) { return null; }
  }

  async tryLogin() {
    const creds = this.loadCredentials();
    if (!creds) return false;
    return this.page.evaluate(({ user, pass }) => {
      const visible = el => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
      const userBox = Array.from(document.querySelectorAll('input[type="email"],input[type="text"],input[name*="user" i],input[name*="email" i],input[name*="phone" i]')).find(visible);
      const passBox = Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
      const button = Array.from(document.querySelectorAll('button,input[type="submit"]')).find(el => visible(el) && (el.type === 'submit' || /log\s?in|sign\s?in|submit|enter/i.test(el.textContent || el.value || '')));
      if (!userBox || !passBox || !button) return false;
      const set = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set(userBox, user); set(passBox, pass); button.click(); return true;
    }, creds).catch(() => false);
  }

  async updateOverlay() {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const time = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
    try {
      fs.mkdirSync(PILOT_STATE_DIR, { recursive: true });
      fs.writeFileSync(PILOT_STATE_FILE, JSON.stringify({
        account: ACCOUNT, slot: SLOT_ID, running: this.running && !this.stopped,
        verificationHold: this.verificationHold, paused: this.paused,
        resumeArmed: this.resumeArmed,
        status: this.statusText, tasks: this.taskCount, errors: this.errorCount,
        time, updatedAt: Date.now(), lastProgressAt: this.lastProgressAt,
        lastReloadAt: this.lastReloadAt, recoveryReloads: this.recoveryReloads
      }, null, 2));
    } catch (error) { this.log(`Could not publish dashboard state: ${error.message}`); }
  }

  async pollDashboardControl() {
    const command = (() => { try { return JSON.parse(fs.readFileSync(PILOT_COMMAND_FILE, 'utf8')); } catch (_) { return null; } })();
    if (!command || !command.nonce || command.nonce === this.lastCommandNonce) return;
    this.lastCommandNonce = command.nonce;
    if (['pause', 'resume', 'reload', 'stop'].includes(command.action)) {
      this.log(`Dashboard control received: ${command.action}`);
      await this.handleControl(command.action);
    }
  }

  async setStatus(text) {
    this.statusText = text;
    await this.updateOverlay();
  }

  async handleControl(action) {
    if (action === 'pause') { this.paused = true; this.epoch++; await this.setStatus('Paused by user.'); }
    if (action === 'resume') {
      this.paused = false; this.epoch++;
      this.resumeArmed = this.verificationHold;
      await this.setStatus(this.verificationHold
        ? 'Resume armed. Complete this account’s verification and solving will start automatically.'
        : 'Resuming solver…');
    }
    if (action === 'reload') await this.safeReload('manual control');
    if (action === 'stop') { this.stopped = true; this.running = false; await this.setStatus('Stopping…'); }
    await this.page?.evaluate(({ epoch, enabled }) => { window.__vtAutomation = { epoch, enabled }; }, { epoch: this.epoch, enabled: !this.paused && !this.verificationHold }).catch(() => {});
    return { ok: true, action };
  }

  async safeReload(reason) {
    if (!this.page || this.page.isClosed()) return false;
    if (this.verificationHold || await this.detectVerification()) {
      this.verificationHold = true;
      await this.setStatus(`Reload blocked during verification (${reason}).`);
      return false;
    }
    if (Date.now() - this.lastReloadAt < 15000) return false;
    const recovery = !/^manual control/.test(reason);
    if (recovery && this.recoveryReloads >= 4 && Date.now() - this.lastProgressAt > 60000) {
      this.log(`Recovery reloads did not restore progress (${reason}); restarting only ${ACCOUNT} with its preserved profile.`);
      process.exitCode = 75;
      this.running = false;
      await this.setStatus(`Restarting ${ACCOUNT} after a persistent page stall…`);
      await this.context?.close().catch(() => {});
      return false;
    }
    this.lastReloadAt = Date.now(); this.pending = null; this.epoch++;
    if (recovery) this.recoveryReloads++;
    this.log(`Safe reload ${this.recoveryReloads}: ${reason}`);
    await this.setStatus(`Safe reload: ${reason}`);
    if (recovery) await this.page.goto(WORK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    else await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await this.installPageRuntime();
    this.lastActivityAt = Date.now();
    this.lastProgressAt = this.lastActivityAt;
    this.consecutiveDetectFails = 0; this.consecutiveNoImage = 0; this.notReadySince = 0;
    return true;
  }

  async callApi(method, arg) {
    return this.page.evaluate(async ({ method, arg }) => {
      if (!window.__vtapi || typeof window.__vtapi[method] !== 'function') return null;
      return window.__vtapi[method](arg);
    }, { method, arg });
  }

  async report(meta = {}) {
    const elapsed = Math.floor((Date.now() - this.loopStartTime) / 1000);
    const timerText = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
    await fetchJson(`${SCANNER_URL}/report`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slot: SLOT_ID, slotName: ACCOUNT, taskCount: this.taskCount,
        correctCount: this.taskCount, wrongCount: 0, errorCount: this.errorCount,
        pointsDone: this.pointsDone, pointsTotal: this.pointsTotal,
        withdrawable: this.withdrawable, timerText, elapsed,
        loopStartTime: this.loopStartTime, ...meta
      })
    }, 5000).catch(() => {});
  }

  async syncDashboardMeta(force = false) {
    const meta = await this.callApi('getTaskMeta').catch(() => null);
    if (meta) {
      if (meta.pointsDone != null && !Number.isNaN(Number(meta.pointsDone))) this.pointsDone = Number(meta.pointsDone);
      if (meta.pointsTotal != null && Number(meta.pointsTotal) > 0) this.pointsTotal = Number(meta.pointsTotal);
      if (meta.withdrawable != null && !Number.isNaN(Number(meta.withdrawable))) this.withdrawable = Number(meta.withdrawable);
    }
    const key = `${this.pointsDone}|${this.pointsTotal}|${this.withdrawable}|${this.taskCount}|${this.errorCount}`;
    if (!force && key === this.lastDashboardMetaKey && Date.now() - this.lastDashboardSyncAt < 5000) return;
    this.lastDashboardMetaKey = key;
    this.lastDashboardSyncAt = Date.now();
    await this.report();
  }

  async iteration() {
    if (this.encashment?.busy) return;
    if (Date.now() < this.nextIterationAt) return;
    const verification = await this.detectVerification();
    if (verification) {
      const firstDetection = !this.verificationHold;
      if (firstDetection) this.log('Manual verification detected; solver and all auto-refresh paths are suspended.');
      this.verificationHold = true;
      this.verificationClearStreak = 0;
      await this.page.evaluate(({ epoch }) => { window.__vtAutomation = { enabled: false, epoch }; }, { epoch: ++this.epoch }).catch(() => {});
      await this.setStatus(this.resumeArmed
        ? 'Resume armed. Complete this account’s verification; solving will start automatically.'
        : 'Complete the verification in Chrome. Nothing will refresh this page.');
      if (firstDetection && process.env.VT_VERIFICATION_SCREENSHOT) {
        await this.page.screenshot({ path: process.env.VT_VERIFICATION_SCREENSHOT, fullPage: false }).catch(() => {});
      }
      return;
    }
    if (this.verificationHold) {
      if (process.env.VT_VERIFICATION_SCREENSHOT && Date.now() - this.lastHoldScreenshotAt > 5000) {
        this.lastHoldScreenshotAt = Date.now();
        await this.page.screenshot({ path: process.env.VT_VERIFICATION_SCREENSHOT, fullPage: false }).catch(() => {});
      }
      const readiness = await this.page.evaluate(() => {
        const onLogin = /\/login/i.test(location.href);
        const onWork = /ecnlmediamarket\.com\/solving-colors|pmath100\.com\/games-mathproblem/i.test(location.href);
        const visible = el => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
        const input = Array.from(document.querySelectorAll('input,textarea')).find(visible);
        const button = Array.from(document.querySelectorAll('button,input[type="submit"],[role="button"]')).find(visible);
        const text = (document.body?.innerText || '').toLowerCase();
        const challengeVisible = Array.from(document.querySelectorAll('iframe[src*="challenges.cloudflare.com"],iframe[src*="/cdn-cgi/challenge-platform"],.cf-turnstile')).some(visible);
        const challenged = /verify you are human|performing security verification|checking your browser|just a moment/.test(text) || challengeVisible;
        const loginReady = onLogin && !!Array.from(document.querySelectorAll('input[type="password"]')).find(visible) && !!input && !!button && !challenged;
        const authenticatedHome = !onLogin && !onWork && !challenged && (/\blogout\b/.test(text) || /pmath100\.com/i.test(location.hostname));
        return { onLogin, onWork, challenged, loginReady, authenticatedHome, workReady: onWork && !!button && !challenged };
      }).catch(() => ({ onLogin: false, onWork: false, challenged: true, loginReady: false, authenticatedHome: false, workReady: false }));
      const clearPage = !readiness.challenged && (readiness.loginReady || readiness.authenticatedHome || readiness.workReady);
      this.verificationClearStreak = clearPage ? this.verificationClearStreak + 1 : 0;
      const requiredClearChecks = (readiness.loginReady || readiness.authenticatedHome) ? 3 : 5;
      if (this.verificationClearStreak < requiredClearChecks) {
        const waitText = readiness.onLogin ? `Waiting for a clear ${ACCOUNT} login form…` : 'Waiting for the task page to remain stable…';
        await this.setStatus(this.resumeArmed
          ? `Resume armed. ${waitText}`
          : `Verification hold is locked. ${waitText}`);
        return;
      }
      if (readiness.loginReady) {
        this.verificationClearStreak = 0;
        await this.setStatus(`Verification cleared. Signing in with the saved ${ACCOUNT} account…`);
        const submitted = await this.tryLogin();
        if (!submitted) await this.setStatus('Saved credentials exist, but the login form is not ready yet.');
        return;
      }
      if (readiness.authenticatedHome) {
        this.verificationClearStreak = 0;
        await this.setStatus(`${ACCOUNT} is signed in. Opening the solving loop once…`);
        await this.page.goto(WORK_URL, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
        await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        return;
      }
      this.verificationHold = false; this.resumeArmed = false; this.verificationClearStreak = 0; this.epoch++; this.lastActivityAt = Date.now();
      await this.installPageRuntime();
      await this.setStatus('Verification cleared and task page stable. Resuming safely…');
    }
    if (this.paused) { await this.updateOverlay(); return; }
    const onExpectedWorkPage = TASK_MODE === 'math'
      ? /pmath100\.com\/games-mathproblem/i.test(this.page.url())
      : /ecnlmediamarket\.com\/solving-colors/i.test(this.page.url());
    if (!onExpectedWorkPage) {
      await this.setStatus(`Waiting on ${ACCOUNT} work page…`);
      return;
    }
    if (!await this.scannerReady()) { await this.ensureScanner(); await this.setStatus('Waiting for local scanner…'); return; }
    await this.installPageRuntime();
    await this.syncDashboardMeta();
    const ready = await this.callApi('checkInputReady');
    if (ready?.checking || ready?.isBlank2026) { await this.safeReload(ready.checking ? 'checking state' : 'blank 2026 page'); return; }
    const grabbed = await this.callApi('grabImage', true);
    const image = grabbed?.imageData;
    if (!image) {
      this.consecutiveNoImage++;
      if (TASK_MODE === 'math') {
        if (Date.now() - this.lastProgressAt >= 60000) await this.restartStalledWorker('no task image');
        else await this.setStatus('PMath has no task image yet. Retrying…');
      } else if (this.consecutiveNoImage >= 3) await this.safeReload('no-image-x3');
      else await this.setStatus(`Waiting for a task image (${this.consecutiveNoImage}/3)…`);
      return;
    }
    this.consecutiveNoImage = 0;
    const imageHash = hashImage(image);
    if (imageHash !== this.lastObservedHash) {
      this.lastObservedHash = imageHash;
      this.lastProgressAt = Date.now();
      this.lastActivityAt = this.lastProgressAt;
      this.recoveryReloads = 0;
      this.consecutiveDetectFails = 0;
      this.notReadySince = 0;
    }
    if (imageHash === this.lastSubmittedHash) {
      if (Date.now() - this.lastProgressAt > STALL_RESET_MS) await this.safeReload('same-image-stall');
      else await this.setStatus('Waiting for the next task…');
      return;
    }
    if (TASK_MODE === 'math') {
      await this.setStatus('Solving the current math task…');
      const result = await fetchJson(`${SCANNER_URL}/solve_math`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image })
      }, 12000).catch(error => ({ error: error.message }));
      if (result.error || result.answer == null || result.answer === '') {
        this.consecutiveDetectFails++;
        if (this.lastErrorHash !== imageHash) { this.errorCount++; this.lastErrorHash = imageHash; }
        if (this.consecutiveDetectFails >= 3) await this.safeReload('math-detect-fail-x3');
        else await this.setStatus(`Math scanner could not verify this task (${this.consecutiveDetectFails}/3): ${result.error || 'no answer'}`);
        return;
      }
      this.consecutiveDetectFails = 0;
      const input = await this.callApi('checkInputReady');
      if (!input?.ready) {
        this.notReadySince ||= Date.now();
        if (Date.now() - this.notReadySince > STALL_RESET_MS) await this.safeReload('math-input-not-ready-stall');
        else await this.setStatus(`Solved ${result.expression || 'task'}; waiting for the answer box…`);
        return;
      }
      this.notReadySince = 0;
      const epoch = this.epoch;
      const answer = String(result.answer).trim();
      const filled = await this.callApi('fill', { answer, delayMs: SUBMIT_DELAY_MS, expectedImage: image, epoch });
      if (epoch !== this.epoch || this.paused || this.verificationHold) return;
      if (filled?.status !== 'filled') {
        this.notReadySince ||= Date.now();
        if (Date.now() - this.notReadySince > STALL_RESET_MS) await this.safeReload('math-submit-not-ready-stall');
        else await this.setStatus(`Submission deferred (${filled?.status || 'not ready'}).`);
        return;
      }
      this.notReadySince = 0;
      this.taskCount++; this.lastSubmittedHash = imageHash; this.lastErrorHash = null; this.lastActivityAt = Date.now(); this.lastProgressAt = this.lastActivityAt;
      const meta = await this.callApi('pmathGetMeta').catch(() => null);
      if (meta?.coins != null && !Number.isNaN(Number(meta.coins))) {
        this.pointsDone = Number(meta.coins); this.withdrawable = Number(meta.coins);
      }
      await this.report({ correct: true, color: result.expression || answer, taskNum: this.taskCount });
      this.log(`Submitted math task ${this.taskCount}: ${result.expression || answer}`);
      this.nextIterationAt = Date.now() + 800;
      await this.setStatus(`Math task ${this.taskCount} submitted. Waiting for the next task…`);
      return;
    }
    if (!this.pending || this.pending.hash !== imageHash) {
      await this.setStatus('Scanning the current task…');
      const result = await fetchJson(`${SCANNER_URL}/detect`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image })
      }, 12000).catch(error => ({ error: error.message }));
      if (!result.color || result.color === 'unknown') {
        this.consecutiveDetectFails++;
        if (this.lastErrorHash !== imageHash) {
          this.errorCount++;
          this.lastErrorHash = imageHash;
        }
        if (this.consecutiveDetectFails >= 3) await this.safeReload('detect-fail-x3');
        else await this.setStatus(`Scanner could not verify this task (${this.consecutiveDetectFails}/3): ${result.error || 'unknown color'}`); return;
      }
      this.consecutiveDetectFails = 0;
      this.lastErrorHash = null;
      this.pending = { hash: imageHash, image, answer: result.color };
    }
    const input = await this.callApi('checkInputReady');
    if (!input?.ready) {
      this.notReadySince ||= Date.now();
      if (Date.now() - this.notReadySince > STALL_RESET_MS) await this.safeReload('input-not-ready-stall');
      else await this.setStatus(`Detected ${this.pending.answer}; waiting for the answer box…`);
      return;
    }
    this.notReadySince = 0;
    const epoch = this.epoch;
    await this.setStatus(`Submitting ${this.pending.answer}…`);
    const filled = await this.callApi('fill', { answer: this.pending.answer, delayMs: SUBMIT_DELAY_MS, expectedImage: this.pending.image, epoch });
    if (epoch !== this.epoch || this.paused || this.verificationHold) return;
    if (filled?.status !== 'filled') {
      this.notReadySince ||= Date.now();
      if (Date.now() - this.notReadySince > STALL_RESET_MS) await this.safeReload('submit-not-ready-stall');
      else await this.setStatus(`Submission deferred (${filled?.status || 'not ready'}).`);
      return;
    }
    this.notReadySince = 0;
    this.taskCount++; this.lastSubmittedHash = imageHash; this.lastActivityAt = Date.now(); this.lastProgressAt = this.lastActivityAt;
    await this.syncDashboardMeta(true);
    await this.report({ correct: true, color: this.pending.answer, taskNum: this.taskCount });
    this.log(`Submitted task ${this.taskCount}: ${this.pending.answer}`);
    this.pending = null;
    this.nextIterationAt = Date.now() + 2000;
    await this.setStatus(`Task ${this.taskCount} submitted. Waiting for the next task…`);
  }

  async loop() {
    while (this.running && !this.stopped && this.page && !this.page.isClosed()) {
      await this.pollDashboardControl();
      if (!this.processing) {
        this.processing = true;
        try { await this.iteration(); }
        catch (error) { this.errorCount++; this.log(`Iteration error: ${error.message}`); await this.setStatus(`Error: ${error.message}`); }
        finally { this.processing = false; }
      }
      await sleep(this.verificationHold ? 1500 : 750);
    }
    this.encashment?.stop();
    await this.context?.close().catch(() => {});
    await this.updateOverlay();
    this.log('Pilot stopped; Chrome profile was kept in place.');
  }
}

async function main() {
  const pilot = new ChromePilot();
  process.on('SIGINT', () => { pilot.running = false; });
  process.on('SIGTERM', () => { pilot.running = false; });
  await pilot.start();
}

if (require.main === module) main().catch(error => { console.error(`[${ACCOUNT}-chrome] ${error.stack || error.message}`); process.exitCode = 1; });

module.exports = { ChromePilot, hashImage, isVerificationUrl, ACCOUNT, SLOT_ID, TASK_MODE, LOGIN_URL, WORK_URL, SUBMIT_DELAY_MS };
