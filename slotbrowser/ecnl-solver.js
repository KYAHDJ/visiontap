#!/usr/bin/env node
'use strict';
// ECNL "Colors task" answerer (LOCAL TEST version).
// The question is a picture: 36 shapes (3 rows x 12) and the text "Identify the color of emoji #N ?".
//  - Shapes + colours are read from the picture with canvas (ecnl-vision.js, runs inside the page).
//  - The number N is read twice with Windows OCR (whole text strip and the badge alone); both must agree, else we STOP (never guess).
//  - Touch the page only when needed: connect -> read -> disconnect; later connect -> click the colour -> disconnect.
//  - The click is made ANSWER_AT_MS after the question was first seen (default 14 s; the site asks for a 13 s wait on every question).
// Env: VT_ECNL_CDP (http://127.0.0.1:9333), VT_ECNL_STATE_DIR, VT_ECNL_ANSWER_AT_MS (14000)
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { chromium } = require('./node_modules/playwright-core');
const VISION = require('./ecnl-vision.js');

const CDP = process.env.VT_ECNL_CDP || 'http://127.0.0.1:9333';
const STATE_DIR = process.env.VT_ECNL_STATE_DIR || path.join(__dirname, '..', 'state', 'ecnl');
const TASK_URL = 'https://ecnlmediamarket.com/dashboard/tasks/colors';
const ANSWER_AT_MS = Number(process.env.VT_ECNL_ANSWER_AT_MS || 14000);
const MAX_ANSWERS = Number(process.argv[2] || 1000000);
const OCR_PS1 = path.join(__dirname, 'ecnl-ocr.ps1');
fs.mkdirSync(path.join(STATE_DIR, 'samples'), { recursive: true });
const LOG = path.join(STATE_DIR, 'ecnl_answers.log'), STATS = path.join(STATE_DIR, 'ecnl_stats.json');

let STOP_FLAG = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d2 = n => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `${d.getFullYear()}-${d2(d.getMonth() + 1)}-${d2(d.getDate())} ${d2(d.getHours())}:${d2(d.getMinutes())}:${d2(d.getSeconds())}`; };
const log = l => { const s = `${stamp()} | ${l}`; try { fs.appendFileSync(LOG, s + '\n'); } catch (_) {} console.log(s); };

// ---- colours (anchors measured from the real pictures; yellow not seen yet -> several likely values)
const ANCHORS = {
  black: [[17, 17, 17]], white: [[255, 255, 255]], gray: [[156, 163, 175]], red: [[220, 38, 38]], orange: [[249, 115, 22]],
  yellow: [[234, 179, 8], [250, 204, 21], [245, 158, 11]], pink: [[244, 114, 182]], purple: [[147, 51, 234]], blue: [[37, 99, 235]],
  green: [[22, 163, 74]], brown: [[139, 69, 19]],
};
function nameColor(rgb) {
  const all = [];
  for (const [n, list] of Object.entries(ANCHORS)) for (const a of list) all.push([Math.hypot(rgb[0] - a[0], rgb[1] - a[1], rgb[2] - a[2]), n]);
  all.sort((a, b) => a[0] - b[0]);
  const best = all[0], other = all.find(x => x[1] !== best[1]);
  if (best[0] > 40 || other[0] - best[0] < 25) return { name: null, dist: best[0], second: other };
  return { name: best[1], dist: best[0] };
}

// ---- stats
const stats = { startedAt: Date.now(), updatedAt: Date.now(), status: 'starting', note: '', answersTotal: 0, notCounted: 0, today: { date: '', answers: 0 }, progress: null, wallet: null, lastAnswerAt: null, secondsPerAnswer: [], recent: [] };
const save = (status, note) => { if (status) stats.status = status; if (note !== undefined) stats.note = note; stats.updatedAt = Date.now(); try { fs.writeFileSync(STATS + '.tmp', JSON.stringify(stats)); fs.renameSync(STATS + '.tmp', STATS); } catch (_) {} };

