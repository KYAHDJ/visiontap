// VisionTap - Lightweight Ad Blocker
// Removes common ad/overlay elements. Debounced, minimal DOM queries.

(function () {
  if (window.__vtAdBlockInstalled) return;
  window.__vtAdBlockInstalled = true;

  const SELECTORS = [
    'iframe[src*="googleads"]',
    'iframe[id*="aswift"]',
    'div[id*="google_ads"]',
    '.adsbygoogle',
    'ins.adsbygoogle',
    'div[class*="adslot"]',
    'div[class*="ad-banner"]',
    'div[class*="advert"]',
    '.modal-backdrop',
    'div[class*="cookie-banner"]',
    'div[id*="cookie"]',
    'div[class*="consent"]'
  ];

  function nuke() {
    try {
      SELECTORS.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          try { el.remove(); } catch (e) {}
        });
      });
    } catch (e) {}
  }

  nuke();

  // Debounced observer
  let tid = null;
  function debouncedNuke() {
    if (tid) return;
    tid = setTimeout(() => { tid = null; nuke(); }, 800);
  }

  try {
    const observer = new MutationObserver(debouncedNuke);
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    else document.addEventListener('DOMContentLoaded', () => observer.observe(document.body, { childList: true, subtree: true }));
  } catch (e) {}
})();
