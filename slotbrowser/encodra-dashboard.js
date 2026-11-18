#!/usr/bin/env node
'use strict';
// Encodra dashboard (read-only). Serves a page + /api/stats built from the solver's state file.
// Env: PORT (6260), VT_ENCODRA_STATE_DIR, CASHOUT_MIN (300), DEFAULT_SET_PAY (0.26), POINTS_PER_SET (20)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 6260);
const STATE_DIR = process.env.VT_ENCODRA_STATE_DIR || path.join(__dirname, '..', 'state');
const STATS_FILE = path.join(STATE_DIR, 'encodra_stats.json');
const LOG_FILE = path.join(STATE_DIR, 'encodra_answers.log');
const CASHOUT_MIN = Number(process.env.CASHOUT_MIN || 300);
const DEFAULT_SET_PAY = Number(process.env.DEFAULT_SET_PAY || 0.26);   // observed range 0.18-0.30, mean ~0.26
const POINTS_PER_SET = Number(process.env.POINTS_PER_SET || 20);
const TZ = process.env.TZ || 'Asia/Manila';

function readStats() { try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (_) { return null; } }
function readWatchdog() { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'watchdog.json'), 'utf8')); } catch (_) { return null; } }
function tailLog(n) { try { return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-n).reverse(); } catch (_) { return []; } }

