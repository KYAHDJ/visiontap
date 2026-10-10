(() => {
  'use strict';
  if (window.__visionTapEcnlLoaded) return;
  window.__visionTapEcnlLoaded = true;

  const WORK_PATH = '/solving-colors';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const state = {
    enabled: true, running: false, verification: false, scannerOnline: false,
    status: 'Starting…', tasks: 0, errors: 0, startedAt: Date.now(),
    pending: null, lastHash: '', detectFails: 0, noImage: 0, notReadySince: 0,
    processing: false, stopped: false
  };

  function publish() {
    const elapsed = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
    const time = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
    chrome.storage.local.set({ vtEcnlStatus: {
      enabled: state.enabled, running: state.running, verification: state.verification,
      scannerOnline: state.scannerOnline, status: state.status, tasks: state.tasks,
      errors: state.errors, time, url: location.href, updatedAt: Date.now()
    }});
    updateBadge(time);
  }

  function setStatus(message) { state.status = message; publish(); }

  function visible(element) {
    if (!element) return false;
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function verificationVisible() {
    const text = (document.body?.innerText || '').toLowerCase();
    return /verify you are human|performing security verification|checking your browser|security check|just a moment/.test(text) ||
      !!document.querySelector('iframe[src*="challenges.cloudflare.com"],iframe[src*="/cdn-cgi/challenge-platform"],input[name="cf-turnstile-response"],.cf-turnstile');
  }

  function loginVisible() {
    return /\/login/i.test(location.pathname) || !!Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
  }

  function findAnswerInput() {
    const inputs = Array.from(document.querySelectorAll('input,textarea')).filter(visible);
    return inputs.find(element => /type|answer/i.test(`${element.placeholder || ''} ${element.getAttribute('aria-label') || ''}`)) ||
      inputs.find(element => element.getBoundingClientRect().width > 100 && element.getBoundingClientRect().height > 30) || null;
  }

  function findSubmitButton() {
    return Array.from(document.querySelectorAll('button,input[type="submit"],a.btn,[role="button"]'))
      .find(element => visible(element) && /submit|solve|answer/i.test(element.textContent || element.value || '')) || null;
  }

  function checkingState() {
    return Array.from(document.querySelectorAll('button')).some(button => /checking|encoded solutions/i.test(button.textContent || ''));
  }

  function removeAds() {
    const selectors = [
      'iframe[src*="googleads"]','iframe[src*="doubleclick"]','iframe[id*="aswift"]',
      'div[id*="google_ads"]','div[id*="ad_container"]','.adsbygoogle','ins.adsbygoogle',
      'div[class*="adslot"]','div[class*="ad-banner"]','div[class*="advert"]',
      '[aria-label*="advertisement" i]','#google_vignette','.google-auto-placed',
      'div[class*="allow-ads"]','div[id*="allow-ads"]','div[class*="please-allow"]'
    ];
    for (const selector of selectors) document.querySelectorAll(selector).forEach(element => element.remove());
    document.querySelectorAll('div,section,aside').forEach(element => {
      const text = (element.innerText || '').toLowerCase();
      if (/unlock more contents|view a short ad|watch ad to unlock|please allow ads|disable.{0,12}ad.?block/.test(text) && text.length < 500) element.remove();
    });
  }

  async function grabTaskImage() {
    if (!findAnswerInput()) return null;
    for (const canvas of document.querySelectorAll('canvas')) {
      const rect = canvas.getBoundingClientRect();
      if (canvas.width >= 100 && canvas.height >= 100 && rect.top + rect.height / 2 > innerHeight * .15 && rect.top + rect.height / 2 < innerHeight * .85) {
        try { return canvas.toDataURL('image/png'); } catch (_) {}
      }
    }
    const bad = ['avatar','logo','profile','icon','brand','header','banner','favicon','loading','spinner','placeholder','watermark','social'];
    let best = null, score = -Infinity;
    for (const image of document.querySelectorAll('img')) {
      const source = `${image.src || ''} ${image.alt || ''} ${image.title || ''}`.toLowerCase();
      if (bad.some(word => source.includes(word))) continue;
      const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
      if (width < 100 || height < 100 || width > 1200 || height > 1200) continue;
      const rect = image.getBoundingClientRect(), ratio = width / Math.max(height, 1);
      let candidate = width >= 200 && width <= 800 ? 10 : 0;
      if (ratio >= 1.4 && ratio <= 3) candidate += 20;
      if (rect.top + rect.height / 2 > innerHeight * .2 && rect.top + rect.height / 2 < innerHeight * .8) candidate += 30;
      if (/magic-colors|magiccount/i.test(image.src)) candidate += 100;
      if (candidate > score) { score = candidate; best = image; }
    }
    if (!best) return null;
    if (best.src.startsWith('data:image')) return best.src;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = best.naturalWidth || best.width; canvas.height = best.naturalHeight || best.height;
      canvas.getContext('2d').drawImage(best, 0, 0);
      return canvas.toDataURL('image/png');
    } catch (_) { return null; }
  }

  function hashImage(data) {
    let hash = 0; const step = Math.max(1, Math.floor(data.length / 512));
    for (let index = 0; index < data.length; index += step) hash = (hash * 31 + data.charCodeAt(index)) | 0;
    return String(hash);
  }

  async function scanner(path, options = {}, timeout = 12000) {
    const response = await chrome.runtime.sendMessage({ type: 'scanner', path, options, timeout });
    if (!response?.ok) throw new Error(response?.error || 'Scanner request failed');
    return response.body;
  }

  async function fillAndSubmit(answer, expectedImage) {
    const input = findAnswerInput(), button = findSubmitButton();
    if (!input || !button || !visible(input) || !visible(button) || input.disabled || button.disabled) return false;
    if (checkingState() || await grabTaskImage() !== expectedImage) return false;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (descriptor?.set) descriptor.set.call(input, answer); else input.value = answer;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (!state.enabled || verificationVisible() || await grabTaskImage() !== expectedImage) return false;
    button.click();
    return true;
  }

  async function iteration() {
    removeAds();
    state.verification = verificationVisible();
    if (state.verification) { state.running = false; setStatus('Manual verification required. Complete it on this page.'); return; }
    if (!state.enabled) { state.running = false; setStatus('Paused'); return; }
    if (loginVisible()) { state.running = false; setStatus('Login required. Sign in manually.'); return; }
    if (location.pathname !== WORK_PATH) { state.running = false; setStatus('Open the ECNL color-task page to begin.'); return; }
    try { state.scannerOnline = (await scanner('/health', {}, 2500)).status === 'online'; }
    catch (_) { state.scannerOnline = false; state.running = false; setStatus('Local VisionTap scanner is offline.'); return; }
    state.running = true;
    const input = findAnswerInput(), button = findSubmitButton();
    if (!input || !button || checkingState()) {
      state.notReadySince ||= Date.now();
      setStatus('Waiting for the task controls…');
      if (Date.now() - state.notReadySince > 15000) location.reload();
      return;
    }
    state.notReadySince = 0;
    const image = await grabTaskImage();
    if (!image) {
      state.noImage++; setStatus(`Waiting for task image (${state.noImage}/3)…`);
      if (state.noImage >= 3) location.reload();
      return;
    }
    state.noImage = 0;
    const hash = hashImage(image);
    if (hash === state.lastHash) { setStatus('Waiting for the next task…'); return; }
    if (!state.pending || state.pending.hash !== hash) {
      setStatus('Detecting color…');
      let result;
      try { result = await scanner('/detect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image }) }); }
      catch (error) { result = { error: error.message }; }
      if (!result.color || result.color === 'unknown') {
        state.detectFails++; state.errors++; setStatus(`Color not detected (${state.detectFails}/3): ${result.error || 'unknown'}`);
        if (state.detectFails >= 3) location.reload();
        return;
      }
      state.detectFails = 0; state.pending = { hash, image, answer: result.color };
    }
    setStatus(`Submitting ${state.pending.answer}…`);
    if (await fillAndSubmit(state.pending.answer, state.pending.image)) {
      state.tasks++; state.lastHash = state.pending.hash; state.pending = null;
      setStatus(`Task ${state.tasks} submitted. Waiting for the next task…`);
      await sleep(2000);
    }
  }

  function ensureBadge() {
    if (document.getElementById('vt-ecnl-badge')) return;
    const badge = document.createElement('div'); badge.id = 'vt-ecnl-badge';
    badge.style.cssText = 'position:fixed;right:12px;top:12px;z-index:2147483647;background:#101023;color:#f7f5ff;border:1px solid #725cff;border-radius:10px;padding:9px 11px;font:12px system-ui;box-shadow:0 8px 28px #0008;max-width:280px';
    badge.innerHTML = '<b style="color:#9e92ff">VisionTap ECNL</b><div id="vt-ecnl-status" style="margin-top:4px">Starting…</div><small id="vt-ecnl-stats" style="color:#aaa6c2"></small>';
    document.documentElement.appendChild(badge);
  }
  function updateBadge(time) {
    ensureBadge();
    const status = document.getElementById('vt-ecnl-status'), stats = document.getElementById('vt-ecnl-stats');
    if (status) status.textContent = state.status;
    if (stats) stats.textContent = `${state.tasks} tasks · ${state.errors} errors · ${time}`;
  }

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type === 'status') { publish(); chrome.storage.local.get('vtEcnlStatus', value => reply(value.vtEcnlStatus)); return true; }
    if (message?.type === 'control') {
      if (message.action === 'pause') { state.enabled = false; state.pending = null; chrome.storage.local.set({ vtEcnlEnabled: false }); }
      if (message.action === 'resume') { state.enabled = true; chrome.storage.local.set({ vtEcnlEnabled: true }); }
      if (message.action === 'reload') location.reload();
      setStatus(state.enabled ? 'Resuming…' : 'Paused'); reply({ ok: true });
    }
  });

  chrome.storage.local.get({ vtEcnlEnabled: true }, value => { state.enabled = value.vtEcnlEnabled !== false; publish(); });
  const observer = new MutationObserver(() => removeAds());
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  setInterval(publish, 1000);
  (async function loop() {
    while (!state.stopped) {
      if (!state.processing) {
        state.processing = true;
        try { await iteration(); } catch (error) { state.errors++; setStatus(`Error: ${error.message}`); }
        finally { state.processing = false; }
      }
      await sleep(state.verification ? 1500 : 750);
    }
  })();
})();
