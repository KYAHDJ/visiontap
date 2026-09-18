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
