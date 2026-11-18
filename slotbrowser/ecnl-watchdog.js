#!/usr/bin/env node
'use strict';
// ECNL WATCHDOG (separate from the answerer). It only watches and fixes; it never answers, never types a password, never solves a check.
//  - browser port down for 15 s                 -> restart the browser service
//  - browser frozen (port up, no reply for 60 s) -> restart the browser service
//  - browser page too big (default 1500 MB)      -> restart the browser service
//  - site blocking / error page                   -> refresh the task page: 30 s, 25 s, 20 s, then every 15 s
//  - no question for 3 min / question but no answer for 3 min -> refresh the task page (60 s apart)
//  - answerer silent for 2 min                    -> restart the answerer service
//  - extra tabs / popups                          -> close them (the ECNL tab stays); ad wall and anchor ads are only HIDDEN
//  - login needed / human check                   -> only report it (the owner does that part)
// Writes watchdog.json (dashboard) and watchdog.log. Env: VT_WATCHDOG_DRYRUN=1 prints actions instead of doing them.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { chromium } = require('./node_modules/playwright-core');

const STATE_DIR = process.env.VT_ECNL_STATE_DIR || path.join(__dirname, '..', 'state', 'ecnl');
const STATS_FILE = path.join(STATE_DIR, 'ecnl_stats.json');
const WD_FILE = path.join(STATE_DIR, 'watchdog.json');
const LOG = path.join(STATE_DIR, 'watchdog.log');
const CDP = process.env.VT_ECNL_CDP || 'http://127.0.0.1:9223';
const TASK_URL = 'https://ecnlmediamarket.com/dashboard/tasks/colors';
const SCHEDULE = (process.env.VT_BLOCKED_SCHEDULE || '30,25,20,15').split(',').map(x => Number(x) * 1000);
const STUCK_MS = Number(process.env.VT_STUCK_MS || 180000);
const MEM_LIMIT_MB = Number(process.env.VT_BROWSER_MEM_MB || 1500);
const DRY = process.env.VT_WATCHDOG_DRYRUN === '1';
const BROWSER_SERVICE = process.env.VT_BROWSER_SERVICE || 'ecnl-brave';
const SOLVER_SERVICE = process.env.VT_SOLVER_SERVICE || 'ecnl-solver';
fs.mkdirSync(STATE_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const d2 = n => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `${d.getFullYear()}-${d2(d.getMonth() + 1)}-${d2(d.getDate())} ${d2(d.getHours())}:${d2(d.getMinutes())}:${d2(d.getSeconds())}`; };
const wlog = line => { try { fs.appendFileSync(LOG, `${stamp()} | ${line}\n`); } catch (_) {} console.log(line); };
const wd = { startedAt: Date.now(), updatedAt: Date.now(), state: 'starting', lastAction: null, lastActionAt: null, refreshes: 0, browserRestarts: 0, solverRestarts: 0, popupsClosed: 0, browserMB: 0 };
const saveWd = () => { try { wd.updatedAt = Date.now(); fs.writeFileSync(WD_FILE + '.tmp', JSON.stringify(wd)); fs.renameSync(WD_FILE + '.tmp', WD_FILE); } catch (_) {} };
const action = what => { wd.lastAction = what; wd.lastActionAt = Date.now(); wlog('ACTION: ' + what); saveWd(); };
const readStats = () => { try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (_) { return null; } };
const restart = svc => new Promise(res => { if (DRY) { wlog(`(dry run) would restart ${svc}`); return res(); } execFile('systemctl', ['restart', svc], () => res()); });
const rssMB = () => new Promise(res => execFile('ps', ['-eo', 'rss,args', '--sort=-rss'], { maxBuffer: 1 << 22 }, (e, out) => {
  if (e) return res(0);
  const line = String(out).split('\n').find(l => /--type=renderer/.test(l) && /Brave-ECNL/.test(l));
  res(line ? Math.round(parseInt(line.trim(), 10) / 1024) : 0);
}));
const portUp = () => new Promise(res => { const req = http.get(CDP + '/json/version', { timeout: 3000 }, r => { r.resume(); res(r.statusCode === 200); }); req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); }); });

// ---- page script: state + hide (never remove) the Google ad wall / anchor ads
const HIDE_CSS = '.fc-monetization-dialog-container,.fc-dialog-overlay,.fc-ab-root,.fc-consent-root,ins.adsbygoogle,[id^="google_ads_iframe"],[id^="aswift"],iframe[src*="googleads"],iframe[src*="doubleclick"]{display:none!important;visibility:hidden!important;pointer-events:none!important}html,body{overflow:auto!important;position:static!important}';
const PAGE_JS = `(()=>{try{
 if(!window.__vt_hide){const s=new CSSStyleSheet();s.replaceSync(${JSON.stringify(HIDE_CSS)});document.adoptedStyleSheets=[...document.adoptedStyleSheets,s];window.__vt_hide=1}
 document.querySelectorAll('.fc-monetization-dialog-container,.fc-dialog-overlay,.fc-ab-root,.fc-consent-root,ins.adsbygoogle,[id^="google_ads_iframe"],[id^="aswift"]').forEach(e=>{e.style.setProperty('display','none','important');e.style.setProperty('visibility','hidden','important');e.style.setProperty('pointer-events','none','important')});
 if(!window.__vt_nopop){window.__vt_nopop=1;window.open=()=>null}
 document.querySelectorAll('a[target=_blank]').forEach(a=>a.removeAttribute('target'));
 const t=document.body?document.body.innerText:'';const head=(document.title+' '+t.slice(0,600));
 return JSON.stringify({url:location.href,hasTask:!!document.querySelector('img[alt^="Task question"]'),
  blocked:/just a moment|attention required|access denied|error 10\\d\\d|too many requests|temporarily unavailable|bad gateway|service unavailable|ERR_/i.test(head),
  human:/verify you are human|performing security verification|checking your browser|cloudflare/i.test(head)&&/just a moment|verify/i.test(head),
  login:/\\/(login|auth|signin|sign-in|register)/i.test(location.pathname)})
}catch(e){return JSON.stringify({err:String(e)})}})()`;

