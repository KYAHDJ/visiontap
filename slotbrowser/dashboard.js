const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const PORT = 8080;
const ELECTRON_STATE_DIR = path.join(os.homedir(), ".config", "VisionTap Slots", "state");
const CREDS_FILE = path.join(ELECTRON_STATE_DIR, "credentials.json");
const HISTORY_FILE = path.join(ELECTRON_STATE_DIR, "cred_history.json");
const LOOP_CMD_FILE = path.join(ELECTRON_STATE_DIR, "loop_command.json");
const SLOTS_FILE = path.join(ELECTRON_STATE_DIR, "slots.json");
const SLOT_CMD_FILE = path.join(ELECTRON_STATE_DIR, "slot_commands.json");

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// Dashboard persistent metrics (survives restarts/resets) — per-slot
const METRICS_FILE = path.join(ELECTRON_STATE_DIR, "dashboard_metrics.json");

function loadMetrics() {
  return readJson(METRICS_FILE, {}); // { [id]: { windowStart, correctAtStart, prevCorrect, ppm, pph, cooldownStart, lastComputedAt, lastBalanceValue, lastBalanceTime, targetPoints } }
}
function saveMetrics(m) {
  writeJson(METRICS_FILE, m);
}
function getSlotMetrics(all, id) {
  if (!all[id]) {
    all[id] = {
      windowStart: 0,
      pointsAtStart: 0,
      prevPoints: null,
      ppm: 0,
      pph: 0,
      cooldownStart: 0,
      lastComputedAt: 0,
      lastBalanceValue: 0,
      lastBalanceTime: 0,
      targetPoints: 1200,
      balanceHistory: [],
      lastHistoryCheck: 0
    };
  } else {
    if (all[id].prevCorrect != null && all[id].prevPoints == null) {
      all[id].prevPoints = null;
      delete all[id].prevCorrect;
      delete all[id].correctAtStart;
    }
    if (all[id].pointsAtStart == null) all[id].pointsAtStart = 0;
    if (all[id].prevPoints === undefined) all[id].prevPoints = null;
    if (!Array.isArray(all[id].balanceHistory)) all[id].balanceHistory = [];
    if (all[id].lastHistoryCheck == null) all[id].lastHistoryCheck = 0;
  }
  return all[id];
}
function pointsDelta(cur, start) {
  cur = Number(cur) || 0;
  start = Number(start) || 0;
  if (cur >= start) return cur - start;
  // wrap 0-250 cycle reset
  return (250 - start) + cur;
}

function run(cmd) {
  try { return execSync(cmd, { timeout: 10000 }).toString().trim(); }
  catch (e) { return "error"; }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) { log(`writeJson ERROR ${file}: ${e.message}`); }
}

