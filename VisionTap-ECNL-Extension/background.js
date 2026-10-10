'use strict';
const SCANNER_ORIGIN = 'http://127.0.0.1:5566';

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== 'scanner') return;
  const path = String(message.path || '');
  if (!/^\/(?:health|detect)$/.test(path)) { reply({ ok: false, error: 'Blocked scanner path' }); return; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(15000, Math.max(1000, Number(message.timeout) || 10000)));
  fetch(`${SCANNER_ORIGIN}${path}`, { ...(message.options || {}), signal: controller.signal })
    .then(async response => {
      const body = await response.json().catch(() => ({}));
      reply(response.ok ? { ok: true, body } : { ok: false, error: body.error || `Scanner HTTP ${response.status}` });
    })
    .catch(error => reply({ ok: false, error: error.name === 'AbortError' ? 'Scanner request timed out' : error.message }))
    .finally(() => clearTimeout(timer));
  return true;
});
