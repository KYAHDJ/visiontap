'use strict';
const statusElement = document.getElementById('status');
const metaElement = document.getElementById('meta');
async function activeTab() { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; }
async function refresh() {
  const tab = await activeTab();
  if (!tab?.url?.startsWith('https://ecnlmediamarket.com/')) { statusElement.textContent = 'Open ECNL Media Market first.'; metaElement.textContent = ''; return; }
  chrome.tabs.sendMessage(tab.id, { type: 'status' }, response => {
    if (chrome.runtime.lastError || !response) { statusElement.textContent = 'Reload the ECNL page once after installing.'; return; }
    statusElement.textContent = response.status || 'Ready';
    metaElement.textContent = `${response.tasks || 0} tasks · ${response.errors || 0} errors · ${response.time || '00:00'} · scanner ${response.scannerOnline ? 'online' : 'offline'}`;
  });
}
document.querySelectorAll('button').forEach(button => button.addEventListener('click', async () => {
  const tab = await activeTab(); if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'control', action: button.dataset.action }, () => setTimeout(refresh, 250));
}));
refresh(); setInterval(refresh, 1000);
