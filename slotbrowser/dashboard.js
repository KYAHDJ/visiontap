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
    log(`writeJson OK: ${file}`);
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
function getStatus() {
  const scannerUp = run("curl -s http://127.0.0.1:5566/health").includes("online");
  const electronProcs = parseInt(run("ps aux | grep electron | grep -v grep | wc -l")) || 0;
  const stats = getStats();
  const loopPaused = isLoopPaused();
  return { scannerUp, electronProcs, stats, loopPaused };
}
function getMergedSlots(status) {
  const electronSlots = getElectronSlots();
  const scannerSlots = (status.stats && status.stats.slots) || {};
  const creds = getCreds();
  const merged = [];
  for (const slot of (electronSlots.active || [])) {
    const id = slot.id;
    const name = slot.accountName || slot.name || `Slot ${Number(id) + 1}`;
    const sc = scannerSlots[name] || scannerSlots[`Slot ${Number(id) + 1}`] || {};
    const cred = creds[id] || {};
    merged.push({
      id, name, accountName: slot.accountName || "",
      user: cred.user || "", pass: cred.pass || "",
      correctCount: sc.correctCount || 0,
      wrongCount: sc.wrongCount || 0,
      errorCount: sc.errorCount || 0,
      withdrawable: sc.withdrawable || 0,
      lastUpdate: sc.lastUpdate || ""
    });
  }
  return merged;
}
function sendCommands(cmds) {
  writeJson(SLOT_CMD_FILE, cmds);
  log(`Commands sent: ${JSON.stringify(cmds)}`);
}

