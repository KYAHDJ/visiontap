#!/usr/bin/env node
'use strict';
// Encodra WATCHDOG (separate from the answerer). It only watches and fixes; it never answers.
//  - browser not reachable for 15 s            -> restart the browser service
//  - Encodra's security check is blocking      -> refresh the task page every 15 s until a task shows
//  - page stuck (no task / no answer for 3 min) -> refresh the page (then wait 60 s before the next refresh)
//  - answerer silent for 2 min                  -> restart the answerer service
//  - login needed / human check                 -> only report it (the owner must do that part)
// Writes watchdog.json for the dashboard. Env: VT_WATCHDOG_DRYRUN=1 prints actions instead of doing them.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) { ({ chromium } = require('C:/VisionTap/slotbrowser/node_modules/playwright-core')); }

const STATE_DIR = process.env.VT_ENCODRA_STATE_DIR || path.join(__dirname, '..', 'state');
const STATS_FILE = path.join(STATE_DIR, 'encodra_stats.json');
const WD_FILE = path.join(STATE_DIR, 'watchdog.json');
const LOG = path.join(STATE_DIR, 'watchdog.log');
const CDP = process.env.VT_ENCODRA_CDP || 'http://127.0.0.1:9222';
const COLOR_URL = 'https://www.encodradigital.site/tasks/color';
// when the site blocks: refresh after 30 s, then 25 s, 20 s, 15 s, and then every 15 s until it lets us through
const BLOCKED_SCHEDULE_MS = (process.env.VT_BLOCKED_SCHEDULE || '30,25,20,15').split(',').map(x => Number(x) * 1000);
const STUCK_MS = Number(process.env.VT_STUCK_MS || 180000);
const DRY = process.env.VT_WATCHDOG_DRYRUN === '1';
const BROWSER_SERVICE = process.env.VT_BROWSER_SERVICE || 'encodra-brave';
const SOLVER_SERVICE = process.env.VT_SOLVER_SERVICE || 'encodra-solver';
fs.mkdirSync(STATE_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const d2 = n => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `${d.getFullYear()}-${d2(d.getMonth() + 1)}-${d2(d.getDate())} ${d2(d.getHours())}:${d2(d.getMinutes())}:${d2(d.getSeconds())}`; };
const wlog = line => { try { fs.appendFileSync(LOG, `${stamp()} | ${line}\n`); } catch (_) {} console.log(line); };
const wd = { startedAt: Date.now(), updatedAt: Date.now(), state: 'starting', lastAction: null, lastActionAt: null, refreshes: 0, browserRestarts: 0, solverRestarts: 0 };
const saveWd = () => { try { wd.updatedAt = Date.now(); const tmp = WD_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(wd)); fs.renameSync(tmp, WD_FILE); } catch (_) {} };
const action = what => { wd.lastAction = what; wd.lastActionAt = Date.now(); wlog('ACTION: ' + what); saveWd(); };
const readStats = () => { try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (_) { return null; } };
const restart = svc => new Promise(res => { if (DRY) { wlog(`(dry run) would restart ${svc}`); return res(); } execFile('systemctl', ['restart', svc], () => res()); });
const MEM_LIMIT_MB = Number(process.env.VT_BROWSER_MEM_MB || 1500);   // the Encodra page slowly grows (measured 3.4 GB after hours) and everything gets slower
const rssMB = () => new Promise(res => execFile('ps', ['-eo', 'rss,args', '--sort=-rss'], { maxBuffer: 1 << 22 }, (e, out) => {
  if (e) return res(0);
  const line = String(out).split('\n').find(l => /(brave|chrome)/i.test(l) && /--type=renderer/.test(l));
  res(line ? Math.round(parseInt(line.trim(), 10) / 1024) : 0);
}));
const portUp = () => new Promise(res => { const req = http.get(CDP + '/json/version', { timeout: 3000 }, r => { r.resume(); res(r.statusCode === 200); }); req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); }); });

const SNAP = () => {
  const txt = document.body ? document.body.innerText : '';
  let grid = null; for (const el of document.querySelectorAll('*')) { if (el.children.length === 36) { grid = el; break; } }
  return { url: location.href, hasTask: !!grid,
    blocked: /not valid JSON|Failed to verify your browser|Security Checkpoint|Code 11/i.test(document.title + ' ' + txt.slice(0, 800)),
    human: /verify you are human|performing security verification|checking your browser|just a moment/i.test(txt.slice(0, 800)) };
};
async function look() {
  let browser;
  try { browser = await chromium.connectOverCDP(CDP, { timeout: 6000 }); } catch (_) { return null; }
  try {
    const page = browser.contexts()[0].pages().find(p => /encodradigital\.site/.test(p.url())) || browser.contexts()[0].pages()[0];
    if (!page) return { none: true };
    return { page, snap: await page.evaluate(SNAP), browser };
  } catch (e) { await browser.close().catch(() => {}); return null; }
}

