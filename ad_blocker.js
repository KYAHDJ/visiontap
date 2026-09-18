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
    'div[aria-label*="sponsored" i]',
    'div[id*="vignette"]',
    'div[class*="vignette"]',
    'iframe[src*="vignette"]',
    'div[data-type="ad"]',
    'div[class*="google-auto"]',
    'amp-ad',
    'ins[data-ad-client]'
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
      // Hide "Unlock more contents - View a short ad" overlay (strict)
      document.querySelectorAll('div, section, aside, span, p, button').forEach(el => {
        try {
          const txt = (el.innerText || '').toLowerCase();
          if (txt.includes('unlock more contents') || txt.includes('view a short ad') || txt.includes('watch ad to unlock') || txt.includes('unlock to continue')) {
            // Check if it's an overlay/modal (centered, fixed, or covers content)
            const style = window.getComputedStyle(el);
            const isOverlay = style.position === 'fixed' || style.position === 'absolute' || parseInt(style.zIndex || '0', 10) > 50;
            const rect = el.getBoundingClientRect();
            const isLargeEnough = rect.width > 200 && rect.height > 100;
            if (isOverlay || isLargeEnough || txt.length < 200) {
              // Don't remove if it's inside input area
              if (el.querySelector && (el.querySelector('input') || el.querySelector('canvas'))) return;
              el.style.display = 'none';
              el.style.visibility = 'hidden';
              el.style.pointerEvents = 'none';
              try { el.remove(); } catch(e) {}
            }
          }
        } catch(e) {}
      });
      // Also hide by common overlay selectors
      ['div[class*="unlock"]', 'div[id*="unlock"]', 'div[class*="ad-overlay"]', 'div[class*="content-lock"]'].forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          const txt = (el.innerText || '').toLowerCase();
          if (txt.includes('unlock') || txt.includes('view a short ad')) {
            try { el.remove(); } catch(e) {}
          }
        });
      });
      // Clean up google_vignette hash from URL
      if (window.location.hash && window.location.hash.includes('google_vignette')) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      // Restore body scroll if locked by ad overlay
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
      document.body.style.position = '';
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
