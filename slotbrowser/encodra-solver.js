#!/usr/bin/env node
'use strict';
// Encodra Color Solving ANSWERER (v3).
// It touches the page ONLY when a task is showing: connect -> read/answer -> disconnect. Between touches it does nothing.
// Refreshing and restarting is NOT its job: that is the separate watchdog (encodra-watchdog.js).
// Exit codes: 0 = finished the requested count, 1 = error (safe to restart), 2 = answer not counted, 3 = needs the owner.
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) { ({ chromium } = require('C:/VisionTap/slotbrowser/node_modules/playwright-core')); }

const STATE_DIR = process.env.VT_ENCODRA_STATE_DIR || path.join(__dirname, '..', 'state');
const LOG = process.env.VT_ENCODRA_ANSWER_LOG || path.join(STATE_DIR, 'encodra_answers.log');
const STATS_FILE = path.join(STATE_DIR, 'encodra_stats.json');
const CDP = process.env.VT_ENCODRA_CDP || 'http://127.0.0.1:9222';
const COLOR_URL = 'https://www.encodradigital.site/tasks/color';
const COUNT = Number(process.argv[2] || 1);
const PACE_MS = process.env.VT_PACE_MS !== undefined ? Number(process.env.VT_PACE_MS) : 0;   // minimum ms between two Submit presses; 0 = as fast as the site allows (~22.7 s). The 25 s test (2026-11-18) did not reduce blocking.
fs.mkdirSync(STATE_DIR, { recursive: true });

// ---------- stats (read by the dashboard and the watchdog) ----------
const dayKey = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
let stats = { startedAt: Date.now(), updatedAt: Date.now(), status: 'starting', note: '', answersTotal: 0, setsCompleted: 0, wallet: null, points: null,
  lastAnswerAt: null, recent: [], setPayouts: [], today: { date: dayKey(), answers: 0, earned: 0 } };
