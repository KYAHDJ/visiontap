// VisionTap - Minimal Ad Blocker
// Only removes third-party ad iframes. Does NOT touch site UI.

(function () {
  if (window.__vtAdBlockInstalled) return;
  window.__vtAdBlockInstalled = true;

  function nuke() {
    try {
      document.querySelectorAll('iframe').forEach(el => {
        try {
          const src = (el.src || '').toLowerCase();
          if (src.includes('googleads') || src.includes('doubleclick') || src.includes('adservice')) {
            el.remove();
          }
        } catch (e) {}
      });
      // Hide Unlock more contents overlay
      document.querySelectorAll('div, section, aside, span, p, button').forEach(el => {
        try {
          const txt = (el.innerText || '').toLowerCase();
          if (txt.includes('unlock more contents') || txt.includes('view a short ad') || txt.includes('watch ad to unlock')) {
            const style = window.getComputedStyle(el);
            const isOverlay = style.position === 'fixed' || style.position === 'absolute' || parseInt(style.zIndex||'0',10) > 50;
            const rect = el.getBoundingClientRect();
            if (isOverlay || (rect.width>200 && rect.height>100) || txt.length<200) {
              if (el.querySelector && (el.querySelector('input') || el.querySelector('canvas'))) return;
              el.style.display='none'; el.style.visibility='hidden'; el.style.pointerEvents='none';
              try{el.remove();}catch(e){}
            }
          }
        } catch(e){}
      });
    } catch (e) {}
  }

  nuke();

  let tid = null;
  function debouncedNuke() {
    if (tid) return;
    tid = setTimeout(() => { tid = null; nuke(); }, 2000);
  }

  try {
    const observer = new MutationObserver(debouncedNuke);
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    else document.addEventListener('DOMContentLoaded', () => observer.observe(document.body, { childList: true, subtree: true }));
  } catch (e) {}
})();