// ---- page access: one short touch (connect -> run -> disconnect). Uses a raw CDP session because ad frames confuse page.evaluate.
async function touch(fn) {
  const browser = await chromium.connectOverCDP(CDP, { timeout: 8000 });
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages().find(p => /ecnlmediamarket\.com/.test(p.url())) || ctx.pages()[0];
    if (!page) throw new Error('no page');
    const sess = await ctx.newCDPSession(page);
    const ev = async (expr) => {
      const r = await sess.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('page script: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      return r.result.value;
    };
    return await fn({ page, ev, sess });
  } finally { await browser.close().catch(() => {}); }
}

const SNAP = `(()=>{const img=document.querySelector('img[alt^="Task question"]');const t=document.body?document.body.innerText:'';
 const pr=t.match(/(\\d+)\\s*\\/\\s*(\\d+)\\s*\\n/);const wl=t.match(/Task wallet\\s*\\n?\\s*₱\\s*([\\d,]+\\.\\d+)/);
 const btns=[...document.querySelectorAll('button')].map(b=>({t:(b.innerText||'').trim(),dis:b.disabled}));
 return JSON.stringify({url:location.href,hasImg:!!img,loaded:!!(img&&img.complete&&img.naturalWidth>0),key:img?(img.src.length+':'+img.src.slice(-60)):null,progress:pr?[+pr[1],+pr[2]]:null,wallet:wl?+wl[1].replace(/,/g,''):null,
  btns:btns.filter(b=>/^(blue|yellow|pink|black|red|white|gray|orange|purple|brown|green)$/i.test(b.t)||/submit|next|continue|confirm/i.test(b.t)),fb:(t.match(/(Correct!?.*|Incorrect.*|Wrong.*|Try again.*)/i)||[''])[0],head:t.slice(0,160).replace(/\\n/g,' ')})})()`;

function ocr1(file) {   // Windows: built-in OCR via PowerShell. Linux: tesseract (one text line). Empty text if neither exists.
  const cmd = process.platform === 'win32' ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OCR_PS1, '-Path', file]] : ['tesseract', [file, 'stdout', '--psm', '7']];
  return new Promise(res => execFile(cmd[0], cmd[1], { timeout: 30000, env: Object.assign({}, process.env, { OMP_THREAD_LIMIT: '1' }) }, (e, out) => res(e ? '' : String(out))));
}
async function ocr(file) { let t = await ocr1(file); if (!t.trim()) { await sleep(300); t = await ocr1(file); } return t; }
const numFrom = (txt, re) => { const m = String(txt).match(re); return m ? Number(m[1]) : null; };


// ---- digit reader (template matching against glyphs learned from this site's own font; learned only when two OCR readings agree)
const DIGITS_FILE = path.join(STATE_DIR, 'digits.json');
let LIB = {}; try { LIB = JSON.parse(fs.readFileSync(DIGITS_FILE, 'utf8')); } catch (_) {}
const bmDist = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
function tplDigit(bm) {
  const sc = [];
  for (const [d, list] of Object.entries(LIB)) for (const t of list) sc.push([bmDist(bm, t), d]);
  if (!sc.length) return null;
  sc.sort((a, b) => a[0] - b[0]);
  const best = sc[0], other = sc.find(x => x[1] !== best[1]);
  return { d: best[1], dist: best[0], gap: other ? other[0] - best[0] : 9 };
}
function tplNumber(bms) {   // bms = glyph bitmaps AFTER the '#'
  if (!bms.length || bms.length > 2) return { n: null, why: `${bms.length} glyphs` };
  const rs = bms.map(tplDigit); if (rs.some(r => !r)) return { n: null, why: 'library empty' };
  const worst = Math.max(...rs.map(r => r.dist)), gap = Math.min(...rs.map(r => r.gap));
  const n = Number(rs.map(r => r.d).join(''));
  return { n: (worst <= 0.09 && gap >= 0.04) ? n : null, raw: n, worst: +worst.toFixed(3), gap: +gap.toFixed(3) };
}
function learn(bms, n) {
  const ds = String(n); if (bms.length !== ds.length) return;
  let changed = false;
  bms.forEach((bm, i) => { const d = ds[i]; LIB[d] = LIB[d] || []; if (LIB[d].length < 6 && !LIB[d].some(t => bmDist(bm, t) < 0.02)) { LIB[d].push(bm); changed = true; } });
  if (changed) { try { fs.writeFileSync(DIGITS_FILE, JSON.stringify(LIB)); } catch (_) {} }
}

