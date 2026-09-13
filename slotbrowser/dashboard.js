const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PORT = 8080;

function run(cmd) {
  try { return execSync(cmd, { timeout: 10000 }).toString().trim(); }
  catch (e) { return "error"; }
}

function getStats() {
  try {
    const raw = run("curl -s http://127.0.0.1:5566/stats");
    return JSON.parse(raw);
  } catch (e) {
    return { slots: {} };
  }
}

function getStatus() {
  const scannerUp = run("curl -s http://127.0.0.1:5566/health").includes("online");
  const electronProcs = run("ps aux | grep electron | grep -v grep | wc -l");
  const uptime = run("uptime -p");
  const mem = run("free -h | grep Mem | awk '{print $3 \"/\" $2}'");
  const cpu = run("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'");
  const stats = getStats();
  return { scannerUp, electronProcs: parseInt(electronProcs) || 0, uptime, mem, cpu, stats };
}

function buildHTML(status) {
  const scannerColor = status.scannerUp ? "#4ade80" : "#f87171";
  const electronColor = status.electronProcs > 0 ? "#4ade80" : "#f87171";
  const scannerText = status.scannerUp ? "ONLINE" : "OFFLINE";
  const electronText = status.electronProcs > 0 ? "RUNNING" : "STOPPED";

  let slotsHTML = "";
  const slots = status.stats.slots || {};
  const slotNames = Object.keys(slots);
  if (slotNames.length === 0) {
    slotsHTML = '<div style="color:#64748b;font-size:13px;text-align:center;padding:10px">No slot data yet</div>';
  } else {
    for (const name of slotNames) {
      const s = slots[name];
      const total = s.taskCount || 0;
      const correct = s.correctCount || 0;
      const wrong = s.wrongCount || 0;
      const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
      const accColor = accuracy >= 80 ? "#4ade80" : accuracy >= 50 ? "#facc15" : "#f87171";
      const ptsDone = s.pointsDone || 0;
      const ptsTotal = s.pointsTotal || 0;
      const ptsPercent = ptsTotal > 0 ? Math.round((ptsDone / ptsTotal) * 100) : 0;
      const ptsColor = ptsPercent >= 80 ? "#4ade80" : ptsPercent >= 50 ? "#facc15" : "#f87171";
      const withdrawable = s.withdrawable || 0;
      const lastUpdate = s.lastUpdate || "N/A";
      const lastCorrect = s.lastCorrect === true ? '<span style="color:#4ade80">OK</span>' :
                          s.lastCorrect === false ? '<span style="color:#f87171">WRONG</span>' : '<span style="color:#64748b">?</span>';
      slotsHTML += `
      <div class="card" style="margin-bottom:8px">
        <div style="font-weight:600;font-size:14px;margin-bottom:8px;color:#38bdf8">${name}</div>
        <div class="status-row"><span class="label">Tasks Done</span><span class="value">${total}</span></div>
        <div class="status-row"><span class="label">Correct</span><span class="value" style="color:#4ade80">${correct}</span></div>
        <div class="status-row"><span class="label">Wrong</span><span class="value" style="color:#f87171">${wrong}</span></div>
        <div class="status-row"><span class="label">Accuracy</span><span class="value" style="color:${accColor}">${accuracy}%</span></div>
        <div class="status-row"><span class="label">Points</span><span class="value" style="color:${ptsColor}">${ptsDone} / ${ptsTotal}</span></div>
        <div class="status-row"><span class="label">Withdrawable</span><span class="value" style="color:#facc15;font-size:16px">${withdrawable}</span></div>
        <div class="status-row"><span class="label">Last Answer</span><span class="value">${lastCorrect}</span></div>
        <div class="status-row"><span class="label">Updated</span><span class="value" style="font-size:12px;color:#64748b">${lastUpdate}</span></div>
      </div>`;
    }
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VisionTap Cloud</title>
<meta http-equiv="refresh" content="10">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:#0b1020;color:#e2e8f0;padding:16px;max-width:480px;margin:auto}
h1{font-size:18px;text-align:center;margin-bottom:16px;color:#38bdf8}
.card{background:#1e293b;border-radius:10px;padding:14px;margin-bottom:12px;border:1px solid #334155}
.status-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0}
.dot{width:12px;height:12px;border-radius:50%;display:inline-block;margin-right:8px}
.label{font-size:14px;color:#94a3b8}
.value{font-weight:600}
.btn{display:block;width:100%;padding:12px;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:8px}
.btn-green{background:#16a34a;color:white}
.btn-red{background:#dc2626;color:white}
.btn-blue{background:#2563eb;color:white}
.btn-yellow{background:#ca8a04;color:white}
.info{font-size:12px;color:#64748b;text-align:center;margin-top:16px}
h2{font-size:14px;color:#94a3b8;margin:12px 0 8px;text-align:center}
</style></head><body>
<h1>VisionTap Cloud</h1>
<div class="card">
<div class="status-row"><span class="label">Scanner</span><span><span class="dot" style="background:${scannerColor}"></span><span class="value" style="color:${scannerColor}">${scannerText}</span></span></div>
<div class="status-row"><span class="label">VisionTap</span><span><span class="dot" style="background:${electronColor}"></span><span class="value" style="color:${electronColor}">${electronText}</span></span></div>
<div class="status-row"><span class="label">CPU</span><span class="value">${status.cpu}%</span></div>
<div class="status-row"><span class="label">RAM</span><span class="value">${status.mem}</span></div>
<div class="status-row"><span class="label">Uptime</span><span class="value" style="font-size:12px">${status.uptime}</span></div>
</div>
<h2>Earnings</h2>
${slotsHTML}
<h2>Controls</h2>
<div class="card">
<form method="POST" action="/restart"><button class="btn btn-green" type="submit">Restart VisionTap</button></form>
<form method="POST" action="/stop"><button class="btn btn-red" type="submit">Stop Everything</button></form>
</div>
<p class="info">Auto-refreshes every 10s | Oracle Cloud Free Tier</p>
</body></html>`;
}

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  if (req.method === "GET") {
    res.end(buildHTML(getStatus()));
  } else if (req.method === "POST") {
    if (req.url === "/restart") {
      run("sudo systemctl restart visiontap-electron");
      setTimeout(() => res.end(buildHTML(getStatus())), 5000);
    } else if (req.url === "/stop") {
      run("sudo systemctl stop visiontap-electron visiontap-scanner visiontap-dashboard");
      setTimeout(() => res.end(buildHTML(getStatus())), 2000);
    } else {
      res.end(buildHTML(getStatus()));
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard running on http://0.0.0.0:${PORT}`);
});
