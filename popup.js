document.addEventListener('DOMContentLoaded', async () => {
  const scanBtn = document.getElementById('scanBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const statusEl = document.getElementById('status');
  const serverDot = document.getElementById('serverDot');
  const serverLabel = document.getElementById('serverLabel');
  const startTimeEl = document.getElementById('startTime');
  const correctCountEl = document.getElementById('correctCount');
  const wrongCountEl = document.getElementById('wrongCount');
  const errorCountEl = document.getElementById('errorCount');
  const totalCountEl = document.getElementById('totalCount');
  const pointsPerMinEl = document.getElementById('pointsPerMin');

  async function checkServer() {
    try {
      const res = await chrome.runtime.sendMessage({ action: "check_scanner" });
      if (res && res.online) {
        if (serverDot) serverDot.className = 'dot online';
        if (serverLabel) serverLabel.textContent = 'Scanner Server: Online';
        return true;
      }
    } catch (e) {}
    if (serverDot) serverDot.className = 'dot offline';
    if (serverLabel) serverLabel.textContent = 'Scanner Server: Offline';
    return false;
  }

  async function updateStats() {
    try {
      const res = await chrome.runtime.sendMessage({ action: "get_stats" });
      if (res && res.stats) {
        const s = res.stats;
        if (startTimeEl) {
          startTimeEl.textContent = s.startTime ? new Date(s.startTime).toLocaleTimeString() : '--';
        }
        if (correctCountEl) correctCountEl.textContent = s.correct || 0;
        if (wrongCountEl) wrongCountEl.textContent = s.wrong || 0;
        if (errorCountEl) errorCountEl.textContent = s.error || 0;
        if (totalCountEl) totalCountEl.textContent = s.total || 0;
        if (pointsPerMinEl) pointsPerMinEl.textContent = s.pointsPerMinute || 0;
      }
    } catch (e) {}
  }

  await checkServer();
  await updateStats();

  scanBtn.addEventListener('click', async () => {
    try {
      const res = await chrome.runtime.sendMessage({ action: "trigger_scan" });
      if (statusEl) {
        statusEl.innerText = res && res.running ? "Loop Running..." : "Loop Stopped.";
      }
      await updateStats();
    } catch (e) {
      if (statusEl) statusEl.innerText = "Failed to toggle loop.";
    }
  });

  refreshBtn.addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.url && t.url.includes("ecnlmediamarket.com")) {
        chrome.tabs.reload(t.id).catch(() => {});
      }
    }
    if (statusEl) statusEl.innerText = "Page refreshed.";
  });

  setInterval(checkServer, 10000);
  setInterval(updateStats, 5000);
});
