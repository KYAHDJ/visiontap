document.addEventListener('DOMContentLoaded', async () => {
  const scanBtn = document.getElementById('scanBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const statusEl = document.getElementById('status');
  const serverDot = document.getElementById('serverDot');
  const serverLabel = document.getElementById('serverLabel');

  async function checkServer() {
    try {
      const res = await chrome.runtime.sendMessage({ action: "check_scanner" });
      if (res && res.online) {
        serverDot.className = 'dot online';
        serverLabel.textContent = 'Scanner Server: Online';
        return true;
      }
    } catch (e) {}
    serverDot.className = 'dot offline';
    serverLabel.textContent = 'Scanner Server: Offline';
    return false;
  }

  await checkServer();

  scanBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.runtime.sendMessage({ action: "trigger_scan", tabId: tab.id });
      statusEl.innerText = "Toggling loop...";
    }
  });

  refreshBtn.addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.url && t.url.includes("ecnlmediamarket.com")) {
        chrome.tabs.reload(t.id).catch(() => {});
      }
    }
    statusEl.innerText = "ECNL page(s) refreshing...";
  });

  setInterval(checkServer, 5000);
});