async function look() {
  let browser;
  try { browser = await chromium.connectOverCDP(CDP, { timeout: 6000 }); } catch (_) { return null; }
  try {
    const ctx = browser.contexts()[0];
    // close extra tabs / popups (the ECNL tab stays)
    const all = ctx.pages();
    const main = all.find(x => /ecnlmediamarket\.com/.test(x.url())) || all[0];
    if (!main) return { browser, none: true };
    for (const x of all) { if (x !== main && !/ecnlmediamarket\.com/.test(x.url())) { await x.close().catch(() => {}); wd.popupsClosed++; } }
    const sess = await ctx.newCDPSession(main);
    const r = await sess.send('Runtime.evaluate', { expression: PAGE_JS, returnByValue: true, awaitPromise: false });
    await sess.detach().catch(() => {});
    const snap = r && r.result && r.result.value ? JSON.parse(r.result.value) : null;
    if (!snap || snap.err) return { browser, page: main, snap: { url: main.url(), hasTask: false, blocked: !snap, human: false, login: false } };
    return { browser, page: main, snap };
  } catch (e) { await browser.close().catch(() => {}); return null; }
}

(async () => {
  let portDownSince = 0, lastRefresh = 0, noTaskSince = 0, lastBrowserRestart = 0, lastSolverRestart = 0, blockedIdx = 0, blockedSince = 0, cannotSince = 0, okSince = 0;
  wlog('ecnl watchdog started');
  for (;;) {
    const now = Date.now();
    if (!(await portUp())) {
      if (!portDownSince) portDownSince = now;
      wd.state = 'browser_down'; saveWd();
      if (now - portDownSince > 15000 && now - lastBrowserRestart > 60000) { lastBrowserRestart = now; wd.browserRestarts++; action(`browser not reachable for ${Math.round((now - portDownSince) / 1000)} s -> restarting ${BROWSER_SERVICE}`); await restart(BROWSER_SERVICE); }
      await sleep(5000); continue;
    }
    portDownSince = 0;

    wd.browserMB = await rssMB();
    if (wd.browserMB > MEM_LIMIT_MB && now - lastBrowserRestart > 300000) {
      lastBrowserRestart = now; wd.browserRestarts++; action(`browser page uses ${wd.browserMB} MB (limit ${MEM_LIMIT_MB} MB) -> restarting ${BROWSER_SERVICE}`);
      await restart(BROWSER_SERVICE); await sleep(25000); continue;
    }

    const l = await look();
    if (!l || l.none) {
      if (l && l.browser) await l.browser.close().catch(() => {});
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
      if (s.login) { wd.state = 'login_required'; noTaskSince = 0; }
      else if (s.human) { wd.state = 'human_check'; noTaskSince = 0; }
      else if (s.blocked) {
        wd.state = 'blocked_by_site'; noTaskSince = 0;
        if (!blockedSince) { blockedSince = now; blockedIdx = 0; lastRefresh = now; wlog('BLOCK started'); }
        const delay = SCHEDULE[Math.min(blockedIdx, SCHEDULE.length - 1)];
        if (now - lastRefresh >= delay) { lastRefresh = now; blockedIdx++; wd.refreshes++; action(`site is blocking -> refreshing the task page (waited ${delay / 1000} s)`); if (!DRY) await l.page.goto(TASK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); }
        nextWait = 2000;
      } else if (!/\/dashboard\/tasks\/colors/.test(s.url)) {
        wd.state = 'wrong_page'; noTaskSince = noTaskSince || now;   // the answerer normally opens the task page itself; step in after 60 s
        if (now - noTaskSince > 60000 && now - lastRefresh > 60000) { lastRefresh = now; wd.refreshes++; action('not on the colors task page for 60 s -> opening it'); if (!DRY) await l.page.goto(TASK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); }
      } else if (!s.hasTask) {
        wd.state = 'no_task'; if (!noTaskSince) noTaskSince = now;
        if (now - noTaskSince > STUCK_MS && now - lastRefresh > 60000) { lastRefresh = now; wd.refreshes++; action('no question for 3 minutes -> refreshing the page'); if (!DRY) await l.page.goto(TASK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); }
      } else {
        noTaskSince = 0; if (wd.state !== 'ok') okSince = now; wd.state = 'ok';   // okSince: the page is usable from this moment (not while waiting for sign-in)
        const lastAns = Math.max((st && st.lastAnswerAt) || 0, okSince) || now;
        if (now - lastAns > STUCK_MS && now - lastRefresh > 60000 && st && ['running', 'waiting_for_task', 'starting'].includes(st.status)) { lastRefresh = now; wd.refreshes++; action('question showing but no answer for 3 minutes -> refreshing the page'); if (!DRY) await l.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); }
      }
    } finally { await l.browser.close().catch(() => {}); }

    if (st && now - (st.updatedAt || 0) > 120000 && now - lastSolverRestart > 120000 && !['login_required', 'needs_owner'].includes(st.status)) { lastSolverRestart = now; wd.solverRestarts++; action(`answerer silent for ${Math.round((now - st.updatedAt) / 1000)} s -> restarting ${SOLVER_SERVICE}`); await restart(SOLVER_SERVICE); }
    saveWd();
    await sleep(nextWait);
  }
})().catch(e => { wlog('watchdog crashed: ' + (e.message || e)); process.exit(1); });