function getCreds() { return readJson(CREDS_FILE, {}); }
function getHistory() { return readJson(HISTORY_FILE, { users: [] }); }
function getElectronSlots() { return readJson(SLOTS_FILE, { active: [] }); }
function isLoopPaused() {
  try { return JSON.parse(fs.readFileSync(LOOP_CMD_FILE, "utf8")).action === "pause"; }
  catch (e) { return false; }
}
function getStats() {
  try { return JSON.parse(run("curl -s http://127.0.0.1:5566/stats")); }
  catch (e) { return { slots: {} }; }
}
function getEarnings() {
  try { return JSON.parse(run("curl -s http://127.0.0.1:5566/earnings")); }
  catch (e) { return {}; }
}
function getStatus() {
  const scannerUp = run("curl -s http://127.0.0.1:5566/health").includes("online");
  const electronProcs = parseInt(run("ps aux | grep electron | grep -v grep | wc -l")) || 0;
  const stats = getStats();
  const earnings = getEarnings();
  const loopPaused = isLoopPaused();
  return { scannerUp, electronProcs, stats, earnings, loopPaused };
}
function getMergedSlots(status) {
  const electronSlots = getElectronSlots();
  const scannerSlots = (status.stats && status.stats.slots) || {};
  const slotEarnings = (status.earnings) || {};
  const creds = getCreds();
  const merged = [];
  for (const slot of (electronSlots.active || [])) {
    const id = String(slot.id);
    const name = slot.accountName || slot.name || `Slot ${Number(id) + 1}`;
    // Resolve scanner slot by id/name/legacy — pick freshest (max taskCount/withdrawable) among candidates (always live)
    // Always show exact web numbers: prefer direct id (live), fallback to name/legacy only if id missing
    let sc = scannerSlots[id] || scannerSlots[name] || scannerSlots[`Slot ${id}`] || scannerSlots[`Slot ${Number(id) + 1}`] || scannerSlots[String(Number(id)+1)] || null;
    if (!sc || Object.keys(sc).length === 0) {
      // No candidate, fallback to best among all
      const all = Object.entries(scannerSlots);
      if (all.length === 1) sc = all[0][1];
      else if (all.length > 1) {
        let best = null;
        for (const [k, v] of all) {
          if (!best) best = v;
          else {
            const aTasks = Number(v.taskCount || v.correctCount || 0);
            const bTasks = Number(best.taskCount || best.correctCount || 0);
            if (aTasks > bTasks) best = v;
          }
        }
        sc = best || {};
      } else sc = {};
    }
    if (!sc) sc = {};
    const cred = creds[id] || creds[slot.id] || {};
    // Earnings per-slot only — no shared fallback (prevents 1085 for all slots)
    let hist = slotEarnings[id] || slotEarnings[name] || slotEarnings[`Slot ${id}`] || slotEarnings[`Slot ${Number(id) + 1}`] || null;
    if (!hist || !Array.isArray(hist) || hist.length === 0) hist = [];
    if (!Array.isArray(hist)) hist = [];
    const totalEarned = hist.reduce((sum, e) => sum + (e.earning || 0), 0);
    let pointsDone = sc.pointsDone != null ? Number(sc.pointsDone) : 0;
    let pointsTotal = sc.pointsTotal != null && Number(sc.pointsTotal) !== 0 ? Number(sc.pointsTotal) : 250;
    // Live: when new cycle 0-10 (e.g., 4/250), show current not old compiled — clear old cache
    let displayHist = hist;
    if (pointsDone >= 250) {
      pointsDone = 0;
      displayHist = [];
    }
    if (pointsDone >= 0 && pointsDone <= 10) {
      // New cycle start — don't show old 195+ history, show fresh
      displayHist = [];
    }

    // --- Persistent per-slot metrics (pointsDone-based, PH time) ---
    const metricsAll = loadMetrics();
    const ms = getSlotMetrics(metricsAll, id);
    const nowMs = Date.now();
    const currentWithdrawable = sc.withdrawable != null ? Number(sc.withdrawable) : 0;
    // pointsDone is 0-250 cycle; use it for ppm (correctCount stays 0 on Oracle)
    const curPoints = pointsDone;
    let dirty = false;

    // Init prevPoints on first sight (avoid inflated delta)
    if (ms.prevPoints === null) {
      ms.prevPoints = curPoints;
      ms.pointsAtStart = curPoints;
      dirty = true;
    }

    // Balance history — 2-min timer, 10 entries scrollable, persisted per-slot
    if (!Array.isArray(ms.balanceHistory)) ms.balanceHistory = [];
    if (ms.balanceHistory.length === 0 && currentWithdrawable !== 0) {
      ms.balanceHistory.push({ value: currentWithdrawable, time: nowMs });
      ms.lastBalanceValue = currentWithdrawable;
      ms.lastBalanceTime = nowMs;
      ms.lastHistoryCheck = nowMs;
      dirty = true;
    } else if (ms.balanceHistory.length > 0) {
      const lastEntry = ms.balanceHistory[ms.balanceHistory.length - 1];
      const balChanged = currentWithdrawable !== lastEntry.value && currentWithdrawable !== 0;
      if (balChanged) {
        ms.balanceHistory.push({ value: currentWithdrawable, time: nowMs });
        if (ms.balanceHistory.length > 10) ms.balanceHistory = ms.balanceHistory.slice(-10);
        ms.lastBalanceValue = currentWithdrawable;
        ms.lastBalanceTime = nowMs;
        ms.lastHistoryCheck = nowMs;
        dirty = true;
      } else {
        if (nowMs - (ms.lastHistoryCheck || 0) >= 120000) {
          lastEntry.time = nowMs;
          ms.lastBalanceValue = currentWithdrawable;
          ms.lastBalanceTime = nowMs;
          ms.lastHistoryCheck = nowMs;
          dirty = true;
        }
      }
      if (ms.lastBalanceValue !== currentWithdrawable) {
        ms.lastBalanceValue = currentWithdrawable;
        ms.lastBalanceTime = nowMs;
        dirty = true;
      }
    }

    // Target logic: 250 task points = 3 pesos (83.33 pts/₱) — fixed to 3 as requested
    const POINTS_PER_CYCLE = 250;
    const PESOS_PER_CYCLE = 3;
    const POINTS_PER_PESO = POINTS_PER_CYCLE / PESOS_PER_CYCLE; // 83.333...
    let targetPesos = ms.targetPesos || (ms.targetPoints ? Math.trunc(ms.targetPoints/4) : 300);
    if (!targetPesos || targetPesos < 300) targetPesos = 300;
    if (ms.targetPoints && !ms.targetPesos) {
      targetPesos = Math.trunc(ms.targetPoints/4);
      if (targetPesos < 300) targetPesos = 300;
    }
    while (currentWithdrawable >= targetPesos) {
      targetPesos += 100;
      dirty = true;
    }
    ms.targetPesos = targetPesos;
    if (ms.targetPoints) { delete ms.targetPoints; dirty = true; }
    const pesosNeeded = Math.max(0, targetPesos - currentWithdrawable);
    const pointsUntilMid = Math.max(0, Math.trunc(pesosNeeded * POINTS_PER_PESO));
    const pointsUntilLow = pointsUntilMid;
    const pointsUntilHigh = pointsUntilMid;
    const currentTargetPoints = Math.trunc(targetPesos * POINTS_PER_PESO);
    const pointsUntilTarget = pointsUntilMid;

    // Per-minute: points delta over 60s window (1-min detect / 1-min break), truncated whole number
    // Window starts on any points increment, captures delta for 60s, then 60s cooldown

    // Handle cooldown expiry
    if (ms.cooldownStart > 0) {
      if (nowMs - ms.cooldownStart >= 60000) {
        ms.cooldownStart = 0;
        ms.windowStart = 0;
        ms.pointsAtStart = curPoints;
        ms.prevPoints = curPoints;
        dirty = true;
      }
    }

    // Detect increment vs prevPoints (handle 0-250 wrap)
    let hasIncrement = false;
    if (ms.prevPoints !== null && ms.prevPoints !== curPoints) {
      // any change counts — pointsDone only moves forward 1 per task (~15-20s) or wrap 249->0
      // incremental check: if cur != prev, consider increment
      hasIncrement = true;
    }

    if (ms.cooldownStart === 0) {
      if (ms.windowStart === 0) {
        if (hasIncrement && ms.prevPoints !== null) {
          // start new 60s window on first increment after idle
          ms.windowStart = nowMs;
          ms.pointsAtStart = ms.prevPoints; // delta will include this increment via wrap-aware diff
          dirty = true;
        }
        // sync prevPoints when idle
        if (ms.prevPoints !== curPoints && ms.windowStart === 0) {
          ms.prevPoints = curPoints;
          dirty = true;
        }
      } else {
        // window active — check 60s elapsed
        const elapsed = nowMs - ms.windowStart;
        if (elapsed >= 60000) {
          const count = pointsDelta(curPoints, ms.pointsAtStart);
          const ppm = Math.trunc(Math.max(0, count)); // truncate, never round up (3.7 ->3)
          const pph = ppm * 60;
          ms.ppm = ppm;
          ms.pph = pph;
          ms.lastComputedAt = nowMs;
          ms.cooldownStart = nowMs; // 1 minute break
          ms.windowStart = 0;
          ms.pointsAtStart = curPoints;
          ms.prevPoints = curPoints;
          dirty = true;
        } else {
          // still within window — track latest, keep ppm frozen until window closes
          // but for live display when ppm==0, we will show running delta
          ms.prevPoints = curPoints;
          dirty = true;
        }
      }
    } else {
      // in cooldown — keep prevPoints synced
      if (ms.prevPoints !== curPoints) {
        ms.prevPoints = curPoints;
        dirty = true;
      }
    }

    // Derive live ppm/pph: show last completed ppm; if mid-window and no completed yet, show running truncated delta live
    let displayPpm = ms.ppm || 0;
    let displayPph = ms.pph || 0;
    if (ms.windowStart > 0) {
      // running live delta
      const running = Math.trunc(Math.max(0, pointsDelta(curPoints, ms.pointsAtStart)));
      // if we have no completed ppm yet, show running; otherwise show max of completed and running for live feel
      if (ms.ppm === 0) {
        displayPpm = running;
        displayPph = running * 60;
      } else {
        // also expose live adjusting during window: use running if larger than last completed for immediate feedback
        // but keep at least last completed value
        if (running > 0) {
          displayPpm = running;
          displayPph = running * 60;
        }
      }
    }

    // ETA — live adjusting based on displayPph
    let etaHours = 0;
    let etaText = "";
    if (displayPph > 0 && pointsUntilTarget > 0) {
      etaHours = pointsUntilTarget / displayPph;
      if (etaHours < 1) {
        const mins = Math.trunc(etaHours * 60);
        etaText = mins <= 1 ? "1 min" : mins + " mins";
      } else {
        const h = Math.trunc(etaHours);
        const mins = Math.trunc((etaHours - h) * 60);
        if (mins === 0) etaText = h + (h === 1 ? " hour" : " hours");
        else etaText = h + "h " + mins + "m";
      }
    } else if (pointsUntilTarget === 0) {
      etaText = "reached";
    } else {
      etaText = "-";
    }

    if (dirty) saveMetrics(metricsAll);

    const mergedSlot = {
      id, name, accountName: slot.accountName || "",
      user: cred.user || "", pass: cred.pass || "",
      correctCount: sc.correctCount || 0,
      wrongCount: sc.wrongCount || 0,
      errorCount: sc.errorCount || 0,
      taskCount: sc.taskCount || 0,
      withdrawable: sc.withdrawable != null ? sc.withdrawable : 0,
      pointsDone: pointsDone,
      pointsTotal: pointsTotal,
      totalEarned: Math.round(totalEarned * 10000) / 10000,
      lastUpdate: sc.lastUpdate || "",
      earningsHistory: displayHist.filter(e => e && e.earning < 10).slice(-20).reverse(),
      pointsHistory: sc.pointsHistory || slot.pointsHistory || [],
      timerText: sc.timerText || slot.timerText || "00:00",
      elapsed: sc.elapsed != null ? sc.elapsed : (slot.elapsed || 0),
      loopStartTime: slot.loopStartTime || sc.loopStartTime || null,
      // Live metrics (PH dashboard time, persisted) — 250 pts = 3 pesos
      pointsPerMinute: displayPpm,
      pointsPerHour: displayPph,
      pointsUntilTarget: pointsUntilTarget,
      currentTargetPoints: currentTargetPoints,
      targetPesos: targetPesos,
      pesosNeeded: Math.round(pesosNeeded*100)/100,
      pointsUntilLow: pointsUntilLow,
      pointsUntilHigh: pointsUntilHigh,
      etaHours: etaHours,
      etaText: etaText,
      lastBalanceUpdate: ms.lastBalanceTime || 0,
      lastBalanceValue: ms.lastBalanceValue != null ? ms.lastBalanceValue : 0,
      balanceHistory: Array.isArray(ms.balanceHistory) ? ms.balanceHistory.slice(-10) : [],
      _windowActive: ms.windowStart > 0,
      _cooldownActive: ms.cooldownStart > 0
    };
    merged.push(mergedSlot);
  }
  return merged;
}
function sendCommands(cmds) {
  writeJson(SLOT_CMD_FILE, cmds);
  log(`Commands sent: ${JSON.stringify(cmds)}`);
}

