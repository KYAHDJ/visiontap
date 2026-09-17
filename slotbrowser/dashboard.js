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
    // Earnings are stored by slot id in server.py; also check by name for legacy + fallback
    let hist = slotEarnings[id] || slotEarnings[name] || slotEarnings[`Slot ${id}`] || slotEarnings[`Slot ${Number(id) + 1}`] || null;
    if (!hist || !Array.isArray(hist) || hist.length === 0) {
      // Fallback: if no hist for this id, pick earnings entry with most records
      const allHist = Object.entries(slotEarnings);
      if (allHist.length === 1) hist = allHist[0][1];
      else if (allHist.length > 1) {
        let bestH = hist;
        let maxLen = 0;
        for (const [, v] of allHist) {
          if (Array.isArray(v) && v.length > maxLen) { maxLen = v.length; bestH = v; }
        }
        if (maxLen > 0) hist = bestH;
      }
      if (!Array.isArray(hist)) hist = [];
    }
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
      earningsHistory: displayHist.filter(e => e && e.earning < 10).slice(-20).reverse()
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
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
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:8px}
.card-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.card-nm{font-weight:600;font-size:14px}
.card-bg{font-size:9px;padding:2px 8px;border-radius:10px;font-weight:600}
.sgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:5px;text-align:center;margin-bottom:8px}
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
  <div class="stitle">Slots (<span id="scnt">0</span>)</div>
  <div id="slots"></div>
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
  document.getElementById('scnt').textContent=slots.length;
  document.getElementById('pills').innerHTML=
    '<div class="pill"><div class="dot" style="background:'+(d.scannerUp?'var(--green)':'var(--red)')+'"></div>Scanner '+(d.scannerUp?'Online':'Offline')+'</div>'+
    '<div class="pill"><div class="dot" style="background:'+(d.electronProcs>0?'var(--green)':'var(--red)')+'"></div>Electron '+(d.electronProcs>0?'Running':'Stopped')+'</div>'+
    '<div class="pill"><div class="dot" style="background:'+(d.loopPaused?'var(--yellow)':'var(--green)')+'"></div>Loop '+(d.loopPaused?'Paused':'Running')+'</div>';
  var lb=document.getElementById('lbtn');
  if(d.loopPaused){lb.href='/loop?cmd=resume';lb.textContent='Resume Loop';lb.className='btn bgrn bful'}
  else{lb.href='/loop?cmd=pause';lb.textContent='Pause Loop';lb.className='btn bred bful'}
  var h='';
  for(var i=0;i<slots.length;i++){
    var s=slots[i];
    var sc=s.correctCount>0?'#10b981':(s.wrongCount>0?'#ef4444':'#64748b');
    var st=s.correctCount>0?'Active':(s.wrongCount>0?'Issues':'Idle');
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
    h+='<div class="card">'+
      '<div class="card-hd"><span class="card-nm">'+esc(s.name)+'</span><span class="card-bg" style="background:'+sc+'20;color:'+sc+'">'+st+'</span></div>'+
      '<div class="sgrid">'+
        '<div class="sbox"><div class="sv" style="color:#facc15">&#8369;'+s.withdrawable+'</div><div class="sl">Balance</div></div>'+
        '<div class="sbox"><div class="sv" style="color:#a78bfa">'+pts+'</div><div class="sl">Points</div></div>'+
        '<div class="sbox"><div class="sv" style="color:#38bdf8">'+s.correctCount+'&#10003; '+s.wrongCount+'&#10007;</div><div class="sl">Results</div></div>'+
      '</div>'+
      (s.pointsTotal>0?'<div class="pbar"><div class="pfill" style="width:'+pct+'%"></div></div>':'')+
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
  }
  document.getElementById('slots').innerHTML=h;
}

function poll(){
  fetch('/api/stats').then(function(r){return r.json()}).then(function(d){
    var j=JSON.stringify(d);
    if(j!==LD){LD=j;render(d)}
    document.getElementById('ltxt').textContent='Live \u2014 '+new Date().toLocaleTimeString();
  }).catch(function(){
    document.getElementById('ltxt').textContent='Connection error';
  });
  setTimeout(poll,POLL);
}
poll();
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