async function readQuestion(ev, tag) {
  const v = JSON.parse(await ev(`(${VISION})(document.querySelector('img[alt^="Task question"]').src)`));
  const crops = JSON.parse(await ev(`(async()=>{const img=document.querySelector('img[alt^="Task question"]');const W=img.naturalWidth,H=img.naturalHeight;
    const mk=(sx,sy,sw,sh,k,pad,bin)=>{const c=document.createElement('canvas');c.width=sw*k+pad*2;c.height=sh*k+pad*2;const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.imageSmoothingQuality='high';x.drawImage(img,sx,sy,sw,sh,pad,pad,sw*k,sh*k);if(bin){const id=x.getImageData(0,0,c.width,c.height),q=id.data;for(let i=0;i<q.length;i+=4){const l=0.299*q[i]+0.587*q[i+1]+0.114*q[i+2];const v=l<120?0:255;q[i]=q[i+1]=q[i+2]=v}x.putImageData(id,0,0)}return c.toDataURL('image/png')};
    const b=${JSON.stringify(v.badge)};
    return JSON.stringify({strip:mk(0,Math.round(H*0.70),W,H-Math.round(H*0.70)-Math.round(H*0.06),1.5,10,true),badge:b.x2>0?mk(Math.max(0,b.x1-200),b.y1-6,b.x2-b.x1+200+70,b.y2-b.y1+12,3,14,true):null,raw:img.src})})()`));
  return { v, crops };
}

