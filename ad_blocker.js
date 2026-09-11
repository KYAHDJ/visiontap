// VisionTap - Universal Ad Blocker
// Runs on every website (<all_urls>). Removes the most common ad / overlay
// / interstitial elements so they never cover the task image or interfere.
// Lightweight & passive: it only removes DOM elements, never navigates.

(function () {
  if (window.__vtAdBlockInstalled) return;
  window.__vtAdBlockInstalled = true;

  const SELECTORS = [
    'iframe[src*="googleads"]',
    'iframe[id*="aswift"]',
    'div[id*="google_ads"]',
    'div[id*="ad_container"]',
    '.adsbygoogle',
    'ins.adsbygoogle',
    'div[class*="adslot"]',
    'div[class*="ad-banner"]',
    'div[class*="advert"]',
    'div[class*="adunit"]',
    '.modal-backdrop',
    '.modal-backdrop.fade',
    '.overlay',
    'div[class*="backdrop"]',
    'div[class*="overlay"]',
    'div[class*="popup"]',
    'div[class*="interstitial"]',
    'div[class*="cookie-banner"]',
    'div[id*="cookie"]',
    'div[class*="consent"]',
    'iframe[src*="ads"]',
    'div[aria-label*="advertisement" i]',
    'div[aria-label*="sponsored" i]'
  ];

  function removeElement(el) {
    try { el.remove(); } catch (e) {}
  }

  function nuke() {
    try {
      SELECTORS.forEach(sel => {
        document.querySelectorAll(sel).forEach(removeElement);
      });
      // Remove fixed-position elements that could overlay content, EXCEPT the
      // VisionTap HUD itself.
      document.querySelectorAll('div').forEach(el => {
        if (el.id && el.id.includes('visiontap-hud')) return;
        try {
          const style = window.getComputedStyle(el);
          if (style.position === 'fixed' && parseInt(style.zIndex || '0', 10) > 100) {
            el.remove();
          }
        } catch (e2) {}
      });
      // Remove video ad players.
      document.querySelectorAll('video[src*="ad"], video[src*="adserve"]').forEach(removeElement);
    } catch (e) {}
  }

  nuke();

  try {
    const observer = new MutationObserver(nuke);
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }
  } catch (e) {}
})();
