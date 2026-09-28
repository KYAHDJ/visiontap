const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const { enqueue } = require('./command-queue');
const PORT = 8080;
const PH_TIME_ZONE = "Asia/Manila";
const ELECTRON_STATE_DIR = path.join(os.homedir(), ".config", "VisionTap Slots", "state");
const CREDS_FILE = path.join(ELECTRON_STATE_DIR, "credentials.json");
const HISTORY_FILE = path.join(ELECTRON_STATE_DIR, "cred_history.json");
const LOOP_CMD_FILE = path.join(ELECTRON_STATE_DIR, "loop_command.json");
const SLOTS_FILE = path.join(ELECTRON_STATE_DIR, "slots.json");
const SLOT_CMD_FILE = path.join(ELECTRON_STATE_DIR, "slot_commands.json");
const ENCASHMENT_STATE_FILE = path.join(ELECTRON_STATE_DIR, "encashment_adaihbi.json");
const ENCASHMENT_CONFIG_FILE = path.join(ELECTRON_STATE_DIR, "encashment_config.json");
const THEME_PREF_FILE = path.join(ELECTRON_STATE_DIR, "dashboard_theme.json");

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// Dashboard persistent metrics — per-slot personal save file (no leaking)
const METRICS_FILE = path.join(ELECTRON_STATE_DIR, "dashboard_metrics.json"); // legacy single file (migrated)
function metricsFileForId(id) { return path.join(ELECTRON_STATE_DIR, `dashboard_metrics_${String(id)}.json`); }
function loadMetricsForId(id) {
  // try per-slot file first
  let ms = readJson(metricsFileForId(id), null);
  if (ms) return ms;
  // migrate from legacy single file if exists
  const legacy = readJson(METRICS_FILE, null);
  if (legacy && legacy[String(id)]) {
    const m = legacy[String(id)];
    try { writeJson(metricsFileForId(id), m); } catch(e){}
    return m;
  }
  return null;
}
function saveMetricsForId(id, ms) { writeJson(metricsFileForId(id), ms); }
function getSlotMetrics(id) {
  let ms = loadMetricsForId(id);
  if (!ms) {
    ms = {
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
    if (ms.prevCorrect != null && ms.prevPoints == null) {
      ms.prevPoints = null;
      delete ms.prevCorrect;
      delete ms.correctAtStart;
    }
    if (ms.pointsAtStart == null) ms.pointsAtStart = 0;
    if (ms.prevPoints === undefined) ms.prevPoints = null;
    if (!Array.isArray(ms.balanceHistory)) ms.balanceHistory = [];
    if (ms.lastHistoryCheck == null) ms.lastHistoryCheck = 0;
    if (ms.targetPoints && !ms.targetPesos) {
      // will be migrated in getMergedSlots
    }
  }
  return ms;
}
function pointsDelta(cur, start, isPmath) {
  cur = Number(cur) || 0;
  start = Number(start) || 0;
  if (cur >= start) return cur - start;
  // wrap: 0-250 for ecnl, 0-100 for pmath
  const max = isPmath ? 100 : 250;
  return (max - start) + cur;
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
  const active = getElectronSlots().active || [];
  return active.length > 0 && active.every(s => s.paused || s.stopRequested);
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
    // Strict per-slot personal — no fallback to other slots (prevents history leaking)
    let sc = scannerSlots[id] || scannerSlots[String(id)] || null;
    if (!sc || Object.keys(sc).length === 0) sc = {};
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

    // --- Persistent per-slot metrics — personal file per slot (no leaking) ---
    let ms = getSlotMetrics(String(id));
    const nowMs = Date.now();
    const currentWithdrawable = sc.withdrawable != null ? Number(sc.withdrawable) : 0;
    const isPmath = String(id) === "14" || String(name).toLowerCase() === "kyaiko";
    // ECNL tracks cycle points; Kyaiko tracks its live cumulative coin balance.
    const curPoints = isPmath ? currentWithdrawable : pointsDone;
    let dirty = false;

    // Migrate Kyaiko from the old points-based rate source without creating a false spike.
    if (isPmath && ms.rateUnit !== "coins") {
      ms.rateUnit = "coins";
      ms.windowStart = 0;
      ms.prevPoints = curPoints;
      ms.pointsAtStart = curPoints;
      ms.ppm = 0;
      ms.pph = 0;
      dirty = true;
    }

    // Init prevPoints on first sight (avoid inflated delta)
    if (ms.prevPoints === null) {
      ms.prevPoints = curPoints;
      ms.pointsAtStart = curPoints;
      dirty = true;
    }

    // Balance history — 2-min timer, 10 visible entries, persisted per-slot
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

    // Target logic: ecnl 250 pts = 3 pesos (83.33), pmath 100 coins = 1 peso → 100 pesos = 10000 coins, 300 pesos = 30000 coins
    let targetPesos, pesosNeeded, pointsUntilMid, pointsUntilLow, pointsUntilHigh, currentTargetPoints, pointsUntilTarget;
    if (isPmath) {
      // pmath: coins instantly from web (withdrawable = coins), 100 coins =1 peso → 300₱ =30,000 coins
      // For instant center display, use currentWithdrawable as coins (same as pointsDone for pmath)
      if (currentWithdrawable > 0) pointsDone = currentWithdrawable;
      const tp = 300;
      // Fixed goal: 100 coins = ₱1, so ₱300 = 30,000 coins.
      ms.targetPesos = tp;
      if (ms.targetPoints) { delete ms.targetPoints; dirty = true; }
      targetPesos = tp;
      const targetCoinsFinal = 30000;
      pesosNeeded = Math.max(0, (targetCoinsFinal - currentWithdrawable)/100);
      pointsUntilMid = Math.max(0, Math.trunc(targetCoinsFinal - currentWithdrawable));
      pointsUntilLow = pointsUntilMid;
      pointsUntilHigh = pointsUntilMid;
      currentTargetPoints = targetCoinsFinal;
      pointsUntilTarget = pointsUntilMid;
    } else {
      const POINTS_PER_CYCLE = 250;
      const PESOS_PER_CYCLE = 3;
      const POINTS_PER_PESO = POINTS_PER_CYCLE / PESOS_PER_CYCLE;
      let tp = ms.targetPesos || (ms.targetPoints ? Math.trunc(ms.targetPoints/4) : 300);
      if (!tp || tp < 300) tp = 300;
      if (ms.targetPoints && !ms.targetPesos) {
        tp = Math.trunc(ms.targetPoints/4);
        if (tp < 300) tp = 300;
      }
      while (currentWithdrawable >= tp) {
        tp += 100;
        dirty = true;
      }
      ms.targetPesos = tp;
      if (ms.targetPoints) { delete ms.targetPoints; dirty = true; }
      targetPesos = tp;
      pesosNeeded = Math.max(0, tp - currentWithdrawable);
      pointsUntilMid = Math.max(0, Math.trunc(pesosNeeded * POINTS_PER_PESO));
      pointsUntilLow = pointsUntilMid;
      pointsUntilHigh = pointsUntilMid;
      currentTargetPoints = Math.trunc(tp * POINTS_PER_PESO);
      pointsUntilTarget = pointsUntilMid;
    }

    // Per-minute: continuous 60s window, truncated whole number, live without reset to 1
    // Window starts on first increment, every 60s compute ppm and immediately start next window

    // Detect increment vs prevPoints (handle 0-250 wrap)
    let hasIncrement = false;
    if (ms.prevPoints !== null && ms.prevPoints !== curPoints) hasIncrement = true;

    // Cleanup old cooldown field (no longer used)
    if (ms.cooldownStart) { ms.cooldownStart = 0; dirty = true; }

    if (ms.windowStart === 0) {
      if (hasIncrement && ms.prevPoints !== null) {
        ms.windowStart = nowMs;
        ms.pointsAtStart = ms.prevPoints;
        dirty = true;
      }
      if (ms.prevPoints !== curPoints && ms.windowStart === 0) {
        ms.prevPoints = curPoints;
        dirty = true;
      }
    } else {
      const elapsed = nowMs - ms.windowStart;
      if (elapsed >= 60000) {
        const count = pointsDelta(curPoints, ms.pointsAtStart, isPmath);
        const ppm = isPmath
          ? Math.round(Math.max(0, count * 60000 / elapsed) * 100) / 100
          : Math.trunc(Math.max(0, count));
        const pph = Math.round(ppm * 60 * 100) / 100;
        ms.ppm = ppm;
        ms.pph = pph;
        ms.lastComputedAt = nowMs;
        // continuous: start next window immediately (no 1-min break)
        ms.windowStart = nowMs;
        ms.pointsAtStart = curPoints;
        ms.prevPoints = curPoints;
        dirty = true;
      } else {
        ms.prevPoints = curPoints;
        dirty = true;
      }
    }

    // Derive live ppm/pph: show last completed ppm live, no reset to 1
    // Only show running count if we have never completed a window (ppm==0)
    let displayPpm = ms.ppm || 0;
    let displayPph = ms.pph || 0;
    if (ms.windowStart > 0 && ms.ppm === 0) {
      const running = Math.max(0, pointsDelta(curPoints, ms.pointsAtStart, isPmath));
      if (isPmath) {
        const runningMs = Math.max(1000, nowMs - ms.windowStart);
        displayPpm = Math.round(running * 60000 / runningMs * 100) / 100;
        displayPph = Math.round(displayPpm * 60 * 100) / 100;
      } else {
        displayPpm = Math.trunc(running);
        displayPph = displayPpm * 60;
      }
    }

    if (!isPmath) { displayPpm = Math.min(9, Math.max(0, Math.trunc(displayPpm))); displayPph = displayPpm * 60; }

    // ETA — live adjusting based on displayPph, + days (hours/24)
    let etaHours = 0;
    let etaText = "";
    let etaDays = 0;
    if (displayPph > 0 && pointsUntilTarget > 0) {
      etaHours = pointsUntilTarget / displayPph;
      etaDays = etaHours / 24;
      let baseText;
      if (etaHours < 1) {
        const mins = Math.trunc(etaHours * 60);
        baseText = mins <= 1 ? "1 min" : mins + " mins";
      } else {
        const h = Math.trunc(etaHours);
        const mins = Math.trunc((etaHours - h) * 60);
        if (mins === 0) baseText = h + (h === 1 ? " hour" : " hours");
        else baseText = h + "h " + mins + "m";
      }
      const daysText = etaDays < 1 ? etaDays.toFixed(2) : etaDays < 10 ? etaDays.toFixed(1) : Math.trunc(etaDays).toString();
      etaText = baseText + " (" + daysText + " days)";
    } else if (pointsUntilTarget === 0) {
      etaText = "reached";
    } else {
      etaText = "-";
    }

    if (dirty) saveMetricsForId(String(id), ms);

    const mergedSlot = {
      id, name, accountName: slot.accountName || "",
      paused: !!(slot.paused || slot.stopRequested),
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
      etaDays: Math.round(etaDays*100)/100,
      etaText: etaText,
      lastBalanceUpdate: ms.lastBalanceTime || 0,
      lastBalanceValue: ms.lastBalanceValue != null ? ms.lastBalanceValue : 0,
      balanceHistory: Array.isArray(ms.balanceHistory) ? ms.balanceHistory.slice(-10) : [],
      _windowActive: ms.windowStart > 0,
      _cooldownActive: ms.cooldownStart > 0,
      encashment: String(slot.accountName || name).toLowerCase() === 'adaihbi' ? readJson(ENCASHMENT_STATE_FILE, null) : null,
      encashmentSchedule: String(slot.accountName || name).toLowerCase() === 'adaihbi' ? (()=>{const c=readJson(ENCASHMENT_CONFIG_FILE,{});return {type:c.type||'',weekday:c.weekday||'',startHour:c.startHour==null?null:Number(c.startHour),endHour:c.endHour==null?null:Number(c.endHour),retryMinutes:5};})() : null
    };
    merged.push(mergedSlot);
  }
  return merged;
}
function sendCommands(cmds) {
  enqueue(path.join(ELECTRON_STATE_DIR, 'commands'), cmds);
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
.ph-clock{margin:-4px auto 12px;padding:10px 14px;max-width:330px;text-align:center;background:linear-gradient(135deg,rgba(56,189,248,.12),rgba(167,139,250,.08));border:1px solid rgba(56,189,248,.35);border-radius:10px}
.ph-clock-time{font-size:22px;line-height:1.15;font-weight:700;color:#f8fafc;font-variant-numeric:tabular-nums;letter-spacing:.4px}
.ph-clock-date{margin-top:3px;color:var(--muted);font-size:10px}
.ph-clock-label{margin-top:2px;color:var(--accent);font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.8px}
.pills{display:flex;gap:6px;margin-bottom:12px;justify-content:center;flex-wrap:wrap}
.pill{display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:16px;font-size:10px;font-weight:500;background:var(--card);border:1px solid var(--border);white-space:nowrap}
.dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.stitle{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin:14px 0 6px}
.section-aiko-title{color:#38bdf8; border-left:3px solid #38bdf8; padding-left:8px; background:rgba(56,189,248,0.08); border-radius:4px; padding:4px 8px;}
.section-danica-title{color:#f472b6; border-left:3px solid #f472b6; padding-left:8px; background:rgba(244,114,182,0.08); border-radius:4px; padding:4px 8px;}
.section-darlene-title{color:#34d399; border-left:3px solid #34d399; padding-left:8px; background:rgba(52,211,153,0.08); border-radius:4px; padding:4px 8px;}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:8px}
.card-aiko{background:linear-gradient(135deg, rgba(30,41,59,0.9), rgba(15,30,60,0.9)); border-color:rgba(56,189,248,0.25);}
.card-danica{background:linear-gradient(135deg, rgba(40,20,35,0.9), rgba(60,20,40,0.9)); border-color:rgba(244,114,182,0.35);}
.card-darlene{background:linear-gradient(135deg, rgba(20,40,30,0.9), rgba(20,60,40,0.9)); border-color:rgba(52,211,153,0.35);}
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
.encbtn{background:#075985;color:#bae6fd;width:auto;padding:0 11px;font-size:10px;font-weight:700}.encoutstatus{display:inline-flex;align-items:center;min-height:30px;padding:0 10px;margin-right:auto;border-radius:8px;border:1px solid #334155;background:#111827;color:#94a3b8;font-size:9px;font-weight:650;white-space:nowrap}.encoutstatus.yes{background:#052e22;border-color:#047857;color:#6ee7b7}.encoutstatus.waiting{background:#422006;border-color:#a16207;color:#fde68a}.encoutstatus.no{background:#450a0a;border-color:#b91c1c;color:#fca5a5}.encoutstatus.answer{background:#0c4a6e;border-color:#0369a1;color:#bae6fd}
.encmodal{display:none;position:fixed;inset:0;background:rgba(2,6,23,.9);z-index:50;padding:20px;overflow:auto}
.encmodal.show{display:flex;align-items:flex-start;justify-content:center}.encpanel{width:100%;max-width:620px;background:#0b1220;border:1px solid #263449;border-radius:18px;padding:18px;box-shadow:0 28px 80px #000b}
.enchd{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.enctitle{color:#f8fafc;font-size:15px;font-weight:750}.encclose{background:#172033;color:#94a3b8;border:1px solid #263449;border-radius:9px;padding:7px 11px;cursor:pointer}
.enchero{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;background:linear-gradient(135deg,#0c4a6e,#082f49);border:1px solid #0369a1;border-radius:14px;padding:15px;margin-bottom:10px}.enchero small{display:block;color:#7dd3fc;font-size:9px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px}.enchero strong{display:block;color:#fff;font-size:25px;line-height:1}.encstatus{display:inline-block;border-radius:999px;padding:5px 9px;font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.5px}.encstatus.yes{background:#064e3b;color:#a7f3d0}.encstatus.waiting{background:#713f12;color:#fde68a}.encstatus.no{background:#450a0a;color:#fecaca}.encstatus.answer{background:#0c4a6e;color:#bae6fd}
.encsummary{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:10px}.encsum{background:#111a2c;border:1px solid #223049;border-radius:10px;padding:10px}.encsum b,.encdetail b{display:block;color:#64748b;font-size:8px;text-transform:uppercase;letter-spacing:.45px;margin-bottom:4px}.encsum span{color:#e2e8f0;font-size:11px;font-weight:700}.encsum.net span{color:#34d399}
.encdetails{display:grid;grid-template-columns:1fr 1fr;background:#0f172a;border:1px solid #1e293b;border-radius:12px;margin-bottom:10px;overflow:hidden}.encdetail{padding:10px 12px;border-bottom:1px solid #1e293b;min-width:0;word-break:break-word;font-size:10px}.encdetail:nth-child(odd){border-right:1px solid #1e293b}.encdetail:nth-last-child(-n+2){border-bottom:0}
.encreceived{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}.encreceived button{padding:11px;border-radius:10px;border:1px solid #334155;background:#131d30;color:#94a3b8;font-size:10px;font-weight:700;cursor:pointer}.encreceived button.yes.active{background:#064e3b;border-color:#10b981;color:#a7f3d0}.encreceived button.waiting.active{background:#713f12;border-color:#f59e0b;color:#fde68a}.encreceived button.no.active{background:#450a0a;border-color:#ef4444;color:#fecaca}
.encschedule{display:flex;justify-content:space-between;gap:10px;background:#101827;border:1px solid #1e293b;border-radius:10px;padding:9px 11px;color:#94a3b8;font-size:9px}.encschedule b{color:#cbd5e1}.encactivity{margin-top:10px;color:#64748b;font-size:9px}.encactivity div{padding:5px 0;border-bottom:1px solid #172033}.encactivity div:last-child{border:0}
@media(max-width:600px){.encmodal{padding:8px}.encpanel{padding:13px;border-radius:13px}.encsummary{grid-template-columns:repeat(3,1fr)}.enchero strong{font-size:21px}.encdetails{grid-template-columns:1fr}.encdetail:nth-child(odd){border-right:0}.encdetail:nth-last-child(2){border-bottom:1px solid #1e293b}}
@media(max-width:380px){.wrap{padding:8px 8px 60px}.crow{flex-direction:column}.crow input{width:100%}.bsm{width:100%}}
.b2col{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0 8px}
.bcol{background:#0f172a;border:1px solid #1e293b;border-radius:6px;padding:6px;cursor:pointer;min-height:88px;display:flex;flex-direction:column}
.bcol:hover{border-color:#334155}
.bcol-hd{font-weight:600;color:var(--text);font-size:9px;margin-bottom:4px;letter-spacing:0.3px}
.bhist-list{overflow:visible;flex:1;padding-right:4px}
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
/* Figma-inspired production theme */
:root{--bg:#f2f2ff;--card:#fff;--border:#e4e2f2;--text:#050020;--muted:#77768f;--accent:#2d1cf5;--green:#18a875;--red:#d94a67;--yellow:#fa914b;--purple:#c2bffa;--midnight:#050020;--coral:#f47a91;--shadow:0 10px 28px rgba(25,17,77,.06)}
body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text)}
.appbar{height:64px;background:rgba(255,255,255,.88);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 max(22px,calc((100vw - 1320px)/2));position:sticky;top:0;z-index:20;backdrop-filter:blur(14px)}
.brand{display:flex;align-items:center;gap:11px}.brandmark{width:31px;height:31px;display:grid;grid-template-columns:1fr 1fr;gap:3px;transform:rotate(-10deg)}.brandmark i{display:block;border-radius:4px;background:var(--accent)}.brandmark i:nth-child(2){background:var(--coral)}.brandmark i:nth-child(3){background:var(--yellow)}.brandmark i:nth-child(4){background:var(--purple)}.brandcopy strong{display:block;font-size:17px;letter-spacing:-.04em}.brandcopy span{display:block;font-size:7px;letter-spacing:.18em;color:var(--muted);font-weight:800;margin-top:1px}.appstate{display:flex;align-items:center;gap:8px;font-size:10px;font-weight:700;color:#4b4a68}.appstate .livedot{margin:0}
.wrap{max-width:1320px;margin:0 auto;padding:34px 24px 64px}
.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:24px}.hero-copy h1{text-align:left;font-size:34px;line-height:1;color:var(--midnight);letter-spacing:-.055em;margin:7px 0 8px}.hero-copy h1 em{font-style:normal;color:var(--accent)}.hero-copy p{font-size:12px;color:var(--muted)}.eyebrow{font-size:9px;letter-spacing:.16em;color:var(--accent);font-weight:850;text-transform:uppercase}
.ph-clock{margin:0;padding:11px 14px;min-width:285px;max-width:none;text-align:left;background:#fff;border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);display:grid;grid-template-columns:1fr auto;column-gap:16px}.ph-clock-time{font-size:16px;color:var(--midnight);grid-column:1}.ph-clock-date{font-size:9px;grid-column:1;margin-top:2px}.ph-clock-label{grid-column:2;grid-row:1/3;align-self:center;background:#eceaff;color:var(--accent);border-radius:6px;padding:5px 7px;font-size:8px}
.overview{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px}.ov{min-height:110px;background:#fff;border:1px solid var(--border);border-radius:17px;padding:16px;box-shadow:var(--shadow);display:flex;flex-direction:column}.ov.primary{background:var(--accent);border-color:var(--accent);color:#fff}.ov small{font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.06em}.ov.primary small{color:#dcd8ff}.ov strong{font-size:26px;letter-spacing:-.05em;margin-top:auto}.ov span{font-size:9px;color:var(--muted);margin-top:3px}.ov.primary span{color:#d7d3ff}.ov.next strong{font-size:18px}.ovicon{width:29px;height:29px;border-radius:9px;background:#eceaff;color:var(--accent);display:grid;place-items:center;font-size:14px;margin-bottom:12px}.primary .ovicon{background:rgba(255,255,255,.16);color:#fff}.ov.health .ovicon{background:#e7f7ef;color:var(--green)}.ov.next .ovicon{background:#fff0e5;color:#d96f2e}
.pills{justify-content:flex-start;margin:0 0 12px}.pill{background:#fff;border-color:var(--border);box-shadow:0 3px 10px rgba(25,17,77,.03);color:#4b4a68;padding:6px 10px;border-radius:8px}
.stitle{font-size:11px;color:var(--midnight);margin:30px 0 11px;letter-spacing:.08em}.section-aiko-title,.section-danica-title,.section-darlene-title{color:var(--midnight);background:transparent;border:0;border-bottom:1px solid #dcdaeb;border-radius:0;padding:0 0 10px}.section-aiko-title:before,.section-danica-title:before,.section-darlene-title:before{content:'';display:inline-block;width:3px;height:14px;border-radius:4px;background:var(--accent);margin-right:8px;vertical-align:-2px}.section-danica-title:before{background:var(--coral)}.section-darlene-title:before{background:var(--green)}
#slots-aiko,#slots-danica,#slots-darlene{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.card,.card-aiko,.card-danica,.card-darlene{background:#fff;border:1px solid #e8e6f3;border-radius:18px;padding:18px;margin:0;box-shadow:var(--shadow);transition:transform .2s,box-shadow .2s,border-color .2s}.card:hover{transform:translateY(-2px);border-color:#d5d1f4;box-shadow:0 16px 34px rgba(25,17,77,.09)}
.card-hd{margin-bottom:15px}.card-nm{font-size:15px;letter-spacing:-.02em}.card-bg{font-size:8px;border-radius:7px;padding:5px 8px;text-transform:capitalize}.card-bg.state-running{background:#e8f7ef;color:#168763}.card-bg.state-paused{background:#fff0e5;color:#b85a1c}
.sgrid{gap:0;margin-bottom:14px;padding:13px 0;border-top:1px solid #efedf7;border-bottom:1px solid #efedf7}.sbox{background:transparent;border-radius:0;padding:4px 12px;border-left:1px solid #eceaf5}.sbox:first-child{border-left:0}.sv{font-size:19px;color:var(--midnight)!important;letter-spacing:-.035em}.sbox:first-child .sv{color:var(--accent)!important}.sl{font-size:9px;color:#9290a8;margin-top:4px}
.pbar{background:#e9e6fc;height:7px;margin-bottom:14px}.pfill{background:linear-gradient(90deg,#5547ff,var(--accent))}
.b2col{gap:9px;margin:8px 0 13px}.bcol{background:#f8f7ff;border:1px solid #eceafb;border-radius:12px;padding:12px;min-height:112px}.bcol:hover{border-color:#d8d4f7}.bcol-hd{font-size:10px;color:var(--midnight);margin-bottom:8px}.bhist-row{border-bottom-color:#eceaf5;padding:3px 0}.bhist-val{color:var(--accent)}.bhist-time,.bcalc-line{color:#85839d}.bcalc-em{color:var(--midnight)}
.crow{gap:7px;margin:4px 0 9px}.crow input{padding:8px 10px;background:#fafaff;border:1px solid #e4e2f0;color:var(--midnight);border-radius:8px;font-size:11px}.crow input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(45,28,245,.1)}.bsm{border-radius:8px;padding:7px 13px}.bsv{background:#eeeaff;color:var(--accent)}
.ehd{color:#85839d}.erow{border-bottom-color:#f0eff7}.eamt{color:var(--green)}
.sacts{border-top:1px solid #efedf7;padding-top:12px;margin-top:12px;align-items:center}.ibtn{background:#f5f4fb;color:#77758e;border-radius:8px}.ibtn:hover{background:#ebe8ff;color:var(--accent)}.ibtn.dng:hover{background:#fff0f3;color:#bc3d5e}
.encbtn{background:var(--midnight);color:#fff;height:32px}.encbtn:hover{background:var(--accent);color:#fff}.encoutstatus{background:#eceaff;border-color:#ded9ff;color:#4d42aa}
.ggrid{display:flex;gap:8px;flex-wrap:wrap;background:#fff;border:1px solid var(--border);border-radius:15px;padding:11px;box-shadow:var(--shadow);margin-bottom:10px}.btn{width:auto;min-width:120px;padding:10px 14px;border-radius:9px;font-size:10px}.bgrn{background:var(--accent);color:#fff}.bred{background:#fff0f3;color:#b63b5a}.byel{background:#fff0e5;color:#b85a1c}.bpur{background:#eeeaff;color:var(--accent)}.bful{flex:1}.ftr{color:#77768f}
.encmodal{background:rgba(5,0,32,.62);align-items:center}.encpanel{max-width:560px;background:#fff;border:0;border-radius:20px;padding:0;overflow:hidden;box-shadow:0 35px 90px rgba(5,0,32,.35)}.enchd{padding:18px 22px;margin:0;border-bottom:1px solid var(--border)}.enctitle{color:var(--midnight);font-size:18px}.encclose{background:#f3f2fa;color:#6d6a87;border:0}.encbody{padding:18px}.enchero{margin:18px 18px 10px;background:var(--midnight);border:0;border-radius:14px;padding:18px}.enchero small{color:#b1aacb}.encstatus.answer{background:#eceaff;color:#4d42aa}.encsummary,.encdetails,.encreceived,.encschedule,.encactivity{margin-left:18px;margin-right:18px}.encsum{background:#f6f5fc;border-color:#efedf7}.encsum b,.encdetail b{color:#85839d}.encsum span{color:var(--midnight)}.encdetails{background:#fff;border-color:var(--border)}.encdetail{border-color:var(--border);color:var(--midnight)}.encreceived button{background:#f6f5fa;border-color:#e6e4f0;color:#625f78}.encschedule{background:#f7f6fc;border-color:#efedf7;color:#67647f;margin-bottom:18px}.encschedule b{color:var(--midnight)}.encactivity{color:#85839d;margin-bottom:18px}.encactivity div{border-color:#efedf7}
@media(max-width:980px){.overview{grid-template-columns:repeat(2,1fr)}#slots-aiko,#slots-danica,#slots-darlene{grid-template-columns:1fr}}
@media(max-width:620px){.appbar{height:56px;padding:0 14px}.wrap{padding:24px 12px 52px}.hero{align-items:stretch;flex-direction:column}.hero-copy h1{font-size:29px}.ph-clock{width:100%;min-width:0}.overview{gap:8px}.ov{min-height:96px;padding:12px}.ov strong{font-size:22px}.ggrid{display:grid;grid-template-columns:1fr 1fr}.btn{min-width:0;width:100%}.bful{grid-column:1/-1}.card{padding:14px}.b2col{grid-template-columns:1fr}.encoutstatus{overflow:hidden;text-overflow:ellipsis}.encmodal{padding:8px}.encsummary{grid-template-columns:repeat(3,1fr)}}
/* High-contrast dark preview */
:root{--bg:#080817;--card:#111126;--border:#292844;--text:#f7f5ff;--muted:#aaa7c3;--accent:#6857ff;--green:#39d49a;--red:#ff6f8c;--yellow:#ff9b55;--purple:#c7c1ff;--midnight:#05000f;--coral:#ff7892;--shadow:0 14px 34px rgba(0,0,0,.28)}
body{background:radial-gradient(circle at 78% 0,rgba(72,49,255,.12),transparent 34%),var(--bg);color:var(--text)}
.appbar{background:rgba(12,12,29,.9);border-color:#26253f}.brandcopy strong{color:#fff}.brandcopy span,.appstate{color:#bbb7d1}
.hero-copy h1{color:#fff}.hero-copy p{color:#b7b3ca}.eyebrow{color:#9b90ff}
.ph-clock,.ov,.ggrid,.card,.card-aiko,.card-danica,.card-darlene{background:#111126;border-color:#292844;box-shadow:var(--shadow)}
.ph-clock-time{color:#fff}.ph-clock-date{color:#aaa7c3}.ph-clock-label{background:#282250;color:#c7c1ff}
.ov small,.ov span{color:#aaa7c3}.ov.primary{background:linear-gradient(145deg,#4634f5,#2d1cf5);border-color:#6253ff}.ovicon{background:#282250;color:#bdb6ff}.ov.health .ovicon{background:#123c31;color:#55e5af}.ov.next .ovicon{background:#492818;color:#ffad72}
.pill{background:#14142b;border-color:#302f4b;color:#d1cee0}
.stitle,.section-aiko-title,.section-danica-title,.section-darlene-title{color:#f5f3ff;border-color:#302f49}
.card:hover{border-color:#51497d;box-shadow:0 18px 40px rgba(0,0,0,.38)}.card-nm{color:#fff}
.card-bg.state-running{background:#123c31;color:#6ce8b8}.card-bg.state-paused{background:#4a2a18;color:#ffb47d}
.sgrid{border-color:#2a2943}.sbox{border-color:#302f49}.sv{color:#f8f7ff!important}.sbox:first-child .sv{color:#9e92ff!important}.sl{color:#aaa7c3}
.pbar{background:#2a2848}.pfill{background:linear-gradient(90deg,#9b75ff,#5542ff)}
.bcol{background:#0d0d20;border-color:#2a2944}.bcol:hover{border-color:#51497d}.bcol-hd,.bcalc-em{color:#f1efff}.bhist-row{border-color:#24233b}.bhist-val{color:#a89cff}.bhist-time,.bcalc-line{color:#aaa7c3}
.crow input{background:#0d0d20;border-color:#33314e;color:#f7f5ff}.crow input::placeholder{color:#77748f}.crow input:focus{border-color:#7667ff;box-shadow:0 0 0 3px rgba(104,87,255,.18)}.bsv{background:#30275e;color:#d2cdff}
.erow{border-color:#24233b}.ehd,.etsk{color:#aaa7c3}.eclr,.ets{color:#817e99}
.sacts{border-color:#2a2943}.ibtn{background:#19182f;color:#aaa7c3}.ibtn:hover{background:#30295d;color:#d8d4ff}.ibtn.dng:hover{background:#481827;color:#ff8ba2}
.encbtn{background:#4234d8;color:#fff}.encbtn:hover{background:#6857ff}.encoutstatus{background:#27224c;border-color:#443b78;color:#c7c1ff}.encoutstatus.yes{background:#123c31;border-color:#277d62;color:#6ce8b8}.encoutstatus.waiting{background:#4a2a18;border-color:#a75a2c;color:#ffb47d}.encoutstatus.no{background:#481827;border-color:#a63856;color:#ff9aae}.encoutstatus.answer{background:#282250;border-color:#5f50b8;color:#c7c1ff}
.ggrid{border-color:#292844}.bgrn{background:#5542ef}.bred{background:#3e1825;color:#ff91a8}.byel{background:#452716;color:#ffad72}.bpur{background:#29234e;color:#c7c1ff}.ftr{color:#aaa7c3}
.encmodal{background:rgba(2,0,12,.8)}.encpanel{background:#101023;box-shadow:0 35px 90px rgba(0,0,0,.58)}.enchd{border-color:#292844}.enctitle{color:#fff}.encclose{background:#1b1a33;color:#c0bdd2}.enchero{background:linear-gradient(145deg,#0a061c,#17102f)}.encstatus.answer{background:#30275e;color:#d2cdff}.encsum{background:#17162e;border-color:#302e49}.encsum b,.encdetail b{color:#aaa7c3}.encsum span,.encdetail{color:#f5f3ff}.encdetails{background:#121126;border-color:#302e49}.encdetail{border-color:#302e49}.encreceived button{background:#19182f;border-color:#34324e;color:#bbb8cf}.encschedule{background:#17162e;border-color:#302e49;color:#b5b1c8}.encschedule b{color:#f5f3ff}.encactivity{color:#aaa7c3}.encactivity div{border-color:#292844}
/* Production responsive system */
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}body{overflow-x:hidden}.appbar,.wrap,.card,.ov,.ggrid,.encpanel{min-width:0}.wrap{width:100%}
.card *,.encpanel *{min-width:0}.card-nm,.sv,.bhist-val,.bcalc-em,.encsum span{overflow-wrap:anywhere}
@media(min-width:1500px){.wrap{max-width:1420px}.appbar{padding-left:max(28px,calc((100vw - 1420px)/2));padding-right:max(28px,calc((100vw - 1420px)/2))}#slots-aiko,#slots-danica,#slots-darlene{gap:20px}.card{padding:20px}}
@media(max-width:1100px){.wrap{padding-left:20px;padding-right:20px}.overview{grid-template-columns:repeat(2,minmax(0,1fr))}.hero-copy h1{font-size:31px}.ggrid{align-items:stretch}.btn{flex:1}.b2col{grid-template-columns:1fr}.card{padding:16px}.credentials-row{min-width:0}}
@media(max-width:860px){.appbar{padding:0 20px}.wrap{padding-top:28px}.hero{align-items:stretch;flex-direction:column}.hero-copy{max-width:620px}.ph-clock{width:100%;max-width:420px}.overview{margin-bottom:22px}#slots-aiko,#slots-danica,#slots-darlene{grid-template-columns:1fr}.card{max-width:760px;width:100%;justify-self:center}.ggrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.btn{width:100%;min-width:0}.bful{grid-column:1/-1}.pills{gap:7px}.encpanel{max-width:590px}}
@media(max-width:620px){.appbar{height:58px;padding:0 14px}.brandmark{width:27px;height:27px}.brandcopy strong{font-size:15px}.appstate{font-size:9px}.wrap{padding:22px 10px 46px}.hero{gap:15px;margin-bottom:18px}.hero-copy h1{font-size:28px;margin-top:6px}.hero-copy p{font-size:11px;line-height:1.45}.ph-clock{max-width:none;padding:10px 12px}.ph-clock-time{font-size:15px}.overview{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:20px}.ov{min-height:104px;padding:12px;border-radius:14px}.ovicon{width:27px;height:27px;margin-bottom:9px}.ov strong{font-size:22px}.ov.next strong{font-size:16px}.ov small{font-size:8px}.pills{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));width:100%}.pill{justify-content:center;padding:6px 4px;font-size:8px}.stitle{margin-top:24px}.card{padding:14px;border-radius:15px}.sgrid{margin-bottom:12px}.sbox{padding:4px 7px}.sv{font-size:clamp(15px,4.8vw,19px)}.sl{font-size:8px}.b2col{grid-template-columns:1fr}.bcol{min-height:auto}.crow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto}.crow input{width:100%}.sacts{flex-wrap:wrap}.encbtn{order:0}.encoutstatus{order:1;flex:1;margin-right:0}.sacts>.ibtn:not(.encbtn){order:2}.ibtn{width:38px;height:38px}.encbtn{height:38px}.ggrid{padding:9px;gap:7px}.btn{min-height:42px;display:flex;align-items:center;justify-content:center}.encmodal{padding:10px;align-items:center}.encpanel{max-height:calc(100dvh - 20px);overflow:auto;border-radius:16px}.enchd{position:sticky;top:0;z-index:2;background:#101023;padding:15px 16px}.enchero{margin:14px 14px 9px;padding:15px}.enchero strong{font-size:23px}.encsummary,.encdetails,.encreceived,.encschedule,.encactivity{margin-left:14px;margin-right:14px}.encsummary{gap:5px}.encsum{padding:9px 7px}.encsum span{font-size:10px}.encdetails{grid-template-columns:1fr 1fr}.encdetail{padding:10px}.encreceived{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:6px}.encreceived button{padding:10px 5px;font-size:9px}.encschedule{flex-direction:column;gap:3px}.encactivity{margin-bottom:14px}}
@media(max-width:440px){.appbar{padding:0 10px}.appstate span:last-child{max-width:116px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wrap{padding-left:8px;padding-right:8px}.overview{grid-template-columns:1fr 1fr}.ov{min-height:98px;padding:10px}.ov strong{font-size:20px}.ov span{font-size:8px}.hero-copy h1{font-size:26px}.ph-clock{grid-template-columns:minmax(0,1fr) auto}.pills{gap:4px}.pill{font-size:7.5px}.card{padding:12px}.card-hd{margin-bottom:12px}.card-nm{font-size:14px}.sgrid{padding:11px 0}.sv{font-size:15px}.bcol{padding:10px}.bhist-row{align-items:flex-start}.bhist-time{white-space:normal;text-align:right;line-height:1.25}.crow{grid-template-columns:1fr}.crow .bsm{width:100%;min-height:38px}.sacts{gap:5px}.encoutstatus{width:calc(100% - 84px);font-size:8px;padding:0 8px;white-space:normal;line-height:1.2}.sacts>.ibtn:not(.encbtn){flex:1;min-width:38px}.ggrid{grid-template-columns:1fr 1fr}.encdetails{grid-template-columns:1fr}.encdetail:nth-child(odd){border-right:0}.encdetail:nth-last-child(2){border-bottom:1px solid #302e49}.encreceived{grid-template-columns:1fr!important}.encreceived button{min-height:42px;font-size:10px}.encsummary{grid-template-columns:1fr 1fr}.encsum.net{grid-column:1/-1}.enchero{align-items:center}.encstatus{white-space:nowrap}}
@media(max-width:340px){.brandcopy span{display:none}.appstate span:last-child{display:none}.overview{grid-template-columns:1fr}.ov{min-height:88px}.ovicon{margin-bottom:6px}.pills{grid-template-columns:1fr}.pill{font-size:9px}.ggrid{grid-template-columns:1fr}.bful{grid-column:auto}.sgrid{grid-template-columns:1fr}.sbox{border-left:0;border-top:1px solid #302f49;padding:8px}.sbox:first-child{border-top:0}.encbtn{width:100%;justify-content:center}.encoutstatus{width:100%;justify-content:center}.sacts>.ibtn:not(.encbtn){flex:1}.encsummary{grid-template-columns:1fr}.encsum.net{grid-column:auto}}
@media(max-height:560px) and (orientation:landscape){.encmodal{align-items:flex-start}.encpanel{max-height:calc(100dvh - 12px)}.appbar{position:relative}.wrap{padding-top:18px}.hero{flex-direction:row}.overview{grid-template-columns:repeat(4,minmax(0,1fr))}.ov{min-height:90px}}
@media(hover:none){.card:hover{transform:none}.ibtn,.btn,.encreceived button,.encclose{min-height:40px}.ibtn{min-width:40px}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;animation-duration:.01ms!important;transition-duration:.01ms!important}}
.encstatus-short,.action-break{display:none}
@media(max-width:620px){.sacts{display:flex}.encbtn{flex:0 0 auto}.encoutstatus{flex:1;justify-content:flex-start;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.action-break{display:block;flex-basis:100%;height:0}.sacts>.ibtn:not(.encbtn){flex:1;max-width:none}.encstatus-full{display:none}.encstatus-short{display:inline;overflow:hidden;text-overflow:ellipsis}}
@media(max-width:360px){.encstatus-short{font-size:8px}.encbtn{padding-left:8px;padding-right:8px}.sacts{gap:4px}}
.payout-control{display:flex;align-items:stretch;gap:5px;min-width:0;margin-right:auto}.payout-control .encbtn{margin:0;flex:none}.payout-control .encoutstatus{margin:0;min-width:0}
@media(max-width:620px){.payout-control{display:grid;grid-template-columns:72px minmax(0,1fr);width:100%;flex-basis:100%;order:0;margin:0}.payout-control .encbtn{width:100%;height:40px;justify-content:center}.payout-control .encoutstatus{width:100%;height:40px;justify-content:flex-start;padding:0 10px}.action-break{display:none}.sacts>.ibtn:not(.encbtn){order:2;flex:1;max-width:none}.sacts{align-items:stretch}}
@media(max-width:340px){.payout-control{grid-template-columns:68px minmax(0,1fr)}.payout-control .encbtn{width:100%}.payout-control .encoutstatus{width:100%;font-size:8px}.sacts>.ibtn:not(.encbtn){min-width:36px}}
/* Simplified account controls and group identity */
.crow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:7px}.crow input{width:100%}.bsv{display:none}
.card-aiko{border-top:2px solid #6857ff;background:linear-gradient(180deg,rgba(104,87,255,.055),#111126 82px)}
.card-danica{border-top:2px solid #ff7892;background:linear-gradient(180deg,rgba(255,120,146,.06),#111126 82px)}
.card-darlene{border-top:2px solid #39d49a;background:linear-gradient(180deg,rgba(57,212,154,.055),#111126 82px)}
.card-aiko .sbox:first-child .sv{color:#9e92ff!important}.card-danica .sbox:first-child .sv{color:#ff8fa5!important}.card-darlene .sbox:first-child .sv{color:#62dfae!important}
.section-aiko-title:before{background:#6857ff}.section-danica-title:before{background:#ff7892}.section-darlene-title:before{background:#39d49a}
@media(max-width:440px){.crow{grid-template-columns:1fr}.sacts>.ibtn:not(.encbtn){min-width:48px}}
/* Clear saturated semantic palette */
:root{--green:#28d99b;--red:#ff4d6d;--yellow:#ff943d;--coral:#ff5f7a}
.ov.next .ovicon{background:rgba(255,148,61,.16);color:#ffad70}.ov.health .ovicon{background:rgba(40,217,155,.14);color:#55e8b2}
.card-bg.state-running{background:rgba(40,217,155,.15);color:#67edbc}.card-bg.state-paused{background:rgba(255,148,61,.16);color:#ffb477}
.card-danica{border-top-color:#ff5f7a;background:linear-gradient(180deg,rgba(255,95,122,.085),#111126 82px)}.card-danica .sbox:first-child .sv{color:#ff7890!important}.section-danica-title:before{background:#ff5f7a}
.encoutstatus.yes{background:rgba(40,217,155,.14);border-color:rgba(40,217,155,.5);color:#67edbc}.encoutstatus.waiting{background:rgba(255,148,61,.16);border-color:rgba(255,148,61,.52);color:#ffb477}.encoutstatus.no{background:rgba(255,77,109,.15);border-color:rgba(255,77,109,.5);color:#ff8da2}
.encstatus.yes{background:#137456;color:#8af2ca}.encstatus.waiting{background:#a74d16;color:#fff0df}.encstatus.no{background:#a92846;color:#ffe5ea}
.encreceived button.yes.active{background:#168562;border-color:#28d99b;color:#fff}.encreceived button.waiting.active{background:#d66520;border-color:#ff943d;color:#fff}.encreceived button.no.active{background:#c93152;border-color:#ff4d6d;color:#fff}
.bred{background:rgba(255,77,109,.14);color:#ff8da2;border:1px solid rgba(255,77,109,.2)}.byel{background:rgba(255,148,61,.15);color:#ffb477;border:1px solid rgba(255,148,61,.2)}.ibtn.dng:hover{background:rgba(255,77,109,.15);color:#ff7892}
/* Vivid theme and user-controlled global slot accent */
:root{--slot-accent:#725cff;--slot-accent-soft:rgba(114,92,255,.12);--green:#00d68f;--red:#ff3b61;--yellow:#ffad0a;--coral:#ff4f78}
.card-aiko,.card-danica,.card-darlene{border-top-color:var(--slot-accent);background:linear-gradient(180deg,var(--slot-accent-soft),#111126 84px)}.card-aiko .sbox:first-child .sv,.card-danica .sbox:first-child .sv,.card-darlene .sbox:first-child .sv{color:var(--slot-accent)!important}.pfill{background:linear-gradient(90deg,color-mix(in srgb,var(--slot-accent) 72%,white),var(--slot-accent))}.crow input:focus{border-color:var(--slot-accent)}.bsv,.encbtn{background:var(--slot-accent)}
.card-bg.state-running{background:#00b87a;color:#fff}.card-bg.state-paused{background:#ff9f0a;color:#160b00}.encoutstatus.yes{background:#00a96f;border-color:#00d68f;color:#fff}.encoutstatus.waiting{background:#ff9f0a;border-color:#ffbd45;color:#160b00}.encoutstatus.no{background:#e92f55;border-color:#ff5f7e;color:#fff}.encoutstatus.answer{background:#5c52e8;border-color:#8178ff;color:#fff}
.encstatus.yes{background:#00a96f;color:#fff}.encstatus.waiting{background:#ff9f0a;color:#160b00}.encstatus.no{background:#e92f55;color:#fff}.encstatus.answer{background:#5c52e8;color:#fff}
.encreceived button.yes.active{background:#00a96f;border-color:#00d68f}.encreceived button.waiting.active{background:#ff9f0a;border-color:#ffbd45;color:#160b00}.encreceived button.no.active{background:#e92f55;border-color:#ff5f7e}
.bred{background:#e92f55;color:#fff;border-color:#ff5f7e}.byel{background:#ff9f0a;color:#160b00;border-color:#ffbd45}
/* Independent full-card section themes */
:root{--aiko-accent:#725cff;--aiko-soft:rgba(114,92,255,.14);--aiko-glow:rgba(114,92,255,.22);--danica-accent:#ff4f78;--danica-soft:rgba(255,79,120,.14);--danica-glow:rgba(255,79,120,.22);--darlene-accent:#00d68f;--darlene-soft:rgba(0,214,143,.14);--darlene-glow:rgba(0,214,143,.22)}
.card-aiko{--section-accent:var(--aiko-accent);--section-soft:var(--aiko-soft);--section-glow:var(--aiko-glow)}.card-danica{--section-accent:var(--danica-accent);--section-soft:var(--danica-soft);--section-glow:var(--danica-glow)}.card-darlene{--section-accent:var(--darlene-accent);--section-soft:var(--darlene-soft);--section-glow:var(--darlene-glow)}
.card-aiko,.card-danica,.card-darlene{border:1px solid color-mix(in srgb,var(--section-accent) 62%,#292844);border-top:3px solid var(--section-accent);background:linear-gradient(145deg,var(--section-soft),#111126 46%,#0e0e20);box-shadow:0 14px 34px rgba(0,0,0,.28),0 0 24px var(--section-glow)}
.card-aiko:hover,.card-danica:hover,.card-darlene:hover{border-color:var(--section-accent);box-shadow:0 18px 42px rgba(0,0,0,.4),0 0 32px var(--section-glow)}
.card-aiko .sbox:first-child .sv,.card-danica .sbox:first-child .sv,.card-darlene .sbox:first-child .sv,.card-aiko .bhist-val,.card-danica .bhist-val,.card-darlene .bhist-val{color:var(--section-accent)!important}
.card-aiko .pfill,.card-danica .pfill,.card-darlene .pfill{background:linear-gradient(90deg,color-mix(in srgb,var(--section-accent) 58%,white),var(--section-accent))}
.card-aiko .bcol,.card-danica .bcol,.card-darlene .bcol{background:linear-gradient(135deg,var(--section-soft),#0d0d20 68%);border-color:color-mix(in srgb,var(--section-accent) 38%,#2a2944)}
.card-aiko .crow input:focus,.card-danica .crow input:focus,.card-darlene .crow input:focus{border-color:var(--section-accent);box-shadow:0 0 0 3px var(--section-soft)}
.card-aiko .encbtn{background:var(--section-accent)}.card-aiko .ibtn:hover,.card-danica .ibtn:hover,.card-darlene .ibtn:hover{color:var(--section-accent);background:var(--section-soft)}
.section-aiko-title{--heading-accent:var(--aiko-accent)}.section-danica-title{--heading-accent:var(--danica-accent)}.section-darlene-title{--heading-accent:var(--darlene-accent)}.section-aiko-title:before,.section-danica-title:before,.section-darlene-title:before{background:var(--heading-accent)}
.stitle.section-aiko-title,.stitle.section-danica-title,.stitle.section-darlene-title{display:flex;align-items:center;justify-content:space-between;gap:12px}
.section-theme{display:flex;align-items:center;gap:5px}.section-theme input[type=color]{width:34px;height:28px;padding:2px;border:1px solid #3a3757;border-radius:7px;background:#0b0b18;cursor:pointer}.section-theme input:not([type=color]){width:78px;height:28px;padding:0 7px;border:1px solid #3a3757;border-radius:7px;background:#0b0b18;color:#fff;font:700 9px ui-monospace,SFMono-Regular,monospace;text-transform:uppercase;outline:0}.section-theme input:not([type=color]):focus{border-color:var(--heading-accent)}.section-theme button{height:28px;padding:0 9px;border:0;border-radius:7px;background:var(--heading-accent);color:#fff;font-size:8px;font-weight:800;cursor:pointer}
@media(max-width:520px){.stitle.section-aiko-title,.stitle.section-danica-title,.stitle.section-darlene-title{align-items:flex-start;flex-direction:column}.section-theme{width:100%;display:grid;grid-template-columns:36px minmax(0,1fr) auto}.section-theme input:not([type=color]){width:100%}.section-theme button{min-width:58px}}
/* Theme-independent cash-out action */
.card .encbtn,.card-aiko .encbtn,.card-danica .encbtn,.card-darlene .encbtn{background:#f8f7ff!important;color:#15112f!important;border:1px solid #fff!important;box-shadow:0 5px 14px rgba(0,0,0,.24);font-weight:850}.card .encbtn:hover,.card .encbtn:focus-visible{background:#dcd7ff!important;color:#2418a8!important;border-color:#bdb5ff!important;outline:0}.card .encbtn:active{transform:translateY(1px)}
/* Always-visible touch-friendly mobile section color controls */
.section-theme input[type=color]{-webkit-appearance:none;appearance:none;overflow:hidden}.section-theme input[type=color]::-webkit-color-swatch-wrapper{padding:2px}.section-theme input[type=color]::-webkit-color-swatch{border:0;border-radius:5px}
@media(max-width:620px){.section-theme{display:grid!important;grid-template-columns:44px minmax(0,1fr) 68px!important;gap:7px!important;width:100%!important}.section-theme input[type=color]{display:block!important;width:44px!important;height:40px!important;min-width:44px!important;padding:2px!important}.section-theme input:not([type=color]){display:block!important;width:100%!important;height:40px!important;font-size:11px!important}.section-theme button{display:block!important;width:68px!important;height:40px!important;font-size:9px!important}.stitle.section-aiko-title,.stitle.section-danica-title,.stitle.section-darlene-title{align-items:flex-start!important;flex-direction:column!important}}
@media(max-width:340px){.section-theme{grid-template-columns:42px minmax(0,1fr)!important}.section-theme button{grid-column:1/-1;width:100%!important}.section-theme input[type=color]{width:42px!important;min-width:42px!important}}
.confirmmodal{display:none;position:fixed;inset:0;z-index:80;background:rgba(2,0,12,.82);padding:16px;align-items:center;justify-content:center;backdrop-filter:blur(8px)}.confirmmodal.show{display:flex}.confirmpanel{width:min(100%,390px);background:linear-gradient(145deg,#18172e,#0f0f21);border:1px solid #353251;border-radius:18px;padding:22px;box-shadow:0 30px 80px rgba(0,0,0,.62);text-align:center;animation:confirm-in .18s ease}.confirmicon{width:42px;height:42px;margin:0 auto 13px;border-radius:13px;display:grid;place-items:center;background:#2e285a;color:#d8d3ff;font-size:20px;font-weight:900}.confirmpanel h2{font-size:17px;color:#fff;margin:0}.confirmpanel p{font-size:11px;line-height:1.55;color:#b7b3ca;margin:9px 0 19px}.confirmactions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.confirmactions button{height:42px;border-radius:9px;font-size:10px;font-weight:850;cursor:pointer}.confirmcancel{border:1px solid #3b3857;background:#1a192e;color:#c4c0d4}.confirmaccept{border:0;background:#6857ff;color:#fff}.confirmaccept.danger{background:#ff3b61}.confirmaccept.warning{background:#ff9f0a;color:#160b00}@keyframes confirm-in{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}@media(max-width:390px){.confirmpanel{padding:18px}.confirmactions{grid-template-columns:1fr}.confirmactions button{height:44px}}
</style>
</head>
<body>
<header class="appbar"><div class="brand"><span class="brandmark"><i></i><i></i><i></i><i></i></span><span class="brandcopy"><strong>VisionTap</strong><span>CONTROL CENTER</span></span></div><div class="appstate"><span class="livedot" id="app-live-dot"></span><span id="app-state-text">Checking system…</span></div></header>
<div class="wrap">
  <section class="hero"><div class="hero-copy"><span class="eyebrow">Operations overview</span><h1>Control center<em>.</em></h1><p>Monitor real earnings, manage accounts, and control every live task.</p></div><div class="ph-clock" aria-live="off"><div class="ph-clock-time" id="ph-clock-time">--:--:--</div><div class="ph-clock-date" id="ph-clock-date">Loading Philippine time...</div><div class="ph-clock-label">PH · UTC+8</div></div></section>
  <section class="overview"><div class="ov primary"><span class="ovicon">▦</span><small>Total accounts</small><strong id="ov-total">00</strong><span>real configured slots</span></div><div class="ov"><span class="ovicon">◉</span><small>Active accounts</small><strong id="ov-active">00</strong><span id="ov-active-note">checking status</span></div><div class="ov health"><span class="ovicon">✓</span><small>Automation health</small><strong id="ov-health">—</strong><span>scanner · electron · loop</span></div><div class="ov next"><span class="ovicon">◷</span><small>Next encashment</small><strong id="ov-next-day">—</strong><span id="ov-next-time">Loading schedule…</span></div></section>
  <div class="pills" id="pills"></div>
  <div class="stitle">Global Controls</div>
  <div class="ggrid">
    <a class="btn bgrn" href="/cmd?action=resume&slot=all" onclick="return confirmLink(event,this,&quot;Resume every account?&quot;,&quot;All paused accounts will resume automation.&quot;,&quot;Resume all&quot;)">Resume All</a>
    <a class="btn bred" href="/cmd?action=pause&slot=all" onclick="return confirmLink(event,this,&quot;Pause every account?&quot;,&quot;All account automation will pause until resumed.&quot;,&quot;Pause all&quot;)">Pause All</a>
    <a class="btn byel" href="/cmd?action=restart&slot=all" onclick="return confirmLink(event,this,&quot;Restart every account?&quot;,&quot;All account windows will restart.&quot;,&quot;Restart all&quot;)">Restart All</a>
    <a class="btn bpur" href="/cmd?action=refresh&slot=all" onclick="return confirmLink(event,this,&quot;Refresh every account?&quot;,&quot;All account pages will reload.&quot;,&quot;Refresh all&quot;)">Refresh All</a>
  </div>
  <div class="stitle">Loop</div>
  <div class="ggrid">
    <a class="btn bgrn bful" id="lbtn" href="/loop?cmd=resume" onclick="return confirmLink(event,this,&quot;Change loop state?&quot;,&quot;This will change automation for every account.&quot;,this.textContent)">Resume Loop</a>
  </div>
  <div class="stitle section-aiko-title"><span>AIKO — <span id="scnt-aiko">0</span> slots</span><span class="section-theme"><input id="aiko-wheel" type="color" value="#725CFF" oninput="previewSectionColor(&quot;aiko&quot;,this.value)"><input id="aiko-hex" value="#725CFF" maxlength="7" aria-label="AIKO color hex"><button type="button" onclick="confirmSectionColor(&quot;aiko&quot;)">Apply</button></span></div>
  <div id="slots-aiko"></div>
  <div class="stitle section-danica-title"><span>DANICA — <span id="scnt-danica">0</span> slots</span><span class="section-theme"><input id="danica-wheel" type="color" value="#FF4F78" oninput="previewSectionColor(&quot;danica&quot;,this.value)"><input id="danica-hex" value="#FF4F78" maxlength="7" aria-label="DANICA color hex"><button type="button" onclick="confirmSectionColor(&quot;danica&quot;)">Apply</button></span></div>
  <div id="slots-danica"></div>
  <div class="stitle section-darlene-title"><span>DARLENE — <span id="scnt-darlene">0</span> slots</span><span class="section-theme"><input id="darlene-wheel" type="color" value="#00D68F" oninput="previewSectionColor(&quot;darlene&quot;,this.value)"><input id="darlene-hex" value="#00D68F" maxlength="7" aria-label="DARLENE color hex"><button type="button" onclick="confirmSectionColor(&quot;darlene&quot;)">Apply</button></span></div>
  <div id="slots-darlene"></div>
  <div class="stitle">Server</div>
  <div class="ggrid">
    <a class="btn bgrn bful" href="/restart" onclick="return confirmLink(event,this,&quot;Restart VisionTap?&quot;,&quot;The dashboard and automation services may be briefly unavailable.&quot;,&quot;Restart VisionTap&quot;)">Restart VisionTap</a>
  </div>
  <div class="ftr"><span class="livedot"></span><span id="ltxt">Connecting...</span></div>
  <div class="encmodal" id="encmodal" onclick="if(event.target===this)closeEncash()"><div class="encpanel"><div class="enchd"><div class="enctitle">adaihbi Payout</div><button class="encclose" onclick="closeEncash()">Close</button></div><div id="encbody"></div></div></div>
  <div class="confirmmodal" id="confirmmodal" onclick="if(event.target===this)closeConfirm()"><div class="confirmpanel" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><div class="confirmicon">!</div><h2 id="confirm-title">Confirm action</h2><p id="confirm-message"></p><div class="confirmactions"><button type="button" class="confirmcancel" onclick="closeConfirm()">Cancel</button><button type="button" class="confirmaccept" id="confirm-accept" onclick="acceptConfirm()">Confirm</button></div></div></div>
</div>
<datalist id="hu">${historyOpts}</datalist>
<script>
var POLL=2000,LD='',PH_TIME_ZONE=${JSON.stringify(PH_TIME_ZONE)};

function formatPHTime(now){
  return new Intl.DateTimeFormat('en-PH',{timeZone:PH_TIME_ZONE,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}).format(now);
}
function formatPHDate(now){
  return new Intl.DateTimeFormat('en-PH',{timeZone:PH_TIME_ZONE,weekday:'long',year:'numeric',month:'long',day:'numeric'}).format(now);
}
function updatePHClock(){
  var now=new Date();
  var timeEl=document.getElementById('ph-clock-time');
  var dateEl=document.getElementById('ph-clock-date');
  if(timeEl) timeEl.textContent=formatPHTime(now);
  if(dateEl) dateEl.textContent=formatPHDate(now);
  return now;
}

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

var pendingConfirmAction=null;
function askConfirm(title,message,label,action,tone){
  pendingConfirmAction=action;
  document.getElementById('confirm-title').textContent=title||'Confirm action';
  document.getElementById('confirm-message').textContent=message||'Are you sure you want to continue?';
  var accept=document.getElementById('confirm-accept');accept.textContent=label||'Confirm';accept.className='confirmaccept'+(tone?' '+tone:'');
  document.getElementById('confirmmodal').classList.add('show');
}
function closeConfirm(){document.getElementById('confirmmodal').classList.remove('show');pendingConfirmAction=null}
function acceptConfirm(){var action=pendingConfirmAction;document.getElementById('confirmmodal').classList.remove('show');pendingConfirmAction=null;if(action)action()}
function confirmLink(event,element,title,message,label,tone){if(event)event.preventDefault();var href=element&&element.href;askConfirm(title,message,label,function(){if(href)window.location.href=href},tone);return false}
function confirmSectionColor(section){var label=section.charAt(0).toUpperCase()+section.slice(1);askConfirm('Apply '+label+' theme?','This color will update every slot card in the '+label+' section.','Apply color',function(){applySectionColor(section)})}
function confirmReceipt(value){var labels={yes:'Received',waiting:'Waiting',no:'Not received'},tones={yes:'',waiting:'warning',no:'danger'};askConfirm('Set payout as '+labels[value]+'?','This will replace the current payout answer and remain saved after refresh.',labels[value],function(){setPayoutReceived(value)},tones[value])}
function setSectionAccent(section,value){
  if(!/^(aiko|danica|darlene)$/.test(section)||!/^#[0-9A-F]{6}$/i.test(value))return false;
  var r=parseInt(value.slice(1,3),16),g=parseInt(value.slice(3,5),16),b=parseInt(value.slice(5,7),16),root=document.documentElement;
  root.style.setProperty('--'+section+'-accent',value.toUpperCase());
  root.style.setProperty('--'+section+'-soft','rgba('+r+','+g+','+b+',.14)');
  root.style.setProperty('--'+section+'-glow','rgba('+r+','+g+','+b+',.22)');
  return true;
}
function previewSectionColor(section,value){
  if(!setSectionAccent(section,value))return;
  var hex=document.getElementById(section+'-hex');if(hex)hex.value=value.toUpperCase();
  window._sectionThemeDirty=window._sectionThemeDirty||{};window._sectionThemeDirty[section]=true;
}
function applySectionColor(section){
  var input=document.getElementById(section+'-hex'),value=String(input&&input.value||'').trim().toUpperCase();
  if(value.charAt(0)!=='#')value='#'+value;
  if(!setSectionAccent(section,value)){alert('Enter a valid 6-digit hex color, for example #725CFF.');return;}
  input.value=value;var wheel=document.getElementById(section+'-wheel');if(wheel)wheel.value=value;
  fetch('/theme-color?section='+encodeURIComponent(section)+'&value='+encodeURIComponent(value),{method:'POST'}).then(function(r){if(!r.ok)throw new Error('Save failed');return r.json()}).then(function(){window._sectionThemeDirty=window._sectionThemeDirty||{};window._sectionThemeDirty[section]=false}).catch(function(){alert('Could not save this section color. Please try again.')});
}
function syncSectionThemes(theme){
  var defaults={aiko:'#725CFF',danica:'#FF4F78',darlene:'#00D68F'},dirty=window._sectionThemeDirty||{};
  ['aiko','danica','darlene'].forEach(function(section){var value=theme&&theme[section+'Color']||defaults[section];if(dirty[section]||!setSectionAccent(section,value))return;var wheel=document.getElementById(section+'-wheel'),hex=document.getElementById(section+'-hex');if(wheel)wheel.value=value;if(hex)hex.value=value;});
}
function render(d){
  var slots=d.slots||[];
  syncSectionThemes(d.theme||{});
  var aikoSlots = slots.filter(s => !["13", "16"].includes(String(s.id)) && !["danicajgb", "nnnikkikim"].includes(String(s.accountName).toLowerCase()) && !["17"].includes(String(s.id)) && !["darlenejoyce"].includes(String(s.accountName).toLowerCase()));
  var danicaSlots = slots.filter(s => ["13", "16"].includes(String(s.id)) || ["danicajgb", "nnnikkikim"].includes(String(s.accountName).toLowerCase()));
  var darleneSlots = slots.filter(s => ["17"].includes(String(s.id)) || ["darlenejoyce"].includes(String(s.accountName).toLowerCase()));
  document.getElementById('scnt-aiko').textContent=aikoSlots.length;
  document.getElementById('scnt-danica').textContent=danicaSlots.length;
  document.getElementById('scnt-darlene').textContent=darleneSlots.length;
  var activeCount=slots.filter(function(x){return !x.paused}).length,healthy=d.scannerUp&&d.electronProcs>0&&!d.loopPaused;
  document.getElementById('ov-total').textContent=String(slots.length).padStart(2,'0');
  document.getElementById('ov-active').textContent=String(activeCount).padStart(2,'0');
  document.getElementById('ov-active-note').textContent=activeCount+' of '+slots.length+' running';
  document.getElementById('ov-health').textContent=healthy?'Healthy':'Attention';
  document.getElementById('app-state-text').textContent=healthy?'System Online':'System Needs Attention';
  document.getElementById('app-live-dot').style.background=healthy?'var(--green)':'var(--red)';
  var encSlot=slots.find(function(x){return String(x.accountName||'').toLowerCase()==='adaihbi'}),schedule=encSlot&&encSlot.encashmentSchedule||{},dayNames={Mon:'Monday',Tue:'Tuesday',Wed:'Wednesday',Thu:'Thursday',Fri:'Friday',Sat:'Saturday',Sun:'Sunday'},scheduleDay=dayNames[schedule.weekday]||schedule.weekday||'Not scheduled';
  document.getElementById('ov-next-day').textContent=scheduleDay;
  document.getElementById('ov-next-time').textContent=schedule.startHour!=null&&schedule.endHour!=null?schedule.startHour+':00–'+schedule.endHour+':00 AM PH':'Schedule not configured';
  document.getElementById('pills').innerHTML=
    '<div class="pill"><div class="dot" style="background:'+(d.scannerUp?'var(--green)':'var(--red)')+'"></div>Scanner '+(d.scannerUp?'Online':'Offline')+'</div>'+
    '<div class="pill"><div class="dot" style="background:'+(d.electronProcs>0?'var(--green)':'var(--red)')+'"></div>Electron '+(d.electronProcs>0?'Running':'Stopped')+'</div>'+
    '<div class="pill"><div class="dot" style="background:'+(d.loopPaused?'var(--yellow)':'var(--green)')+'"></div>Loop '+(d.loopPaused?'Paused':'Running')+'</div>';
  var lb=document.getElementById('lbtn');
  if(d.loopPaused){lb.href='/loop?cmd=resume';lb.textContent='Resume Loop';lb.className='btn bgrn bful'}
  else{lb.href='/loop?cmd=pause';lb.textContent='Pause Loop';lb.className='btn bred bful'}
  var hAiko='', hDanica='', hDarlene='';
  for(var i=0;i<slots.length;i++){
    var s=slots[i];
    var isDanica = ["13", "16"].includes(String(s.id)) || ["danicajgb", "nnnikkikim"].includes(String(s.accountName).toLowerCase());
    var isDarlene = ["17"].includes(String(s.id)) || ["darlenejoyce"].includes(String(s.accountName).toLowerCase());
    var sc=isDarlene ? '#34d399' : (isDanica ? '#f472b6' : '#38bdf8');
    var cardClass = isDarlene ? 'card-darlene' : (isDanica ? 'card-danica' : 'card-aiko');
    var st=s.paused ? 'PAUSED' : 'RUNNING';
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
      '<div class="card-hd"><span class="card-nm">'+esc(s.name)+'</span><span class="card-bg state-'+(s.paused?'paused':'running')+'">'+st+'</span></div>'+
      '<div class="sgrid">'+
        '<div class="sbox"><div class="sv" style="color:#facc15">&#8369;'+( (String(s.id)==="14"||String(s.accountName).toLowerCase()==="kyaiko") ? (Number(s.withdrawable||0)/100).toFixed(2) : s.withdrawable )+'</div><div class="sl">'+( (String(s.id)==="14"||String(s.accountName).toLowerCase()==="kyaiko") ? "Balance (₱)" : "Balance")+'</div></div>'+
        '<div class="sbox"><div class="sv" style="color:#a78bfa">'+( (String(s.id)==="14"||String(s.accountName).toLowerCase()==="kyaiko") ? (s.pointsDone||0)+" coins" : pts)+'</div><div class="sl">'+( (String(s.id)==="14"||String(s.accountName).toLowerCase()==="kyaiko") ? "Coins":"Points")+'</div></div>'+
        '<div class="sbox"><div class="sv" style="color:#38bdf8" id="timer-'+esc(s.id)+'">'+esc(liveTimerText(s.loopStartTime,s.timerText))+'</div><div class="sl">Time</div></div>'+
      '</div>'+
      ((s.pointsTotal>0 && ! (String(s.id)==="14"||String(s.accountName).toLowerCase()==="kyaiko") )?'<div class="pbar"><div class="pfill" style="width:'+pct+'%"></div></div>':'')+
      (function(){
        var isPmathCard = String(s.id)==="14" || String(s.accountName).toLowerCase()==="kyaiko";
        var ptsPerMin = (s.pointsPerMinute != null ? s.pointsPerMinute : 0);
        var ptsPerHour = (s.pointsPerHour != null ? s.pointsPerHour : 0);
        var ptsUntilMid = (s.pointsUntilTarget != null ? s.pointsUntilTarget : 0);
        var targetPesos = (s.targetPesos != null ? s.targetPesos : 300);
        var pesosNeeded = (s.pesosNeeded != null ? s.pesosNeeded : Math.max(0, targetPesos - Number(s.withdrawable||0)));
        if (isPmathCard) {
          targetPesos = 300;
          ptsUntilMid = Math.max(0, 30000 - Number(s.withdrawable||0));
          pesosNeeded = ptsUntilMid / 100;
        }
        var etaText = (s.etaText != null && s.etaText !== "" ? s.etaText : "-");
        var balHist = Array.isArray(s.balanceHistory) ? s.balanceHistory : [];
        function fmtPH(ts){ try{ return new Date(ts).toLocaleString('en-PH',{timeZone:'Asia/Manila', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true})+' PH'; }catch(e){ return new Date(ts).toLocaleString(); } }
        var histHtml = '';
        if (balHist.length===0) histHtml = '<div style="font-size:9px;color:var(--muted)">-</div>';
        else {
          for(var k=balHist.length-1;k>=0;k--){
            var h=balHist[k];
            var raw = (h.value!=null?Number(h.value):null);
            var hv = (raw!=null ? (isPmathCard ? (raw/100).toFixed(2) : raw.toFixed(2)) : '-');
            var ht = h.time?fmtPH(h.time):'';
            histHtml += '<div class="bhist-row"><span class="bhist-val">&#8369;'+hv+'</span><span class="bhist-time">'+esc(ht)+'</span></div>';
          }
        }
        var cyclesNeeded = ptsUntilMid>0? (ptsUntilMid/(isPmathCard?100:250)).toFixed(1) : '0';
        var leftCol = '<div class="bcol"><div class="bcol-hd">Balance History (10)</div><div class="bhist-list">'+histHtml+'</div></div>';
        var avgSecondsPerPoint = ptsPerMin>0 ? (60/ptsPerMin) : 0;
        var rightCol;
        if (isPmathCard) {
          rightCol = '<div class="bcol"><div class="bcol-hd">Kyaiko Goal (100 coins = 1&#8369;)</div>'
            +'<div class="bcalc-line">Goal: <span class="bcalc-em">&#8369;300 = 30,000 coins</span></div>'
            +'<div class="bcalc-line">Remaining: <span class="bcalc-em" style="color:#38bdf8">'+ptsUntilMid+' coins</span> (&#8369;'+Number(pesosNeeded).toFixed(2)+')</div>'
            +'<div class="bcalc-line">Rate: <span class="bcalc-em" style="color:#facc15">'+ptsPerMin+' coins/min</span> <span style="color:var(--muted)">('+ptsPerHour+'/hr)</span></div>'
            +'<div class="bcalc-line">Average: <span class="bcalc-em">'+(avgSecondsPerPoint>0?avgSecondsPerPoint.toFixed(2)+' sec/coin':'—')+'</span></div>'
            +'<div class="bcalc-line" style="color:var(--muted)">ETA: <span class="bcalc-em" style="color:#facc15">'+esc(etaText)+'</span></div></div>';
        } else {
          rightCol = '<div class="bcol"><div class="bcol-hd">Calculation (250=3&#8369;)</div>'
            +'<div class="bcalc-line">&#8369;'+targetPesos+': <span class="bcalc-em">&#8369;'+Number(pesosNeeded).toFixed(2)+' needed</span></div>'
            +'<div class="bcalc-line">Points: <span class="bcalc-em" style="color:#38bdf8">'+ptsUntilMid+' pts</span> <span style="color:var(--muted)">('+cyclesNeeded+' cycles)</span></div>'
            +'<div class="bcalc-line">Getting: <span class="bcalc-em" style="color:#facc15">'+ptsPerMin+' pts/min</span> <span style="color:var(--muted)">('+ptsPerHour+'/hr)</span></div>'
            +'<div class="bcalc-line" style="color:var(--muted)">ETA: <span class="bcalc-em" style="color:#facc15">'+esc(etaText)+'</span></div></div>';
        }
        var grid = '<div class="b2col">'+leftCol+rightCol+'</div>';
        return grid;
      })() +
      '<form class="crow" method="GET" action="/save-creds" onchange="this.submit()"><input type="hidden" name="slot" value="'+esc(s.id)+'">'+
      '<input type="text" name="user" placeholder="Username" value="'+esc(s.user)+'" list="hu">'+
      '<input type="text" name="pass" placeholder="Password" value="'+esc(s.pass)+'">'+
      '</form>'+
      eh+
      '<div class="sacts">'+        (function(){if(String(s.accountName).toLowerCase()!=='adaihbi')return '';var e=s.encashment||{},q=s.encashmentSchedule||{},d=e.receivedDecision||'',day=q.weekday==='Wed'?'Wednesday':(q.weekday||'Wednesday'),cls=d==='yes'?'yes':d==='waiting'?'waiting':d==='no'?'no':'answer',txt=d==='yes'?'Payment received · Next withdrawal '+day:d==='waiting'?'Waiting for payment':d==='no'?'Payment not received':'Answer whether payment arrived',shortTxt=d==='yes'?'Received · Next withdrawal '+day:d==='waiting'?'Waiting for payment':d==='no'?'Not received':'Answer needed';return '<span class="payout-control"><button class="ibtn encbtn" type="button" onclick="showEncash(&quot;'+esc(s.id)+'&quot;)">Cash-out</button><span class="encoutstatus '+cls+'"><span class="encstatus-full">'+esc(txt)+'</span><span class="encstatus-short">'+esc(shortTxt)+'</span></span></span><span class="action-break"></span>'})()+
        '<a class="ibtn" href="/cmd?action=pause&slot='+sid+'" title="Pause" onclick="return confirmLink(event,this,&quot;Pause this account?&quot;,&quot;Automation for this account will stop until resumed.&quot;,&quot;Pause&quot;)">&#9646;&#9646;</a>'+
        '<a class="ibtn" href="/cmd?action=resume&slot='+sid+'" title="Resume" onclick="return confirmLink(event,this,&quot;Resume this account?&quot;,&quot;Automation for this account will start again.&quot;,&quot;Resume&quot;)">&#9654;</a>'+

        '<a class="ibtn" href="/cmd?action=refresh&slot='+sid+'" title="Refresh" onclick="return confirmLink(event,this,&quot;Refresh this account?&quot;,&quot;The account page will reload.&quot;,&quot;Refresh&quot;)">&#8634;</a>'+


      '</div></div>';
    if (isDarlene) hDarlene+=cardHtml; else if (isDanica) hDanica+=cardHtml; else hAiko+=cardHtml;
  }
  document.getElementById('slots-aiko').innerHTML=hAiko || '<div style="text-align:center;color:var(--muted);padding:20px;font-size:12px;">No AIKO slots</div>';
  document.getElementById('slots-danica').innerHTML=hDanica || '<div style="text-align:center;color:var(--muted);padding:20px;font-size:12px;">No DANICA slots</div>';
  document.getElementById('slots-darlene').innerHTML=hDarlene || '<div style="text-align:center;color:var(--muted);padding:20px;font-size:12px;">No DARLENE slots</div>';
  window._lastSlots = slots; // for live timer 1:1 - sync live only, no stale lastUpdate
}

function liveTimerText(start,fallback){if(!start)return fallback||'00:00';var elapsed=Math.max(0,Math.floor((Date.now()-Number(start))/1000));if(elapsed>86400)return fallback||'00:00';var m=Math.floor(elapsed/60),sec=elapsed%60;return(m<10?'0'+m:m)+':'+(sec<10?'0'+sec:sec)}
function fmtWhen(ts){return ts?new Intl.DateTimeFormat('en-PH',{timeZone:PH_TIME_ZONE,month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(ts)):'—'}
function showEncash(id){
  var slot=(window._lastSlots||[]).find(function(x){return String(x.id)===String(id)}),e=slot&&slot.encashment||{},q=slot&&slot.encashmentSchedule||{};
  var decision=e.receivedDecision||'',status=decision==='yes'?'Received':decision==='no'?'Not received':decision==='waiting'?'Waiting':'Answer needed',statusClass=decision==='yes'?'yes':decision==='no'?'no':decision==='waiting'?'waiting':'answer';
  var mask=function(v){v=String(v||'');return v.length>4?'•••• '+v.slice(-4):(v||'—')};
  var money=function(v){v=String(v||'—');return v==='—'?v:(/[₱P]/.test(v)?v:'₱'+v)};
  var kind=String(e.kind||'unknown').toLowerCase(),upcoming=String(q.type||'').toLowerCase(),day=q.weekday==='Wed'?'Wednesday':(q.weekday||'Not scheduled');
  var logs=(e.eventLog||[]).filter(function(x){return !/history check|payout status/i.test(x.text||'')}).slice(-3).reverse().map(function(x){return '<div>'+esc(fmtWhen(x.at))+' · '+esc(x.text)+'</div>'}).join('');
  document.getElementById('encbody').innerHTML='<div class="enchero"><div><small>'+esc(kind==='task'?'Task payout':'Network payout')+'</small><strong>'+esc(money(e.netAmount||e.amount))+'</strong></div><span class="encstatus '+statusClass+'">'+esc(status)+'</span></div>'+
    '<div class="encsummary"><div class="encsum"><b>Gross</b><span>'+esc(money(e.amount))+'</span></div><div class="encsum"><b>Fee / tax</b><span>'+esc(money(e.tax))+'</span></div><div class="encsum net"><b>You receive</b><span>'+esc(money(e.netAmount||e.amount))+'</span></div></div>'+
    '<div class="encdetails"><div class="encdetail"><b>GCash account</b>'+esc(mask(e.payoutNumber))+'</div><div class="encdetail"><b>Reference</b>'+esc(e.reference||'—')+'</div><div class="encdetail"><b>Requested</b>'+esc(e.requestedAt||fmtWhen(e.lastAttemptAt))+'</div><div class="encdetail"><b>Transaction ID</b>'+esc(e.transactionId||'—')+'</div></div>'+
    '<div class="encreceived" style="grid-template-columns:1fr 1fr 1fr"><button class="yes '+(decision==='yes'?'active':'')+'" onclick="confirmReceipt(&quot;yes&quot;)">✓ Received</button><button class="waiting '+(decision==='waiting'?'active':'')+'" onclick="confirmReceipt(&quot;waiting&quot;)">Waiting</button><button class="no '+(decision==='no'?'active':'')+'" onclick="confirmReceipt(&quot;no&quot;)">Not received</button></div>'+
    '<div class="encschedule"><b>Next: '+esc(upcoming==='task'?'Task Encashment':upcoming==='network'?'Network Encashment':'Not configured')+'</b><span>'+esc(day)+(q.startHour!=null&&q.endHour!=null?' · '+esc(q.startHour)+':00–'+esc(q.endHour)+':00 AM PH':'')+'</span></div>'+
    (logs?'<div class="encactivity">'+logs+'</div>':'');
  document.getElementById('encmodal').classList.add('show');
}
function setPayoutReceived(value){fetch('/payout-received?value='+encodeURIComponent(value),{method:'POST'}).then(function(r){if(!r.ok)throw new Error('Save failed');return r.json()}).then(function(){var slot=(window._lastSlots||[]).find(function(x){return String(x.accountName||'').toLowerCase()==='adaihbi'});if(slot&&slot.encashment)slot.encashment.receivedDecision=value;if(slot)showEncash(slot.id)}).catch(function(){alert('Could not save your choice. Please try again.')})}
function closeEncash(){document.getElementById('encmodal').classList.remove('show')}

function openModal(id){ var m=document.getElementById('modal-'+id); if(m) m.classList.add('show'); }
function closeModal(id){ var m=document.getElementById('modal-'+id); if(m) m.classList.remove('show'); }
function poll(){
  fetch('/api/stats?t='+Date.now(),{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){
    try{ render(d); }catch(e){ console.error('render error',e); }
    LD=JSON.stringify(d);
  }).catch(function(e){
    console.error('poll error',e);
    var el=document.getElementById('ltxt');
    if(el) el.textContent='Connection error — '+formatPHTime(new Date())+' PH';
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
  var now=updatePHClock();
  if(el) {
    var txt=el.textContent||'';
    // Only overwrite if it starts with Live or Connection
    if(txt.indexOf('Live')===0 || txt.indexOf('Connection')===0) {
      // Keep Live prefix but update time
      var base=txt.split('—')[0]||'Live ';
      el.textContent=base+'— '+formatPHTime(now)+' PH ('+formatPHDate(now)+')';
    }
  }
},1000);
updatePHClock();
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
    res.end(JSON.stringify({ scannerUp: status.scannerUp, electronProcs: status.electronProcs, loopPaused: status.loopPaused, slots, theme: readJson(THEME_PREF_FILE, { aikoColor: "#725CFF", danicaColor: "#FF4F78", darleneColor: "#00D68F" }) }));
    return;
  }

  if (url.pathname === "/theme-color" && req.method === "POST") {
    const value = String(url.searchParams.get("value") || "").trim().toUpperCase();
    const section = String(url.searchParams.get("section") || "").toLowerCase();
    if (!["aiko","danica","darlene"].includes(section)) { res.writeHead(400); res.end("Invalid section"); return; }
    if (!/^#[0-9A-F]{6}$/.test(value)) { res.writeHead(400); res.end("Invalid hex color"); return; }
    const theme = readJson(THEME_PREF_FILE, {});
    theme[section + "Color"] = value;
    theme.updatedAt = Date.now();
    delete theme.slotColor;
    writeJson(THEME_PREF_FILE, theme);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ok:true,section,color:value}));
    return;
  }
  if (url.pathname === "/payout-received" && req.method === "POST") {
    const value = url.searchParams.get("value");
    if (value !== "yes" && value !== "waiting" && value !== "no") { res.writeHead(400); res.end("Invalid choice"); return; }
    const state = readJson(ENCASHMENT_STATE_FILE, {});
    state.receivedDecision = value;
    state.receivedDecisionAt = Date.now();
    writeJson(ENCASHMENT_STATE_FILE, state);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ok:true,value}));
    return;
  }
  if (url.pathname === "/cmd") {
    const action = url.searchParams.get("action");
    const slot = url.searchParams.get("slot");
    log(`CMD: action=${action} slot=${slot}`);
    try { sendCommands([{ action, slot: slot || "all" }]); }
    catch (e) { res.writeHead(400); res.end('Command could not be queued: ' + e.message); return; }
    res.writeHead(302, { "Location": "/" });
    res.end();
    return;
  }

  if (url.pathname === "/loop") {
    const cmd = url.searchParams.get("cmd");
    if (cmd === "pause" || cmd === "resume") {
      sendCommands([{ action: cmd, slot: "all" }]);
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