function esc(s) { return String(s || "").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/'/g,"&#39;"); }

function buildPage(status) {
  const slots = getMergedSlots(status);
  const history = getHistory();
  const loopText = status.loopPaused ? "PAUSED" : "RUNNING";
  const loopColor = status.loopPaused ? "#f59e0b" : "#10b981";
  const historyOpts = history.users.map(v => `<option value="${esc(v)}">`).join("");

  let slotsHTML = "";
  if (slots.length === 0) {
    slotsHTML = `<div class="empty-state"><p>No slots configured</p><span>Add a slot in Settings</span></div>`;
  } else {
    for (const s of slots) {
      const sc = s.correctCount > 0 ? "#10b981" : (s.wrongCount > 0 ? "#ef4444" : "#64748b");
      const st = s.correctCount > 0 ? "Active" : (s.wrongCount > 0 ? "Issues" : "Idle");
      const sid = encodeURIComponent(s.id);
      slotsHTML += `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <span style="font-weight:600;color:#e2e8f0">${esc(s.name)}</span>
          <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:${sc}20;color:${sc}">${st}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;text-align:center;margin-bottom:10px">
          <div style="background:#0f172a;border-radius:6px;padding:6px"><div style="color:#facc15;font-weight:700">${s.withdrawable}</div><div style="color:#64748b;font-size:10px">Balance</div></div>
          <div style="background:#0f172a;border-radius:6px;padding:6px"><div style="color:#10b981;font-weight:700">${s.correctCount}</div><div style="color:#64748b;font-size:10px">Correct</div></div>
          <div style="background:#0f172a;border-radius:6px;padding:6px"><div style="color:#ef4444;font-weight:700">${s.wrongCount}</div><div style="color:#64748b;font-size:10px">Wrong</div></div>
          <div style="background:#0f172a;border-radius:6px;padding:6px"><div style="color:#f59e0b;font-weight:700">${s.errorCount}</div><div style="color:#64748b;font-size:10px">Error</div></div>
        </div>
        <form class="cred-form" method="GET" action="/save-creds">
          <input type="hidden" name="slot" value="${esc(s.id)}">
          <div class="cred-row">
            <input type="text" name="user" placeholder="Username" value="${esc(s.user)}" list="hu">
            <input type="text" name="pass" placeholder="Password" value="${esc(s.pass)}">
            <button type="submit" class="btn-sm btn-save">Save</button>
          </div>
        </form>
        <div class="slot-actions">
          <a class="icon-btn" href="/cmd?action=pause&slot=${sid}" title="Pause"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg></a>
          <a class="icon-btn" href="/cmd?action=resume&slot=${sid}" title="Resume"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg></a>
          <a class="icon-btn" href="/cmd?action=restart&slot=${sid}" title="Restart"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></a>
          <a class="icon-btn" href="/cmd?action=refresh&slot=${sid}" title="Refresh"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></a>
          <a class="icon-btn danger" href="/cmd?action=remove&slot=${sid}" onclick="return confirm('Remove this slot?')" title="Remove"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></a>
        </div>
      </div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VisionTap Control</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0e1a;--card:#111827;--border:#1e293b;--text:#e2e8f0;--muted:#64748b;--accent:#38bdf8;--green:#10b981;--red:#ef4444;--yellow:#f59e0b;--purple:#a78bfa}
body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.container{max-width:500px;margin:0 auto;padding:20px 16px}
h1{font-size:20px;text-align:center;color:var(--accent);margin-bottom:16px}
.status-bar{display:flex;gap:6px;margin-bottom:16px;justify-content:center;flex-wrap:wrap}
.status-pill{display:flex;align-items:center;gap:5px;padding:5px 12px;border-radius:16px;font-size:11px;font-weight:500;background:var(--card);border:1px solid var(--border)}
.status-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.section-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin:16px 0 8px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px}
.btn{display:block;width:100%;padding:10px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;text-align:center}
.btn:hover{opacity:0.85}
.btn-green{background:var(--green);color:#fff}
.btn-red{background:var(--red);color:#fff}
.btn-yellow{background:var(--yellow);color:#000}
.btn-purple{background:var(--purple);color:#fff}
.btn-full{grid-column:span 2}
.icon-btn{width:28px;height:28px;border:none;border-radius:5px;background:#0f172a;color:var(--muted);cursor:pointer;font-size:12px;display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
.icon-btn:hover{color:var(--text);background:#1a2332}
.icon-btn.danger:hover{color:var(--red)}
.global-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px}
.cred-row{display:flex;gap:4px;margin-bottom:8px}
.cred-row input{flex:1;padding:5px 8px;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:5px;font-size:12px}
.btn-sm{padding:5px 10px;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap}
.btn-save{background:var(--green);color:#fff}
.btn-save:hover{opacity:0.85}
.slot-actions{display:flex;gap:4px;justify-content:flex-end}
.empty-state{text-align:center;padding:30px;color:var(--muted)}
.empty-state p{font-size:14px;color:var(--text)}
.footer{text-align:center;padding:16px 0;font-size:11px;color:#334155}
</style></head><body>
<div class="container">
  <h1>VisionTap Control</h1>
  <div class="status-bar">
    <div class="status-pill"><div class="status-dot" style="background:${status.scannerUp?'var(--green)':'var(--red)'}"></div>Scanner ${status.scannerUp?'Online':'Offline'}</div>
    <div class="status-pill"><div class="status-dot" style="background:${status.electronProcs>0?'var(--green)':'var(--red)'}"></div>Electron ${status.electronProcs>0?'Running':'Stopped'}</div>
    <div class="status-pill"><div class="status-dot" style="background:${loopColor}"></div>Loop ${loopText}</div>
  </div>

  <div class="section-title">Global Controls</div>
  <div class="global-grid">
    <a class="btn btn-green" href="/cmd?action=resume&slot=all">▶ Resume All</a>
    <a class="btn btn-red" href="/cmd?action=pause&slot=all">⏸ Pause All</a>
    <a class="btn btn-yellow" href="/cmd?action=restart&slot=all">↻ Restart All Pages</a>
    <a class="btn btn-purple" href="/cmd?action=refresh&slot=all">⟳ Refresh All</a>
    <a class="btn btn-red btn-full" href="/cmd?action=remove&slot=all" onclick="return confirm('Remove ALL slots?')">✕ Remove All Slots</a>
  </div>

  <div class="section-title">Loop</div>
  <div class="global-grid">
    ${status.loopPaused
      ? `<a class="btn btn-green" href="/loop?cmd=resume">▶ Resume Loop</a>`
      : `<a class="btn btn-red" href="/loop?cmd=pause">⏸ Pause Loop</a>`}
  </div>

  <div class="section-title">Slots (${slots.length})</div>
  <div id="slots">${slotsHTML}</div>

  <div class="section-title">Server</div>
  <div class="global-grid">
    <a class="btn btn-green btn-full" href="/restart" onclick="return confirm('Restart VisionTap?')">⟳ Restart VisionTap</a>
  </div>
  <div class="footer">Auto-refreshes every 10s</div>
</div>
<datalist id="hu">${historyOpts}</datalist>
<meta http-equiv="refresh" content="10">
</body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  log(`${req.method} ${url.pathname} ${url.search || ""}`);

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

  // GET-based slot commands
  if (url.pathname === "/cmd") {
    const action = url.searchParams.get("action");
    const slot = url.searchParams.get("slot");
    log(`CMD: action=${action} slot=${slot}`);
    sendCommands([{ action, slot: slot || "all" }]);
    res.writeHead(302, { "Location": "/" });
    res.end();
    return;
  }

  // GET-based loop control
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

  // GET-based credential save
  if (url.pathname === "/save-creds") {
    const slot = url.searchParams.get("slot");
    const user = url.searchParams.get("user") || "";
    const pass = url.searchParams.get("pass") || "";
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

  // GET-based restart
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
  res.setHeader("Pragma", "no-cache");
  res.end(buildPage(getStatus()));
});

server.listen(PORT, "0.0.0.0", () => {
  log(`Dashboard running on http://0.0.0.0:${PORT}`);
});