(async () => {
  let portDownSince = 0, lastRefresh = 0, noTaskSince = 0, lastBrowserRestart = 0, lastSolverRestart = 0, blockedIdx = 0, blockedSince = 0, cannotSince = 0;
  wlog('watchdog started');
  for (;;) {
    const now = Date.now();
    // 1) is the browser alive?
    if (!(await portUp())) {
      if (!portDownSince) portDownSince = now;
      wd.state = 'browser_down'; saveWd();
      if (now - portDownSince > 15000 && now - lastBrowserRestart > 60000) { lastBrowserRestart = now; wd.browserRestarts++; action(`browser not reachable for ${Math.round((now - portDownSince) / 1000)} s -> restarting ${BROWSER_SERVICE}`); await restart(BROWSER_SERVICE); }
      await sleep(5000); continue;
    }
    portDownSince = 0;

    // 1b) keep the browser light: if the page has grown too big, restart the browser (about 45 s) so it stays fast
    wd.browserMB = await rssMB();
    if (wd.browserMB > MEM_LIMIT_MB && now - lastBrowserRestart > 300000) {
      lastBrowserRestart = now; wd.browserRestarts++; action(`browser page uses ${wd.browserMB} MB (limit ${MEM_LIMIT_MB} MB) -> restarting ${BROWSER_SERVICE} to keep it fast`);
      await restart(BROWSER_SERVICE); await sleep(25000); continue;
    }

    // 2) look at the page (short touch)
    const l = await look();
    if (!l || l.none) {
      // the port answers but we cannot talk to the browser (frozen): after 60 s restart it
      if (!cannotSince) cannotSince = now;
      wd.state = 'cannot_look'; saveWd();
      if (now - cannotSince > 60000 && now - lastBrowserRestart > 120000) { lastBrowserRestart = now; wd.browserRestarts++; action(`browser port is up but not answering for ${Math.round((now - cannotSince) / 1000)} s -> restarting ${BROWSER_SERVICE}`); await restart(BROWSER_SERVICE); await sleep(25000); cannotSince = 0; }
      await sleep(5000); continue;
    }
    cannotSince = 0;
    const s = l.snap, st = readStats();
    let nextWait = 5000;
    if (!s.blocked && blockedSince) { wlog(`BLOCK ended after ${Math.round((now - blockedSince) / 1000)} s`); blockedSince = 0; blockedIdx = 0; }
    try {
      if (/\/(auth|login|signin|sign-in|register)/i.test(s.url)) { wd.state = 'login_required'; noTaskSince = 0; }
      else if (s.human) { wd.state = 'human_check'; noTaskSince = 0; }
      else if (s.blocked) {
        wd.state = 'blocked_by_site'; noTaskSince = 0;
        if (!blockedSince) { blockedSince = now; blockedIdx = 0; lastRefresh = now; wlog('BLOCK started'); }   // first refresh comes after the first delay (30 s)
        const delay = BLOCKED_SCHEDULE_MS[Math.min(blockedIdx, BLOCKED_SCHEDULE_MS.length - 1)];
        if (now - lastRefresh >= delay) { lastRefresh = now; blockedIdx++; wd.refreshes++; action(`site is blocking -> refreshing the task page (waited ${delay / 1000} s; schedule ${BLOCKED_SCHEDULE_MS.map(x => x / 1000).join('-')} then ${BLOCKED_SCHEDULE_MS[BLOCKED_SCHEDULE_MS.length - 1] / 1000} s)`); if (!DRY) await l.page.goto(COLOR_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); }
        nextWait = 2000;
      } else if (!s.hasTask) {
        wd.state = 'no_task'; if (!noTaskSince) noTaskSince = now;
        if (now - noTaskSince > STUCK_MS && now - lastRefresh > 60000) { lastRefresh = now; wd.refreshes++; action('no task for 3 minutes -> refreshing the page'); if (!DRY) await l.page.goto(COLOR_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); }
      } else {
        noTaskSince = 0; wd.state = 'ok';
        // a task is showing but nothing answered for 3 minutes -> refresh
        const lastAns = (st && st.lastAnswerAt) || (st && st.startedAt) || now;
        if (now - lastAns > STUCK_MS && now - lastRefresh > 60000 && st && ['running', 'waiting_for_task', 'starting'].includes(st.status)) { lastRefresh = now; wd.refreshes++; action('task showing but no answer for 3 minutes -> refreshing the page'); if (!DRY) await l.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); }
      }
    } finally { await l.browser.close().catch(() => {}); }

    // 3) is the answerer alive and writing its heartbeat?
    if (st && now - (st.updatedAt || 0) > 120000 && now - lastSolverRestart > 120000) { lastSolverRestart = now; wd.solverRestarts++; action(`answerer silent for ${Math.round((now - st.updatedAt) / 1000)} s -> restarting ${SOLVER_SERVICE}`); await restart(SOLVER_SERVICE); }
    saveWd();
    await sleep(nextWait);
  }
})().catch(e => { wlog('watchdog crashed: ' + (e.message || e)); process.exit(1); });