function buildPage() {
  const history = getHistory();
  const historyOpts = history.users.map(v => `<option value="${v}">`).join("");

  const v = Date.now();
  return `<!DOCTYPE html><!-- VisionTap v${v} -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>VisionTap Control</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0e1a;--card:#111827;--border:#1e293b;--text:#e2e8f0;--muted:#64748b;--accent:#38bdf8;--green:#10b981;--red:#ef4444;--yellow:#f59e0b;--purple:#a78bfa}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;-webkit-tap-highlight-color:transparent}
.wrap{max-width:600px;margin:0 auto;padding:12px 12px 60px}
h1{font-size:18px;text-align:center;color:var(--accent);margin-bottom:12px}
.pills{display:flex;gap:6px;margin-bottom:12px;justify-content:center;flex-wrap:wrap}
.pill{display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:16px;font-size:10px;font-weight:500;background:var(--card);border:1px solid var(--border);white-space:nowrap}
.dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.stitle{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin:14px 0 6px}
.section-aiko-title{color:#38bdf8; border-left:3px solid #38bdf8; padding-left:8px; background:rgba(56,189,248,0.08); border-radius:4px; padding:4px 8px;}
.section-danica-title{color:#f472b6; border-left:3px solid #f472b6; padding-left:8px; background:rgba(244,114,182,0.08); border-radius:4px; padding:4px 8px;}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:8px}
.card-aiko{background:linear-gradient(135deg, rgba(30,41,59,0.9), rgba(15,30,60,0.9)); border-color:rgba(56,189,248,0.25);}
.card-danica{background:linear-gradient(135deg, rgba(40,20,35,0.9), rgba(60,20,40,0.9)); border-color:rgba(244,114,182,0.35);}
.card-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.card-nm{font-weight:600;font-size:14px}
.card-bg{font-size:9px;padding:2px 8px;border-radius:10px;font-weight:600}
.sgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;text-align:center;margin-bottom:8px}
.sbox{background:#0f172a;border-radius:6px;padding:6px 4px}
.sv{font-weight:700;font-size:14px;line-height:1.2}
.sl{color:var(--muted);font-size:9px;margin-top:1px}
.pbar{background:#0f172a;border-radius:4px;height:5px;margin-bottom:8px;overflow:hidden}
.pfill{height:100%;border-radius:4px;background:linear-gradient(90deg,#a78bfa,#38bdf8);transition:width .5s}
.crow{display:flex;gap:4px;margin-bottom:6px}
.crow input{flex:1;padding:6px 8px;background:#0f172a;border:1px solid #334155;color:var(--text);border-radius:5px;font-size:12px;min-width:0}
.crow input:focus{outline:none;border-color:var(--accent)}
.bsm{padding:6px 10px;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0}
.bsv{background:var(--green);color:#fff}
.bsv:active{opacity:.7}
.ehd{font-size:9px;color:var(--muted);margin-top:6px;margin-bottom:4px;font-weight:600;text-transform:uppercase}
.elst{max-height:140px;overflow-y:auto;-webkit-overflow-scrolling:touch}
.erow{display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:11px;border-bottom:1px solid #0f172a;gap:4px}
.eamt{color:var(--green);font-weight:600;white-space:nowrap}
.etsk{color:var(--muted);font-size:10px;white-space:nowrap}
.eclr{color:#475569;font-size:10px;text-transform:capitalize;white-space:nowrap}
.ets{color:#475569;font-size:9px;white-space:nowrap}
.sacts{display:flex;gap:4px;justify-content:flex-end;margin-top:6px}
.ibtn{width:30px;height:30px;border:none;border-radius:6px;background:#0f172a;color:var(--muted);cursor:pointer;font-size:13px;display:inline-flex;align-items:center;justify-content:center;text-decoration:none;transition:background .15s}
.ibtn:active{background:#1a2332;color:var(--text)}
.ibtn.dng:active{color:var(--red)}
.ggrid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px}
.btn{display:block;width:100%;padding:10px;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none;text-align:center;transition:opacity .15s}
.btn:active{opacity:.7}
.bgrn{background:var(--green);color:#fff}
.bred{background:var(--red);color:#fff}
.byel{background:var(--yellow);color:#000}
.bpur{background:var(--purple);color:#fff}
.bful{grid-column:span 2}
.ftr{text-align:center;padding:12px 0;font-size:10px;color:#334155}
.livedot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);margin-right:4px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
@media(max-width:380px){.wrap{padding:8px 8px 60px}.crow{flex-direction:column}.crow input{width:100%}.bsm{width:100%}}
.b2col{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0 8px}
.bcol{background:#0f172a;border:1px solid #1e293b;border-radius:6px;padding:6px;cursor:pointer;min-height:88px;display:flex;flex-direction:column}
.bcol:hover{border-color:#334155}
.bcol-hd{font-weight:600;color:var(--text);font-size:9px;margin-bottom:4px;letter-spacing:0.3px}
.bhist-list{max-height:92px;overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1;scrollbar-width:thin;scrollbar-gutter:stable;padding-right:4px}
.bhist-list::-webkit-scrollbar{width:4px}
.bhist-list::-webkit-scrollbar-thumb{background:#334155;border-radius:4px}
.bhist-list::-webkit-scrollbar-track{background:transparent}
.bhist-row{display:flex;justify-content:space-between;align-items:center;padding:2px 0;font-size:9px;border-bottom:1px solid #1e293b;gap:4px}
.bhist-val{color:#facc15;font-weight:600;white-space:nowrap}
.bhist-time{color:var(--muted);font-size:8px;white-space:nowrap}
.bcalc-line{font-size:9px;color:var(--muted);margin-top:2px;line-height:1.3}
.bcalc-em{color:var(--text);font-weight:600}
.bcol{background:#0f172a;border:1px solid #1e293b;border-radius:6px;padding:6px;min-height:88px;display:flex;flex-direction:column}
.bcol-hd{font-weight:600;color:var(--text);font-size:9px;margin-bottom:4px;letter-spacing:0.3px}
</style>
</head>
<body>
<div class="wrap">
  <h1>VisionTap Control</h1>
  <div class="pills" id="pills"></div>
  <div class="stitle">Global Controls</div>
  <div class="ggrid">
    <a class="btn bgrn" href="/cmd?action=resume&slot=all">Resume All</a>
    <a class="btn bred" href="/cmd?action=pause&slot=all">Pause All</a>
    <a class="btn byel" href="/cmd?action=restart&slot=all">Restart All</a>
    <a class="btn bpur" href="/cmd?action=refresh&slot=all">Refresh All</a>
    <a class="btn bred bful" href="/cmd?action=remove&slot=all" onclick="return confirm('Remove ALL slots?')">Remove All Slots</a>
  </div>
  <div class="stitle">Loop</div>
  <div class="ggrid">
    <a class="btn bgrn bful" id="lbtn" href="/loop?cmd=resume">Resume Loop</a>
  </div>
  <div class="stitle section-aiko-title">AIKO — <span id="scnt-aiko">0</span> slots</div>
  <div id="slots-aiko"></div>
  <div class="stitle section-danica-title">DANICA — <span id="scnt-danica">0</span> slot</div>
  <div id="slots-danica"></div>
  <div class="stitle">Server</div>
  <div class="ggrid">
    <a class="btn bgrn bful" href="/restart" onclick="return confirm('Restart VisionTap?')">Restart VisionTap</a>
  </div>
  <div class="ftr"><span class="livedot"></span><span id="ltxt">Connecting...</span></div>
</div>
<datalist id="hu">${historyOpts}</datalist>
<script>
var POLL=2000,LD='';

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

function render(d){
  var slots=d.slots||[];
  var aikoSlots = slots.filter(s => String(s.id) !== "13" && String(s.accountName).toLowerCase() !== "danicajgb");
  var danicaSlots = slots.filter(s => String(s.id) === "13" || String(s.accountName).toLowerCase() === "danicajgb");
  document.getElementById('scnt-aiko').textContent=aikoSlots.length;
  document.getElementById('scnt-danica').textContent=danicaSlots.length;
  document.getElementById('pills').innerHTML=
    '<div class="pill"><div class="dot" style="background:'+(d.scannerUp?'var(--green)':'var(--red)')+'"></div>Scanner '+(d.scannerUp?'Online':'Offline')+'</div>'+
    '<div class="pill"><div class="dot" style="background:'+(d.electronProcs>0?'var(--green)':'var(--red)')+'"></div>Electron '+(d.electronProcs>0?'Running':'Stopped')+'</div>'+
    '<div class="pill"><div class="dot" style="background:'+(d.loopPaused?'var(--yellow)':'var(--green)')+'"></div>Loop '+(d.loopPaused?'Paused':'Running')+'</div>';
  var lb=document.getElementById('lbtn');
  if(d.loopPaused){lb.href='/loop?cmd=resume';lb.textContent='Resume Loop';lb.className='btn bgrn bful'}
  else{lb.href='/loop?cmd=pause';lb.textContent='Pause Loop';lb.className='btn bred bful'}
  var hAiko='', hDanica='';
  for(var i=0;i<slots.length;i++){
    var s=slots[i];
    var isDanica = String(s.id) === "13" || String(s.accountName).toLowerCase() === "danicajgb";
    var sc=isDanica ? '#f472b6' : '#38bdf8';
    var cardClass = isDanica ? 'card-danica' : 'card-aiko';
    var st=isDanica ? 'DANICA' : 'AIKO';
    var pts=s.pointsTotal>0?s.pointsDone+'/'+s.pointsTotal:s.taskCount+' tasks';
    var pct=s.pointsTotal>0?Math.round((s.pointsDone/s.pointsTotal)*100):0;
    var sid=encodeURIComponent(s.id);
    var eh='';
    if(s.earningsHistory&&s.earningsHistory.length>0){
      eh='<div class="ehd">Earnings History</div><div class="elst">';
      for(var j=0;j<s.earningsHistory.length;j++){
        var e=s.earningsHistory[j];
        eh+='<div class="erow"><span class="eamt">+'+e.earning+'</span><span class="etsk">#'+(e.taskNum||'?')+'</span><span class="eclr">'+(e.color||'')+'</span><span class="ets">'+(e.ts||'')+'</span></div>';
      }
      eh+='</div>';
    }
    var cardHtml='<div class="card '+cardClass+'">'+
      '<div class="card-hd"><span class="card-nm">'+esc(s.name)+'</span><span class="card-bg" style="background:'+sc+'20;color:'+sc+'">'+st+'</span></div>'+
      '<div class="sgrid">'+
        '<div class="sbox"><div class="sv" style="color:#facc15">&#8369;'+s.withdrawable+'</div><div class="sl">Balance</div></div>'+
        '<div class="sbox"><div class="sv" style="color:#a78bfa">'+pts+'</div><div class="sl">Points</div></div>'+
        '<div class="sbox"><div class="sv" style="color:#38bdf8" id="timer-'+esc(s.id)+'">'+esc(s.timerText||'00:00')+'</div><div class="sl">Time</div></div>'+
      '</div>'+
      (s.pointsTotal>0?'<div class="pbar"><div class="pfill" style="width:'+pct+'%"></div></div>':'')+
      (function(){
        var ptsPerMin = (s.pointsPerMinute != null ? s.pointsPerMinute : 0);
        var ptsPerHour = (s.pointsPerHour != null ? s.pointsPerHour : 0);
        var ptsUntilMid = (s.pointsUntilTarget != null ? s.pointsUntilTarget : 0);
        var targetPesos = (s.targetPesos != null ? s.targetPesos : 300);
        var pesosNeeded = (s.pesosNeeded != null ? s.pesosNeeded : Math.max(0, targetPesos - Number(s.withdrawable||0)));
        var etaText = (s.etaText != null && s.etaText !== "" ? s.etaText : "-");
        var balHist = Array.isArray(s.balanceHistory) ? s.balanceHistory : [];
        function fmtPH(ts){ try{ return new Date(ts).toLocaleString('en-PH',{timeZone:'Asia/Manila', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true})+' PH'; }catch(e){ return new Date(ts).toLocaleString(); } }
        var histHtml = '';
        if (balHist.length===0) histHtml = '<div style="font-size:9px;color:var(--muted)">-</div>';
        else {
          for(var k=balHist.length-1;k>=0;k--){
            var h=balHist[k];
            var hv = (h.value!=null?Number(h.value).toFixed(2):'-');
            var ht = h.time?fmtPH(h.time):'';
            histHtml += '<div class="bhist-row"><span class="bhist-val">&#8369;'+hv+'</span><span class="bhist-time">'+esc(ht)+'</span></div>';
          }
        }
        var cyclesNeeded = ptsUntilMid>0? (ptsUntilMid/250).toFixed(1) : '0';
        var leftCol = '<div class="bcol"><div class="bcol-hd">Balance History (10)</div><div class="bhist-list">'+histHtml+'</div></div>';
        var rightCol = '<div class="bcol"><div class="bcol-hd">Calculation (250=3&#8369;)</div>'
          +'<div class="bcalc-line">&#8369;'+targetPesos+': <span class="bcalc-em">&#8369;'+Number(pesosNeeded).toFixed(2)+' needed</span></div>'
          +'<div class="bcalc-line">Points: <span class="bcalc-em" style="color:#38bdf8">'+ptsUntilMid+' pts</span> <span style="color:var(--muted)">('+cyclesNeeded+' cycles)</span></div>'
          +'<div class="bcalc-line">Getting: <span class="bcalc-em" style="color:#facc15">'+ptsPerMin+' pts/min</span> <span style="color:var(--muted)">('+ptsPerHour+'/hr)</span></div>'
          +'<div class="bcalc-line" style="color:var(--muted)">ETA: <span class="bcalc-em" style="color:#facc15">'+esc(etaText)+'</span></div>'
          +'</div>';
        var grid = '<div class="b2col">'+leftCol+rightCol+'</div>';
        return grid;
      })() +
      '<form class="crow" method="GET" action="/save-creds"><input type="hidden" name="slot" value="'+esc(s.id)+'">'+
      '<input type="text" name="user" placeholder="Username" value="'+esc(s.user)+'" list="hu">'+
      '<input type="text" name="pass" placeholder="Password" value="'+esc(s.pass)+'">'+
      '<button type="submit" class="bsm bsv">Save</button></form>'+
      eh+
      '<div class="sacts">'+
        '<a class="ibtn" href="/cmd?action=pause&slot='+sid+'" title="Pause">&#9646;&#9646;</a>'+
        '<a class="ibtn" href="/cmd?action=resume&slot='+sid+'" title="Resume">&#9654;</a>'+
        '<a class="ibtn" href="/cmd?action=restart&slot='+sid+'" title="Restart">&#8635;</a>'+
        '<a class="ibtn" href="/cmd?action=refresh&slot='+sid+'" title="Refresh">&#8634;</a>'+
        '<a class="ibtn dng" href="/cmd?action=remove&slot='+sid+'" title="Remove">&#10005;</a>'+
      '</div></div>';
    if (isDanica) hDanica+=cardHtml; else hAiko+=cardHtml;
  }
  document.getElementById('slots-aiko').innerHTML=hAiko || '<div style="text-align:center;color:var(--muted);padding:20px;font-size:12px;">No AIKO slots</div>';
  document.getElementById('slots-danica').innerHTML=hDanica || '<div style="text-align:center;color:var(--muted);padding:20px;font-size:12px;">No DANICA slots</div>';
  window._lastSlots = slots; // for live timer 1:1 - sync live only, no stale lastUpdate
}

function openModal(id){ var m=document.getElementById('modal-'+id); if(m) m.classList.add('show'); }
function closeModal(id){ var m=document.getElementById('modal-'+id); if(m) m.classList.remove('show'); }
function poll(){
  fetch('/api/stats?t='+Date.now(),{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){
    try{ render(d); }catch(e){ console.error('render error',e); }
    LD=JSON.stringify(d);
  }).catch(function(e){
    console.error('poll error',e);
    var el=document.getElementById('ltxt');
    if(el) el.textContent='Connection error — '+new Date().toLocaleTimeString();
  });
  setTimeout(poll,POLL);
}
// Live clock ticks every second even if fetch stalls — proves JS is running
// Per-slot timers 1:1 copy of overlay - increment live every second from last render value
setInterval(function(){
  // 1:1 live - recalculate from loopStartTime via last render data
  // We store last slots data in window._lastSlots
  if(window._lastSlots){
    for(var i=0;i<window._lastSlots.length;i++){
      var s=window._lastSlots[i];
      var el=document.getElementById('timer-'+s.id);
      if(el && s.loopStartTime){
        var elapsed=Math.floor((Date.now()-s.loopStartTime)/1000);
        if(elapsed<0) elapsed=0;
        if(elapsed>86400) elapsed=0;
        var m=Math.floor(elapsed/60), sec=elapsed%60;
        el.textContent=(m<10?'0'+m:m)+':'+(sec<10?'0'+sec:sec);
      }
    }
  }
},1000);
// Global live clock
setInterval(function(){
  var el=document.getElementById('ltxt');
  var now=new Date();
  if(el) {
    var txt=el.textContent||'';
    // Only overwrite if it starts with Live or Connection
    if(txt.indexOf('Live')===0 || txt.indexOf('Connection')===0) {
      // Keep Live prefix but update time
      var base=txt.split('—')[0]||'Live ';
      el.textContent=base+'— '+now.toLocaleTimeString()+' ('+now.toLocaleDateString()+')';
    }
  }
},1000);
poll();
console.log('VisionTap dashboard live poll started v'+Date.now());
</script>
</body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/debug-images" && req.method === "GET") {
    const debugDir = path.join(__dirname, "..", "debug_images");
    if (!fs.existsSync(debugDir)) { res.writeHead(404); res.end("No debug_images folder"); return; }
    const files = fs.readdirSync(debugDir).filter(f => f.endsWith(".png")).sort();
    res.setHeader("Content-Type", "text/html");
    let html = `<html><body style="background:#0a0e1a;color:#e2e8f0;padding:20px;font-family:system-ui"><h2>Debug Images (${files.length})</h2>`;
    for (const f of files) {
      html += `<div style="display:inline-block;text-align:center;margin:8px"><a href="/debug-images/${f}"><img src="/debug-images/${f}" style="max-width:200px;border:1px solid #334155;border-radius:6px"></a><br><small>${f}</small></div>`;
    }
    html += `</body></html>`;
    res.end(html);
    return;
  }

  if (url.pathname.startsWith("/debug-images/") && req.method === "GET") {
    const fileName = path.basename(url.pathname);
    const filePath = path.join(__dirname, "..", "debug_images", fileName);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end("Not found"); return; }
    res.setHeader("Content-Type", "image/png");
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (url.pathname === "/api/stats" && req.method === "GET") {
    const status = getStatus();
    const slots = getMergedSlots(status);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ scannerUp: status.scannerUp, electronProcs: status.electronProcs, loopPaused: status.loopPaused, slots }));
    return;
  }

  if (url.pathname === "/cmd") {
    const action = url.searchParams.get("action");
    const slot = url.searchParams.get("slot");
    log(`CMD: action=${action} slot=${slot}`);
    sendCommands([{ action, slot: slot || "all" }]);
    res.writeHead(302, { "Location": "/" });
    res.end();
    return;
  }

  if (url.pathname === "/loop") {
    const cmd = url.searchParams.get("cmd");
    if (cmd === "pause" || cmd === "resume") {
      writeJson(LOOP_CMD_FILE, { action: cmd });
      log(`Loop ${cmd}`);
    }
    res.writeHead(302, { "Location": "/" });
    res.end();
    return;
  }

  if (url.pathname === "/save-creds") {
    const slot = url.searchParams.get("slot");
    let user = url.searchParams.get("user") || "";
    let pass = url.searchParams.get("pass") || "";
    // ENFORCE: lock slots 11->adaihbi, 12->temi, 13->danicajgb (persistent)
    try {
      if (String(slot)==="11") { user="adaihbi"; pass="Iloveyou143!"; log(`SAVE-CREDS LOCKED Slot 11 -> adaihbi`); }
      if (String(slot)==="12") { user="temi"; pass="Iloveyou143!"; log(`SAVE-CREDS LOCKED Slot 12 -> temi`); }
      if (String(slot)==="13") { user="danicajgb"; pass="Danik032204"; log(`SAVE-CREDS LOCKED Slot 13 -> danicajgb`); }
    } catch(e) {}
    log(`SAVE-CREDS: slot=${slot} user=${user}`);
    if (slot != null) {
      const creds = getCreds();
      if (user || pass) {
        creds[slot] = { user, pass };
      } else {
        delete creds[slot];
      }
      writeJson(CREDS_FILE, creds);
      const history = getHistory();
      if (user && !history.users.includes(user)) {
        history.users.push(user);
        if (history.users.length > 50) history.users.shift();
        writeJson(HISTORY_FILE, history);
      }
    }
    res.writeHead(302, { "Location": "/" });
    res.end();
    return;
  }

  if (url.pathname === "/restart") {
    log("Restarting VisionTap...");
    run("sudo systemctl restart visiontap-electron");
    res.setHeader("Content-Type", "text/html");
    res.setHeader("Refresh", "3; url=/");
    res.end("<html><body style='background:#0a0e1a;color:#e2e8f0;font-family:system-ui;text-align:center;padding:40px'><h2>Restarting VisionTap...</h2><p>Page will reload in 3 seconds</p></body></html>");
    return;
  }

  // Dashboard GET
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.end(buildPage());
});

server.listen(PORT, "0.0.0.0", () => {
  log(`Dashboard running on http://0.0.0.0:${PORT}`);
});
