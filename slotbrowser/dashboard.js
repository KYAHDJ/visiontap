const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PORT = 8080;

function run(cmd) {
  try { return execSync(cmd, { timeout: 10000 }).toString().trim(); }
  catch (e) { return "error"; }
}

function getStatus() {
  const scannerUp = run("curl -s http://127.0.0.1:5566/health").includes("online");
  const electronProcs = run("ps aux | grep electron | grep -v grep | wc -l");
  const screenSession = run("screen -ls | grep visiontap | head -1");
  const uptime = run("uptime -p");
  const mem = run("free -h | grep Mem | awk '{print $3 \"/\" $2}'");
  const cpu = run("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'");
  return { scannerUp, electronProcs: parseInt(electronProcs) || 0, screenSession, uptime, mem, cpu };
}

function buildHTML(status) {
  const scannerColor = status.scannerUp ? "#4ade80" : "#f87171";
  const electronColor = status.electronProcs > 0 ? "#4ade80" : "#f87171";
  const scannerText = status.scannerUp ? "ONLINE" : "OFFLINE";
  const electronText = status.electronProcs > 0 ? "RUNNING" : "STOPPED";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VisionTap Cloud</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:#0b1020;color:#e2e8f0;padding:16px;max-width:480px;margin:auto}
h1{font-size:18px;text-align:center;margin-bottom:16px;color:#38bdf8}
.card{background:#1e293b;border-radius:10px;padding:14px;margin-bottom:12px;border:1px solid #334155}
.status-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0}
.dot{width:12px;height:12px;border-radius:50%;display:inline-block;margin-right:8px}
.label{font-size:14px;color:#94a3b8}
.value{font-weight:600}
.btn{display:block;width:100%;padding:12px;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:8px}
.btn-green{background:#16a34a;color:white}
.btn-red{background:#dc2626;color:white}
.btn-blue{background:#2563eb;color:white}
.btn-yellow{background:#ca8a04;color:white}
.info{font-size:12px;color:#64748b;text-align:center;margin-top:16px}
</style></head><body>
<h1>VisionTap Cloud</h1>
<div class="card">
<div class="status-row"><span class="label">Scanner</span><span><span class="dot" style="background:${scannerColor}"></span><span class="value" style="color:${scannerColor}">${scannerText}</span></span></div>
<div class="status-row"><span class="label">VisionTap</span><span><span class="dot" style="background:${electronColor}"></span><span class="value" style="color:${electronColor}">${electronText}</span></span></div>
<div class="status-row"><span class="label">CPU</span><span class="value">${status.cpu}%</span></div>
<div class="status-row"><span class="label">RAM</span><span class="value">${status.mem}</span></div>
<div class="status-row"><span class="label">Uptime</span><span class="value" style="font-size:12px">${status.uptime}</span></div>
</div>
<h1 style="font-size:14px;margin-bottom:8px">Controls</h1>
<form method="POST" action="/restart"><button class="btn btn-green" type="submit">Restart VisionTap</button></form>
<form method="POST" action="/start"><button class="btn btn-blue" type="submit">Start Scanner + VisionTap</button></form>
<form method="POST" action="/stop"><button class="btn btn-red" type="submit">Stop Everything</button></form>
<form method="POST" action="/refresh"><button class="btn btn-yellow" type="submit">Refresh Page</button></form>
<p class="info">Auto-refreshes every 10s | Oracle Cloud Free Tier</p>
</body></html>`;
}

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  if (req.method === "GET") {
    res.end(buildHTML(getStatus()));
  } else if (req.method === "POST") {
    if (req.url === "/restart") {
      run("pkill -f electron");
      run("sleep 2");
      run("screen -dmS visiontap bash -c 'export DISPLAY=:1; cd /home/opc/visiontap/slotbrowser; npx electron . --no-sandbox --disable-gpu'");
      setTimeout(() => res.end(buildHTML(getStatus())), 3000);
    } else if (req.url === "/start") {
      run("cd /home/opc/visiontap/pcapp/scanner && nohup python3 server.py > /tmp/scanner.log 2>&1 &");
      run("sleep 2");
      run("screen -dmS visiontap bash -c 'export DISPLAY=:1; cd /home/opc/visiontap/slotbrowser; npx electron . --no-sandbox --disable-gpu'");
      setTimeout(() => res.end(buildHTML(getStatus())), 5000);
    } else if (req.url === "/stop") {
      run("pkill -f server.py");
      run("pkill -f electron");
      setTimeout(() => res.end(buildHTML(getStatus())), 2000);
    } else if (req.url === "/refresh") {
      res.end(buildHTML(getStatus()));
    } else {
      res.end(buildHTML(getStatus()));
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard running on http://0.0.0.0:${PORT}`);
});
