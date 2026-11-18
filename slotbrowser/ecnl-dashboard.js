#!/usr/bin/env node
'use strict';
// ECNL dashboard (read-only). One calm screen: what is happening now, 4 numbers, progress, watchdog, last answers.
// Env: PORT (6261), VT_ECNL_STATE_DIR, PROGRESS_TARGET (250)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 6261);
const STATE_DIR = process.env.VT_ECNL_STATE_DIR || path.join(__dirname, '..', 'state', 'ecnl');
const read = f => { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')); } catch (_) { return null; } };
const LOG = path.join(STATE_DIR, 'ecnl_answers.log');
const TARGET = Number(process.env.PROGRESS_TARGET || 250);
const d2 = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${d2(d.getMonth() + 1)}-${d2(d.getDate())}`;

function answers() {   // parse the answer log: [{at, n, emoji, color, secs, result}]
  let lines = []; try { lines = fs.readFileSync(LOG, 'utf8').split('\n'); } catch (_) {}
  const out = [];
  for (const l of lines) {
    const m = l.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) \| #(\d+) \| emoji (\d+) \|.*answered: (\w+) \| clicked at ([\d.]+) s.*?(OK|WRONG|\?) \(progress/);
    if (m) out.push({ day: m[1], time: m[2], at: new Date(m[1] + 'T' + m[2]).getTime(), emoji: +m[4], color: m[5], secs: +m[6], result: m[7] });
  }
  return out;
}

function compute() {
  const s = read('ecnl_stats.json'), w = read('watchdog.json'), now = Date.now();
  if (!s) return { ok: false, headline: 'Waiting for the answerer to start', tone: 'wait', detail: 'No data yet.' };
  const all = answers(), today = dayKey(new Date());
  const todayCount = all.filter(a => a.day === today).length;
  const win = all.filter(a => now - a.at <= 15 * 60000);
  let perMin = 0; if (win.length >= 2) perMin = (win.length - 1) / ((win[win.length - 1].at - win[0].at) / 60000);
  const secs = (s.secondsPerAnswer || []).slice(-20); const avgSecs = secs.length ? secs.reduce((a, b) => a + b, 0) / secs.length : null;
  const prog = s.progress || null, remaining = prog ? Math.max(0, prog[1] - prog[0]) : null;
  const target = prog ? prog[1] : TARGET;
  let eta = null; if (remaining != null && perMin > 0) eta = new Date(now + remaining / perMin * 60000).toLocaleString('en-PH', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const age = Math.round((now - (s.updatedAt || 0)) / 1000), wdState = w ? w.state : null;
  // one plain status line
  let tone = 'ok', headline = 'Answering', detail = avgSecs ? `${avgSecs.toFixed(1)} s per answer` : (s.note || '');
  if (age > 90) { tone = 'warn'; headline = 'No signal from the answerer'; detail = `Last heard ${age} s ago. The watchdog restarts it after 2 minutes.`; }
  else if (s.status === 'login_required' || wdState === 'login_required') { tone = 'you'; headline = 'Needs you: sign in to ECNL'; detail = 'Open the ECNL browser and sign in. Everything else resumes by itself.'; }
  else if (wdState === 'human_check') { tone = 'you'; headline = 'Needs you: finish the human check'; detail = 'Tick the check in the ECNL browser.'; }
  else if (s.status === 'needs_owner') { tone = 'you'; headline = 'Stopped: needs a look'; detail = s.note || ''; }
  else if (wdState === 'blocked_by_site') { tone = 'warn'; headline = 'The site is blocking'; detail = 'The watchdog refreshes the page every 15 s until it lets us in.'; }
  else if (['opening_task', 'waiting_for_task', 'starting'].includes(s.status)) { tone = 'wait'; headline = 'Getting ready'; detail = s.note || ''; }
  const wallet = s.wallet;
  return {
    ok: true, tone, headline, detail, age,
    numbers: { perMin: +perMin.toFixed(2), today: todayCount, total: s.answersTotal || 0, wallet },
    progress: prog ? { now: prog[0], target, remaining, eta } : null,
    watchdog: w ? { state: w.state, ageSec: Math.round((now - w.updatedAt) / 1000), refreshes: w.refreshes, browserRestarts: w.browserRestarts, solverRestarts: w.solverRestarts, popupsClosed: w.popupsClosed || 0, browserMB: w.browserMB || 0, lastAction: w.lastAction, lastAgo: w.lastActionAt ? Math.round((now - w.lastActionAt) / 1000) : null } : null,
    recent: all.slice(-8).reverse().map(a => ({ time: a.time, emoji: a.emoji, color: a.color, secs: a.secs, result: a.result })),
  };
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ECNL answerer</title>
<style>
:root{--bg:#0d1117;--card:#151b23;--line:#242d38;--ink:#eef2f6;--mut:#9aa7b4;--ok:#3ecf8e;--warn:#f2b84b;--you:#ff7a59;--wait:#7aa7ff;--r:16px}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:20px 16px 48px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
h1{font-size:17px;font-weight:600;margin:0;letter-spacing:.01em}
.seen{color:var(--mut);font-size:13px}
.hero{background:var(--card);border:1px solid var(--line);border-left:6px solid var(--tone,var(--ok));border-radius:var(--r);padding:22px 22px 20px;display:flex;gap:16px;align-items:center}
.hero svg{flex:none;width:34px;height:34px;color:var(--tone,var(--ok))}
.hero h2{margin:0;font-size:clamp(22px,4.2vw,30px);line-height:1.2;font-weight:650}
.hero p{margin:6px 0 0;color:var(--mut);font-size:15px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:12px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px}
.label{color:var(--mut);font-size:13px}
.num{font-size:clamp(30px,6vw,40px);font-weight:700;line-height:1.1;margin-top:6px;font-variant-numeric:tabular-nums}
.sub{color:var(--mut);font-size:13px;margin-top:4px}
.bar{height:12px;background:#1f2833;border-radius:99px;overflow:hidden;margin:12px 0 8px}
.bar i{display:block;height:100%;width:0;background:var(--wait);border-radius:99px;transition:width .6s}
.row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
h3{font-size:14px;font-weight:600;margin:0 0 10px;color:var(--mut)}
table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}
th{font-weight:500;color:var(--mut);text-align:left;padding:4px 8px 8px 0}td{padding:7px 8px 7px 0;border-top:1px solid var(--line)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;vertical-align:-1px}
.res{font-weight:600}
@media (prefers-reduced-motion:reduce){.bar i{transition:none}}
@media (max-width:520px){.hero{padding:18px}.wrap{padding:14px 12px 40px}}
</style></head><body><div class="wrap">
<header><h1>ECNL answerer</h1><span class="seen" id="seen" role="status">Loading</span></header>
<section class="hero" id="hero" aria-live="polite">
 <svg id="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/></svg>
 <div><h2 id="head">Loading</h2><p id="detail"></p></div>
</section>
<section class="grid" aria-label="Key numbers">
 <div class="card"><div class="label">Answers per minute</div><div class="num" id="pm">0</div><div class="sub" id="pmS"></div></div>
 <div class="card"><div class="label">Answers today</div><div class="num" id="today">0</div><div class="sub" id="totalS"></div></div>
 <div class="card"><div class="label">Wallet</div><div class="num" id="wallet">-</div><div class="sub">Task earnings</div></div>
 <div class="card"><div class="label">Progress</div><div class="num" id="prog" style="font-size:clamp(24px,4.4vw,32px)">-</div><div class="sub" id="progS"></div></div>
</section>
<section class="card" aria-label="Progress to the next reward"><div class="row"><h3>Progress to the next reward</h3><span class="sub" id="eta"></span></div><div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" id="pb"><i id="fill"></i></div><div class="sub" id="left"></div></section>
<section class="grid">
 <div class="card"><h3>Watchdog</h3><div class="num" style="font-size:22px" id="wd">-</div><div class="sub" id="wdS"></div></div>
 <div class="card" style="grid-column:span 2;min-width:0"><h3>Last answers</h3><table><thead><tr><th>Time</th><th>Emoji</th><th>Color</th><th>Seconds</th><th>Result</th></tr></thead><tbody id="rows"></tbody></table></div>
</section>
</div>
<script>
const $=i=>document.getElementById(i);
const TONES={ok:'--ok',warn:'--warn',you:'--you',wait:'--wait'};
const ICONS={ok:'<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/>',warn:'<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18h.01"/>',you:'<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4 3-6 7-6s7 2 7 6"/>',wait:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'};
const RES={OK:['Counted','var(--ok)'],WRONG:['Wrong','var(--you)'],'?':['Not confirmed','var(--warn)']};
function ago(s){return s<90?s+' s ago':Math.round(s/60)+' min ago'}
async function tick(){
 try{
  const d=await (await fetch('/api/stats',{cache:'no-store'})).json();
  $('seen').textContent='Updated '+new Date().toLocaleTimeString();
  $('head').textContent=d.headline;$('detail').textContent=d.detail||'';
  $('hero').style.setProperty('--tone','var('+TONES[d.tone||'ok']+')');$('ico').innerHTML=ICONS[d.tone||'ok'];
  if(!d.ok)return;
  const n=d.numbers;$('pm').textContent=n.perMin;$('pmS').textContent='about '+Math.round(n.perMin*60)+' per hour';
  $('today').textContent=n.today;$('totalS').textContent=n.total+' since the answerer started';
  $('wallet').textContent=n.wallet==null?'-':'\\u20B1'+Number(n.wallet).toFixed(2);
  const p=d.progress;
  if(p){const pct=Math.min(100,p.now/p.target*100);$('prog').textContent=p.now+' / '+p.target;$('progS').textContent=Math.round(pct)+' percent';$('fill').style.width=pct+'%';$('pb').setAttribute('aria-valuenow',Math.round(pct));$('left').textContent=p.remaining+' answers to go';$('eta').textContent=p.eta?'At this pace: '+p.eta:''}
  const w=d.watchdog;
  if(w){$('wd').textContent={ok:'Watching',blocked_by_site:'Site blocking',no_task:'No question',login_required:'Needs sign-in',human_check:'Human check',browser_down:'Browser down',cannot_look:'Browser frozen',wrong_page:'Wrong page'}[w.state]||w.state;
   $('wdS').textContent=w.refreshes+' refreshes, '+w.browserRestarts+' browser restarts, '+w.solverRestarts+' answerer restarts, '+w.popupsClosed+' popups closed'+(w.lastAction?'. Last: '+w.lastAction+' ('+ago(w.lastAgo)+')':'')}
  else{$('wd').textContent='Not running';$('wdS').textContent='Start ecnl-watchdog.'}
  $('rows').innerHTML=(d.recent||[]).map(r=>{const x=RES[r.result]||RES['?'];return '<tr><td>'+r.time+'</td><td>#'+r.emoji+'</td><td>'+r.color+'</td><td>'+r.secs.toFixed(1)+'</td><td class="res"><span class="dot" style="background:'+x[1]+'"></span>'+x[0]+'</td></tr>'}).join('')||'<tr><td colspan="5" class="sub">No answers yet</td></tr>';
 }catch(e){$('seen').textContent='Dashboard offline'}
}
tick();setInterval(tick,5000);
</script></body></html>`;

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Read-only dashboard'); }
  const url = req.url.split('?')[0];
  if (url === '/api/stats') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(compute())); }
  if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); return res.end(PAGE); }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, '0.0.0.0', () => console.log(`ECNL dashboard on http://0.0.0.0:${PORT}  (state: ${STATE_DIR})`));