async function main() {
  save('starting', 'starting');
  let lastKey = null, answered = 0, firstSeen = 0, snap = null, consecutiveErr = 0;
  log(`ECNL answerer started (click ${ANSWER_AT_MS / 1000} s after the question shows)`);
  for (; answered < MAX_ANSWERS;) {
    if (STOP_FLAG) { save('needs_owner', 'number readers disagreed'); process.exit(3); }
    try {
      // 1) look (short touch)
      snap = await touch(async ({ ev }) => JSON.parse(await ev(SNAP)));
      consecutiveErr = 0;
      if (snap.progress) stats.progress = snap.progress; if (snap.wallet != null) stats.wallet = snap.wallet;
      if (/\/(login|auth|signin|sign-in|register)/i.test(snap.url) || /\/(login|auth)/i.test(snap.url)) { save('login_required', 'Waiting for you to sign in'); await sleep(4000); continue; }
      if (!/\/dashboard\/tasks\/colors/.test(snap.url)) { save('opening_task', 'opening the colors task'); await touch(async ({ page }) => { await page.goto(TASK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); }); await sleep(2500); continue; }
      if (!snap.hasImg || !snap.loaded) { save('waiting_for_task', 'no question showing yet'); await sleep(500); continue; }
      if (snap.key === lastKey) { save('running', 'waiting for the next question'); await sleep(500); continue; }

      // 2) a NEW question is showing: read it (one touch), then disconnect and think
      const t0 = Date.now();
      const q = await touch(async ({ ev }) => readQuestion(ev)); const tRead = Date.now() - t0;
      const { v, crops } = q;
      const base = path.join(STATE_DIR, 'samples', String(Date.now()));
      fs.writeFileSync(base + '.jpg', Buffer.from(crops.raw.split(',')[1], 'base64'));
      fs.writeFileSync(base + '_strip.png', Buffer.from(crops.strip.split(',')[1], 'base64'));
      if (crops.badge) fs.writeFileSync(base + '_badge.png', Buffer.from(crops.badge.split(',')[1], 'base64'));
      const ocrJob = Promise.all([ocr(base + '_strip.png'), crops.badge ? ocr(base + '_badge.png') : Promise.resolve('')]);
      const tp0 = tplNumber((v.bm || []).slice(1));
      let o1 = '', o2 = '';
      if (tp0.n != null) {   // the learned digit reader is sure: do not wait for OCR; check against OCR afterwards
        ocrJob.then(([a, b]) => { const x = numFrom(a, /#\s*(\d{1,2})/), y = numFrom(b, /#\s*(\d{1,2})/) ?? numFrom(b, /(\d{1,2})/);
          if (x != null && x === y) { if (x !== tp0.n) { log(`WARNING: OCR says ${x}, digit reader said ${tp0.n} (sample ${base}) - stopping`); STOP_FLAG = true; } else learn((v.bm || []).slice(1), x); } });
      } else { [o1, o2] = await ocrJob; }
      const tOcr = Date.now() - t0;
      const n1 = numFrom(o1, /#\s*(\d{1,2})/), n2 = numFrom(o2, /#\s*(\d{1,2})/) ?? numFrom(o2, /(\d{1,2})/);
      const nOcr = (n1 != null && n1 === n2) ? n1 : null;
      const tp = tplNumber((v.bm || []).slice(1));
      let N = null, how = '';
      if (nOcr != null && tp.n != null && nOcr !== tp.n) { save('needs_owner', 'number readers disagree'); log(`STOP: readers disagree (ocr ${nOcr}, template ${tp.n}) sample ${base}`); process.exit(3); }
      if (nOcr != null) { N = nOcr; how = 'ocr' + (tp.n === nOcr ? '+tpl' : ''); learn((v.bm || []).slice(1), N); }
      else if (tp.n != null) { N = tp.n; how = 'tpl'; }
      if (N == null && process.env.VT_ECNL_ASSUME_N) { N = Number(process.env.VT_ECNL_ASSUME_N); how = 'owner-labelled'; learn((v.bm || []).slice(1), N); delete process.env.VT_ECNL_ASSUME_N; }   // one-off helper (used once only) for teaching the digit reader
      if (v.count !== 36 || v.rowCounts.join(',') !== '12,12,12') { save('needs_owner', `picture not understood: ${v.count} shapes rows ${v.rowCounts}`); log(`STOP: picture not understood (${v.count} shapes, rows ${v.rowCounts}) sample ${base}`); process.exit(3); }
      if (!N || N < 1 || N > 36) { save('needs_owner', 'could not read the number'); log(`STOP: number not read (ocr strip "${o1.trim()}" -> ${n1}, tail "${o2.trim()}" -> ${n2}; template ${JSON.stringify(tp)}) sample ${base}`); process.exit(3); }
      const cell = v.cells[N - 1], col = nameColor(cell.rgb);
      if (!col.name) { save('needs_owner', `unknown colour rgb ${cell.rgb}`); log(`STOP: unknown colour rgb(${cell.rgb}) at emoji ${N} (nearest ${col.dist.toFixed(0)}) sample ${base}`); process.exit(3); }
      fs.writeFileSync(base + '.json', JSON.stringify({ N, cell, color: col.name, o1, o2 }));

      // 3) wait until the planned moment (14 s after the question showed), then click
      const fireAt = t0 + ANSWER_AT_MS;
      await sleep(Math.max(0, fireAt - 2600 - Date.now()));       // connect a little early so the click lands on time
      const before = { progress: snap.progress, wallet: snap.wallet };
      const clicked = await touch(async ({ page, ev }) => {
        const cur = JSON.parse(await ev(SNAP));
        if (cur.key !== snap.key) return { stale: true };
        const find = `(()=>{const b=[...document.querySelectorAll('button')].find(b=>(b.innerText||'').trim().toLowerCase()===${JSON.stringify(col.name)});if(!b)return 'null';b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2,dis:b.disabled})})()`;
        let pos = JSON.parse(await ev(find));
        if (!pos) return { nobutton: true };
        await sleep(Math.max(0, fireAt - Date.now()));
        for (let i = 0; i < 20 && pos.dis; i++) { await sleep(150); pos = JSON.parse(await ev(find)) || pos; }   // site still counting down: wait for the button
        const clickAt = Date.now() - t0;
        await page.mouse.click(pos.x, pos.y);
        await sleep(600);
        const sub = JSON.parse(await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/^(submit|confirm|next|continue)/i.test((b.innerText||'').trim())&&!b.disabled);if(!b)return 'null';const r=b.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})})()`));
        if (sub) await page.mouse.click(sub.x, sub.y);
        return { clicked: true, atMs: clickAt, sub: !!sub };
      });
      if (clicked.stale) { log('question changed before the click -> skipping'); lastKey = null; continue; }
      if (clicked.nobutton) { log(`no button for ${col.name}`); save('needs_owner', 'colour button missing'); process.exit(3); }
      lastKey = snap.key; answered++;

      // 4) check the result (short touches until the page moves on)
      let after = null, fb = '';
      for (let i = 0; i < 40; i++) { await sleep(450); try { after = await touch(async ({ ev }) => JSON.parse(await ev(SNAP))); } catch (_) { continue; } if (after.fb && (after.fb !== snap.fb || after.key !== snap.key)) fb = after.fb; if (/correct|incorrect|wrong|try again/i.test(fb) || after.key !== snap.key) break; }
      const bad = /incorrect|wrong|try again/i.test(fb) && !/^correct/i.test(fb);
      const ok = /^correct/i.test(fb) ? true : (bad ? false : null);
      const pa = before.progress ? before.progress[0] : null, pb = after && after.progress ? after.progress[0] : null;
      if (after) { if (after.progress) stats.progress = after.progress; if (after.wallet != null) stats.wallet = after.wallet; }
      stats.answersTotal++; if (ok === false) stats.notCounted++; if (ok === null) stats.unconfirmed = (stats.unconfirmed || 0) + 1;
      stats.lastAnswerAt = Date.now(); stats.recent.push(Date.now()); if (stats.recent.length > 300) stats.recent.shift();
      const secs = (Date.now() - t0) / 1000; stats.secondsPerAnswer.push(+secs.toFixed(1)); if (stats.secondsPerAnswer.length > 100) stats.secondsPerAnswer.shift();
      log(`#${stats.answersTotal} | emoji ${N} | cell (${cell.x},${cell.y}) rgb(${cell.rgb}) | answered: ${col.name} | clicked at ${(clicked.atMs / 1000).toFixed(1)} s${clicked.sub ? ' +submit' : ''} | site says "${fb}" ${ok === true ? 'OK' : ok === false ? 'WRONG' : '?'} (progress ${pa} -> ${pb}) | wallet ${stats.wallet} | read by ${how} | read ${(tRead / 1000).toFixed(1)} s, ocr done ${(tOcr / 1000).toFixed(1)} s`);
      save('running', 'answering');
      if (ok === false) { save('needs_owner', 'the site said the answer was wrong'); log('STOP: the site said wrong - please check'); process.exit(2); }
    } catch (e) {
      consecutiveErr++; save('error', String(e.message || e).slice(0, 160)); log('error: ' + String(e.message || e).slice(0, 200));
      if (consecutiveErr > 8) process.exit(1); await sleep(3000);
    }
  }
  save('finished', `done ${answered}`); log(`finished ${answered} answers`);
}
main();