try { const old = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); stats = Object.assign(stats, old, { startedAt: Date.now(), status: 'starting', note: '' }); } catch (_) {}
function saveStats() {
  try {
    if (stats.today.date !== dayKey()) stats.today = { date: dayKey(), answers: 0, earned: 0 };
    stats.updatedAt = Date.now();
    const tmp = STATS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(stats)); fs.renameSync(tmp, STATS_FILE);
  } catch (_) {}
}
const setStatus = (status, note = '') => { if (stats.status !== status || stats.note !== note) { stats.status = status; stats.note = note; } saveStats(); };
const pad2 = n => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const log = line => { try { fs.appendFileSync(LOG, `${stamp()} | ${line}\n`); } catch (_) {} console.log(line); };
let lastProgress = Date.now();
const progress = () => { lastProgress = Date.now(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function die(code, status, note) { setStatus(status, note); log(`STOP (${status}): ${note}`); process.exit(code); }

// ---------- color naming ----------
function hexToHsl(hex) {
  const n = parseInt(hex.replace('#', ''), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0, s = 0;
  if (d) { s = d / (1 - Math.abs(2 * l - 1)); if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h = (h * 60 + 360) % 360; }
  return { h, s, l };
}
function colorName(hex) {
  const { h, s, l } = hexToHsl(hex);
  if (l > 0.9 && s < 0.25) return 'white';
  if (l < 0.15) return 'black';
  if (h >= 10 && h < 45 && l < 0.5 && s < 0.6) return 'brown';
  if ((h >= 320 && h < 352) || ((h >= 352 || h < 10) && l > 0.7)) return 'pink';
  if (h >= 352 || h < 15) return 'red';
  if (h < 42) return 'orange';
  if (h < 70) return 'yellow';
  if (h >= 80 && h < 175) return 'green';
  if (h >= 185 && h < 255) return 'blue';
  if (h >= 255 && h < 315) return 'purple';
  return 'unknown';
}

// ---------- one short "touch" of the browser: connect -> do something -> disconnect ----------
async function touch(fn) {
  let browser;
  try { browser = await chromium.connectOverCDP(CDP, { timeout: 8000 }); }
  catch (e) { return { unreachable: true, error: e.message }; }
  try {
    const ctx = browser.contexts()[0];
    let page = ctx.pages().find(p => /encodradigital\.site/.test(p.url()));
    if (!page) { page = ctx.pages()[0] || await ctx.newPage(); await page.goto(COLOR_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); }
    return { value: await fn(page) };
  } catch (e) { return { error: e.message }; }
  finally { await browser.close().catch(() => {}); }          // only disconnects; the browser keeps running
}

// one cheap read of the whole page state
const SNAP = () => {
  const txt = document.body ? document.body.innerText : '';
  const flat = document.body ? document.body.textContent.replace(/\s+/g, ' ') : '';
  let grid = null; for (const el of document.querySelectorAll('*')) { if (el.children.length === 36) { grid = el; break; } }
  let puzzle = null;
  if (grid) {
    const cells = [...grid.children].map(g => { const m = /translate\(\s*([\d.]+)[ ,]+([\d.]+)\s*\)/.exec(g.getAttribute('transform') || ''); return m ? { x: +m[1], y: +m[2], fill: g.getAttribute('fill'), shape: g.firstElementChild ? g.firstElementChild.tagName : '' } : null; });
    const q = [...document.querySelectorAll('*')].find(e => e.childElementCount <= 2 && /color of shape number\s*\d+/i.test(e.textContent || '') && (e.textContent || '').length < 90);
    const m = q && /shape number\s*(\d+)/i.exec(q.textContent);
    if (m && !cells.some(c => !c)) puzzle = { n: +m[1], cells };
  }
  const input = document.querySelector('input[placeholder*="color" i]');
  const buttons = [...document.querySelectorAll('button')];
  const submit = buttons.find(b => /^submit$/i.test((b.textContent || '').trim()));
  const start = buttons.find(b => /^start$/i.test((b.textContent || '').trim()));
  const head = (document.title + ' ' + txt.slice(0, 800));
  return {
    url: location.href, puzzle, inputValue: input ? input.value : null,
    submitEnabled: !!submit && !submit.disabled, startReady: !!start && !start.disabled,
    blocked: /not valid JSON|Failed to verify your browser|Security Checkpoint|Code 11/i.test(head),
    human: /verify you are human|performing security verification|checking your browser|just a moment/i.test(txt.slice(0, 800)),
    points: ((/Points\s*(\d+)/i.exec(flat) || [])[1]) !== undefined ? +(/Points\s*(\d+)/i.exec(flat) || [])[1] : null,
    wallet: (() => { const m = /Tasking Wallet\s*₱\s*([\d,.]+)/i.exec(flat); return m ? parseFloat(m[1].replace(/,/g, '')) : null; })(),
  };
};
const snapshot = () => touch(p => p.evaluate(SNAP));
const needsLogin = url => /\/(auth|login|signin|sign-in|register)/i.test(url || '');
const keyOf = p => p.n + '|' + p.cells.map(c => c.fill).join('');

(async () => {
  const heartbeat = setInterval(() => { saveStats(); if (Date.now() - lastProgress > 240000) die(1, 'stalled', 'no progress for 4 minutes; restarting'); }, 10000);
  let done = 0, lastKey = '', lastGoto = 0, startPressedAt = 0, lastClickAt = 0;

  while (done < COUNT) {
    const r = await snapshot();
    if (r.unreachable) { setStatus('browser_unreachable', 'cannot reach the browser; the watchdog restarts it'); progress(); await sleep(3000); continue; }
    if (r.error || !r.value) { progress(); await sleep(2000); continue; }
    const s = r.value;

    if (needsLogin(s.url)) { setStatus('login_required', 'Encodra shows the login page. Sign in once; it continues by itself.'); progress(); await sleep(5000); continue; }
    if (s.blocked) { setStatus('blocked_by_site', 'Encodra\'s security check is blocking the page. The watchdog refreshes it every 15 seconds.'); progress(); await sleep(3000); continue; }
    if (s.human) { setStatus('human_check', 'A human check is showing. The owner must complete it.'); progress(); await sleep(5000); continue; }
    if (!/\/tasks\/color/.test(s.url)) {
      setStatus('opening_task', 'going to the Color Solving page'); progress();
      if (Date.now() - lastGoto > 15000) { lastGoto = Date.now(); await touch(p => p.goto(COLOR_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})); }
      await sleep(2000); continue;
    }
    if (!s.puzzle) {                                         // intro card: press Start (only when it is ready)
      setStatus('waiting_for_task', 'no task showing yet'); progress();
      if (s.startReady && Date.now() - startPressedAt > 8000) { startPressedAt = Date.now(); await touch(p => p.getByRole('button', { name: /^start$/i }).first().click().catch(() => {})); log('pressed Start (no task was showing)'); }
      await sleep(1000); continue;
    }

    // ---- a task is showing: answer it ----
    progress();
    const key = keyOf(s.puzzle);
    if (key === lastKey) { await sleep(700); continue; }               // same task we already answered, wait for the next
    const sorted = [...s.puzzle.cells].sort((a, b) => a.y - b.y || a.x - b.x);     // shapes are shuffled in the page: use on-screen order
    const cell = sorted[s.puzzle.n - 1], answer = colorName(cell.fill);
    if (answer === 'unknown') die(3, 'unknown_color', `shape ${s.puzzle.n} color ${cell.fill} not recognised - not submitting`);
    setStatus('running', `answering shape ${s.puzzle.n}`);

    // ONE touch: type the answer, wait (inside the page, 100 ms steps) until Submit is active, confirm it is still the same
    // task, press Submit, disconnect. The site lets you submit ~1 s after the task appears, so there is no blind waiting here.
    const before = s.points, walletBefore = s.wallet;
    // pacing: never press Submit sooner than PACE_MS after the previous press (stay away from the page while waiting)
    const waitMs = lastClickAt + PACE_MS - Date.now();
    if (waitMs > 0) { setStatus('running', `pacing: waiting ${Math.round(waitMs / 1000)} s before answering shape ${s.puzzle.n}`); const end = Date.now() + waitMs; while (Date.now() < end) { progress(); await sleep(Math.min(1000, end - Date.now())); } }
    const res = await touch(async p => {
      const inp = p.locator('input[placeholder*="color" i]').first();
      await inp.fill(answer);
      const sub = p.getByRole('button', { name: /^submit$/i }).first();
      let on = false;
      for (let t = 0; t < 150 && !on; t++) { on = await sub.isEnabled().catch(() => false); if (!on) await p.waitForTimeout(100); }
      if (!on) return 'not_ready';
      const cur = await p.evaluate(SNAP);
      if (!cur.puzzle || keyOf(cur.puzzle) !== key) return 'changed';
      if ((await inp.inputValue().catch(() => '')) !== answer) await inp.fill(answer);
      await sub.click();
      return 'clicked';
    });
    if (res.value !== 'clicked') {
      if (res.value === 'not_ready') die(2, 'submit_never_active', `Submit never became active for shape ${s.puzzle.n}`);
      log(`did not submit (${res.value || res.error || 'no result'}); starting over`); lastKey = ''; progress(); await sleep(800); continue;
    }
    lastKey = key; lastClickAt = Date.now();

    // The site now spends ~20 s "generating the next question". Stay away from the page during that time, then poll for the new task.
    let after = null, walletAfter = null, nxt = null;
    await sleep(15000); progress();
    for (let t = 0; t < 80; t++) { const q = await snapshot(); if (q.value && q.value.puzzle && keyOf(q.value.puzzle) !== key) { nxt = q.value; break; } progress(); await sleep(300); }
    if (nxt) { after = nxt.points; walletAfter = nxt.wallet; }
    else {
      // no new task came. Do NOT stop for good: the site may be blocking (the watchdog refreshes) or the click did not register.
      const q = await snapshot(); const cur2 = q.value || {};
      if (cur2.blocked || cur2.human || needsLogin(cur2.url) || !cur2.puzzle) { log('after Submit the page is blocked or changed; the answer may not have been taken. Waiting for the watchdog.'); lastKey = ''; progress(); await sleep(3000); continue; }
      if (cur2.puzzle && keyOf(cur2.puzzle) === key && cur2.points != null && cur2.points === before) { log('Submit did not register (same task, same points); trying again'); lastKey = ''; progress(); await sleep(1000); continue; }
      after = cur2.points; walletAfter = cur2.wallet;
    }
    const rolledOver = after === 0 && walletBefore != null && walletAfter != null && walletAfter > walletBefore;   // set completed and paid
    const ok = before != null && after != null && (after > before || rolledOver);
    done++;
    stats.answersTotal++; stats.today.answers++; stats.lastAnswerAt = Date.now(); stats.points = after; if (walletAfter != null) stats.wallet = walletAfter;
    stats.recent.push(Date.now()); if (stats.recent.length > 240) stats.recent = stats.recent.slice(-240);
    if (rolledOver) { const pay = +(walletAfter - walletBefore).toFixed(2); stats.setsCompleted++; stats.today.earned = +(stats.today.earned + pay).toFixed(2); stats.setPayouts.push(pay); if (stats.setPayouts.length > 60) stats.setPayouts = stats.setPayouts.slice(-60); }
    progress(); saveStats();
    log(`#${done} | shape ${s.puzzle.n} | cell ${cell.fill} ${cell.shape} at (${cell.x},${cell.y}) | answered: ${answer} | points ${before} -> ${after}${rolledOver ? ' (set completed, wallet ' + walletBefore + ' -> ' + walletAfter + ')' : ''} ${ok ? 'OK' : 'NOT COUNTED'}`);
    if (!ok) die(2, 'not_counted', 'points did not go up, so I am stopping to stay accurate');
  }
  clearInterval(heartbeat);
  setStatus('finished', `finished ${done} questions`);
  process.exit(0);
})().catch(e => { try { setStatus('error', String(e.message || e).slice(0, 200)); log('ERR ' + (e.message || e)); } catch (_) {} process.exit(1); });