function compute() {
  const s = readStats();
  const now = Date.now();
  if (!s) return { ok: false, status: 'no_data', note: 'The solver has not written any data yet.' };
  // points per minute from the last 30 minutes of answers (each answer = 1 point)
  const win = 30 * 60000, recent = (s.recent || []).filter(t => now - t <= win);
  let ppm = 0;
  if (recent.length >= 2) ppm = (recent.length - 1) / ((recent[recent.length - 1] - recent[0]) / 60000);
  const avgPay = (s.setPayouts && s.setPayouts.length) ? s.setPayouts.reduce((a, b) => a + b, 0) / s.setPayouts.length : DEFAULT_SET_PAY;
  const earnPerMin = ppm / POINTS_PER_SET * avgPay;
  const perHour = earnPerMin * 60, perDay = earnPerMin * 1440;
  const wallet = s.wallet, remaining = wallet != null ? Math.max(0, CASHOUT_MIN - wallet) : null;
  let etaMs = null, etaText = null;
  if (remaining != null) {
    if (remaining === 0) etaText = 'Reached - you can cash out now (check the site\'s withdraw rules)';
    else if (earnPerMin > 0) { etaMs = now + (remaining / earnPerMin) * 60000; etaText = new Date(etaMs).toLocaleString('en-PH', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  }
  const age = now - (s.updatedAt || 0);
  let health = 'ok';
  if (s.status !== 'running' && s.status !== 'starting' && s.status !== 'opening_task' && s.status !== 'waiting_for_task') health = 'attention';
  if (age > 90000) health = 'stale';
  const w = readWatchdog();
  const watchdog = w ? { state: w.state, ageSec: Math.round((now - w.updatedAt) / 1000), refreshes: w.refreshes, browserRestarts: w.browserRestarts, solverRestarts: w.solverRestarts,
    browserMB: w.browserMB, lastAction: w.lastAction, lastActionAgoSec: w.lastActionAt ? Math.round((now - w.lastActionAt) / 1000) : null } : null;
  return {
    ok: true, status: s.status, note: s.note, health, ageSec: Math.round(age / 1000),
    wallet, points: s.points, pointsPerSet: POINTS_PER_SET, setsCompleted: s.setsCompleted, answersTotal: s.answersTotal,
    answersToday: s.today ? s.today.answers : 0, earnedToday: s.today ? s.today.earned : 0,
    ppm: +ppm.toFixed(2), avgSetPay: +avgPay.toFixed(3), perHour: +perHour.toFixed(2), perDay: +perDay.toFixed(2),
    tomorrow: +perDay.toFixed(2), cashoutMin: CASHOUT_MIN, remaining: remaining != null ? +remaining.toFixed(2) : null, etaText,
    lastAnswerAt: s.lastAnswerAt, startedAt: s.startedAt, log: tailLog(8), watchdog,
  };
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VisionTap Encodra</title>
<style>
:root{--bg:#0b0b0e;--card:#16161b;--line:#26262e;--ink:#f2f2f5;--mut:#9a9aa6;--red:#e4202c;--ok:#2fd16b;--warn:#f5b13d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 system-ui,Segoe UI,Roboto,sans-serif}
header{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--line)}
h1{font-size:18px;margin:0}h1 span{color:var(--red)}.pill{padding:4px 12px;border-radius:99px;font-size:13px;background:#202028}
.pill.ok{color:var(--ok)}.pill.attention,.pill.stale{color:var(--warn)}
main{max-width:1000px;margin:0 auto;padding:18px;display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.c{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}.c.w{grid-column:1/-1}
.l{color:var(--mut);font-size:12px;letter-spacing:.04em;text-transform:uppercase}.v{font-size:28px;font-weight:700;margin-top:4px}.s{color:var(--mut);font-size:13px;margin-top:2px}
.bar{height:10px;background:#24242c;border-radius:9px;overflow:hidden;margin-top:10px}.bar i{display:block;height:100%;background:var(--red);width:0}
pre{margin:0;white-space:pre-wrap;color:#c9c9d3;font:12px/1.5 ui-monospace,Consolas,monospace}
</style></head><body>
<header><h1>Vision<span>Tap</span> · Encodra</h1><span id="st" class="pill">loading…</span></header>
<main>
<div class="c"><div class="l">Wallet</div><div class="v" id="wallet">–</div><div class="s">Tasking wallet</div></div>
<div class="c"><div class="l">Points / minute</div><div class="v" id="ppm">–</div><div class="s" id="ppmS">last 30 min</div></div>
<div class="c"><div class="l">Earned today</div><div class="v" id="today">–</div><div class="s" id="todayS"></div></div>
<div class="c"><div class="l">Tomorrow (estimate)</div><div class="v" id="tom">–</div><div class="s" id="tomS"></div></div>
<div class="c w"><div class="l">Progress to next payout</div><div class="v" id="pts">–</div><div class="bar"><i id="bar"></i></div><div class="s" id="ptsS"></div></div>
<div class="c w"><div class="l">Cashout (minimum <span id="min">300</span>)</div><div class="v" id="eta">–</div><div class="s" id="etaS"></div></div>
<div class="c"><div class="l">Answers</div><div class="v" id="ans">–</div><div class="s" id="ansS"></div></div>
<div class="c"><div class="l">Status</div><div class="v" style="font-size:20px" id="stat">–</div><div class="s" id="note"></div></div>
<div class="c w"><div class="l">Watchdog</div><div class="v" style="font-size:20px" id="wd">–</div><div class="s" id="wdS"></div></div>
<div class="c w"><div class="l">Recent answers</div><pre id="log"></pre></div>
</main>
<script>
const $=i=>document.getElementById(i), P=n=>'₱'+Number(n).toFixed(2);
async function tick(){try{const d=await (await fetch('/api/stats',{cache:'no-store'})).json();
 if(!d.ok){$('st').textContent='waiting for data';$('st').className='pill attention';return}
 $('st').textContent=d.health==='ok'?'Running':d.health==='stale'?'No signal ('+d.ageSec+'s)':'Needs attention';$('st').className='pill '+d.health;
 $('wallet').textContent=d.wallet==null?'–':P(d.wallet);$('ppm').textContent=d.ppm;$('ppmS').textContent='≈ '+P(d.perHour)+' per hour';
 $('today').textContent=P(d.earnedToday);$('todayS').textContent=d.answersToday+' answers today';
 $('tom').textContent=P(d.tomorrow);$('tomS').textContent='if it keeps this pace for 24 h (avg '+P(d.avgSetPay)+' / set)';
 $('pts').textContent=(d.points==null?'–':d.points)+' / '+d.pointsPerSet;$('bar').style.width=(d.points==null?0:Math.min(100,d.points/d.pointsPerSet*100))+'%';$('ptsS').textContent=d.setsCompleted+' sets completed';
 $('min').textContent=d.cashoutMin;$('eta').textContent=d.etaText||'–';$('etaS').textContent=d.remaining==null?'':(d.remaining>0?P(d.remaining)+' still needed':'');
 $('ans').textContent=d.answersTotal;$('ansS').textContent='since the dashboard started counting';$('stat').textContent=d.status;$('note').textContent=d.note||'';
 if(d.watchdog){const w=d.watchdog;$('wd').textContent=w.state+(w.ageSec>60?'  (no signal '+w.ageSec+'s)':'');$('wdS').textContent=w.refreshes+' refreshes · '+w.browserRestarts+' browser restarts · '+w.solverRestarts+' answerer restarts'+(w.browserMB?' · page '+w.browserMB+' MB':'')+(w.lastAction?' · last: '+w.lastAction+' ('+w.lastActionAgoSec+'s ago)':'')}else{$('wd').textContent='not running';$('wdS').textContent=''}
 $('log').textContent=(d.log||[]).join('\\n');
}catch(e){$('st').textContent='offline';$('st').className='pill stale'}}
tick();setInterval(tick,5000);
</script></body></html>`;

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Read-only dashboard'); }
  const url = req.url.split('?')[0];
  if (url === '/api/stats') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(compute())); }
  if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); return res.end(PAGE); }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, '0.0.0.0', () => console.log(`Encodra dashboard on http://0.0.0.0:${PORT}  (state: ${STATE_DIR})`));
