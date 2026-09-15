// VisionTap Slot - Injected page script.
// EXACT clone of VisionTapColor task_script.js behavior + Electron HUD/host bridge.

(function () {
  if (window.__vtapi) return;
  const vt = {};

  const host = (window.__vtHost) || null;
  const signal = (msg) => { if (host && host.signal) { try { host.signal(msg); } catch (e) {} } };

  const COLOR_WORK_URL = "https://ecnlmediamarket.com/solving-colors";
  const WORK_RE = /\/solving-colors/;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---- Stay on work page (colors or math) ----
  try {
    const href = window.location.href;
    const AUTH_HINTS = ['login', 'signin', 'auth', 'account', 'password'];
    const isAuthPage = AUTH_HINTS.some(h => href.toLowerCase().includes(h));
    if (href.includes("ecnlmediamarket.com") && !isAuthPage && !WORK_RE.test(href)) {
      window.location.href = COLOR_WORK_URL;
    }
  } catch (e) {}

  // ---- EXACT Chrome extension: findAnswerInput ----
  function findAnswerInput() {
    const inputs = Array.from(document.querySelectorAll('input, textarea'));
    return inputs.find(el => {
      const p = ((el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
      return p.includes('type') || p.includes('answer');
    }) || inputs[0] || null;
  }

  // ---- EXACT Chrome extension: findSubmitButton ----
  function findSubmitButton() {
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'));
    return btns.find(b => {
      const txt = (b.textContent || b.value || '').toLowerCase();
      return txt.includes('submit') || txt.includes('solve') || txt.includes('answer');
    });
  }

  // ---- EXACT Chrome extension: isUIFullyLoaded ----
  function isUIFullyLoaded() {
    const input = findAnswerInput();
    const btn = findSubmitButton();
    if (!input || !btn) return false;
    const inputRect = input.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    return inputRect.width > 0 && inputRect.height > 0 && btnRect.width > 0 && btnRect.height > 0;
  }

  // ---- EXACT Chrome extension: grabTaskImage ----
  async function grabTaskImage() {
    if (!isUIFullyLoaded()) return null;

    // 1. Try canvas elements first (many task sites render on canvas)
    const canvases = Array.from(document.querySelectorAll('canvas'));
    for (const cvs of canvases) {
      const rect = cvs.getBoundingClientRect ? cvs.getBoundingClientRect() : null;
      if (!rect) continue;
      // Skip tiny canvases (icons, decorations)
      if (cvs.width < 100 || cvs.height < 100) continue;
      // Skip canvases inside header/nav
      let skip = false;
      let el = cvs.parentElement;
      for (let i = 0; i < 6 && el; i++) {
        const tag = (el.tagName || '').toLowerCase();
        const cls = (el.className || '').toLowerCase();
        if (tag === 'header' || tag === 'nav' || cls.includes('header') || cls.includes('nav') || cls.includes('topbar')) {
          skip = true; break;
        }
        el = el.parentElement;
      }
      if (skip) continue;
      // Prefer canvases in the middle of the viewport
      const viewH = window.innerHeight || 800;
      const centerY = rect.top + rect.height / 2;
      const relY = centerY / viewH;
      if (relY > 0.15 && relY < 0.85) {
        try {
          return cvs.toDataURL('image/png');
        } catch (e) {}
      }
    }

    // 2. Try img elements
    const imgs = Array.from(document.querySelectorAll('img'));
    let targetImg = imgs.find(img => /magic-colors|magiccount/i.test(img.src));

    if (!targetImg) {
      const badKeywords = ['avatar', 'logo', 'profile', 'icon', 'ecnl', 'ec&l', 'ec and l', 'brand', 'header', 'banner', 'favicon', 'loading', 'spinner', 'default', 'placeholder', 'watermark', 'gold', 'shine', 'gradient', 'social', 'share', 'follow'];
      
      let bestImg = null;
      let bestScore = -100;
      
      for (const img of imgs) {
        const src = (img.src || '').toLowerCase();
        const alt = (img.alt || '').toLowerCase();
        const title = (img.title || '').toLowerCase();
        const parent = (img.parentElement && img.parentElement.className || '').toLowerCase();
        const grandparent = (img.parentElement && img.parentElement.parentElement && img.parentElement.parentElement.className || '').toLowerCase();
        const rect = img.getBoundingClientRect ? img.getBoundingClientRect() : null;
        
        if (badKeywords.some(kw => src.includes(kw) || alt.includes(kw) || title.includes(kw) || parent.includes(kw) || grandparent.includes(kw))) continue;
        if (img.src && img.src.startsWith('data:image') && img.src.length < 5000) continue;
        
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (w < 100 || h < 100 || w > 1200 || h > 1200) continue;
        
        let skipParent = false;
        let el = img.parentElement;
        for (let i = 0; i < 8 && el; i++) {
          const tag = (el.tagName || '').toLowerCase();
          const cls = (el.className || '').toLowerCase();
          if (tag === 'header' || tag === 'nav' || tag === 'a' || cls.includes('header') || cls.includes('nav') || cls.includes('topbar') || cls.includes('toolbar') || cls.includes('logo') || cls.includes('brand') || cls.includes('sidebar')) {
            skipParent = true; break;
          }
          el = el.parentElement;
        }
        if (skipParent) continue;
        
        let score = 0;
        if (rect) {
          const viewH = window.innerHeight || 800;
          const centerY = rect.top + rect.height / 2;
          const relY = centerY / viewH;
          if (relY > 0.25 && relY < 0.75) score += 30;
          else if (relY > 0.15 && relY < 0.85) score += 10;
          else score -= 20;
        }
        
        const aspect = w / Math.max(h, 1);
        if (aspect > 0.7 && aspect < 1.4) score -= 50;
        if (aspect >= 1.4 && aspect <= 3.0) score += 20;
        if (aspect > 3.0) score += 10;
        if (w >= 200 && w <= 800) score += 10;
        
        if (score > bestScore) {
          bestScore = score;
          bestImg = img;
        }
      }
      
      targetImg = bestImg;
    }

    if (!targetImg || targetImg.naturalWidth < 100) return null;

    if (targetImg.src.startsWith('data:image')) {
      return targetImg.src;
    }

    try {
      const canvas = document.createElement('canvas');
      canvas.width = targetImg.naturalWidth || targetImg.width || 600;
      canvas.height = targetImg.naturalHeight || targetImg.height || 400;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(targetImg, 0, 0);
      return canvas.toDataURL('image/png');
    } catch (e) {
      return null;
    }
  }

  // ---- EXACT Chrome extension: pasteAndSubmit ----
  async function pasteAndSubmit(answerColor) {
    if (!isUIFullyLoaded()) return { status: "not-loaded" };

    try {
      await navigator.clipboard.writeText(answerColor);
    } catch (e) {}

    const inputBox = findAnswerInput();
    if (!inputBox) return { status: "no-input" };

    inputBox.focus();
    inputBox.click();

    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(inputBox, answerColor);

    inputBox.dispatchEvent(new Event('input', { bubbles: true }));
    inputBox.dispatchEvent(new Event('change', { bubbles: true }));

    setTimeout(() => {
      const btn = findSubmitButton();
      if (btn) {
        btn.click();
      } else {
        inputBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      }
    }, 200);
    return { status: "filled" };
  }

  // ---- EXACT Chrome extension: 60-Second Inactivity Reload Watchdog ----
  // REMOVED for battery saving — only reload on actual stall detection

  // ---- EXACT Chrome extension: ad_blocker nuke (DOM removal, same as ad_blocker.js) ----
  const AD_SELECTORS = [
    'iframe[src*="googleads"]', 'iframe[id*="aswift"]',
    'div[id*="google_ads"]', 'div[id*="ad_container"]',
    '.adsbygoogle', 'ins.adsbygoogle', 'div[class*="adslot"]',
    'div[class*="ad-banner"]', 'div[class*="advert"]', 'div[class*="adunit"]',
    '.modal-backdrop', '.modal-backdrop.fade',
    '.overlay', 'div[class*="backdrop"]', 'div[class*="overlay"]',
    'div[class*="popup"]', 'div[class*="interstitial"]',
    'div[class*="cookie-banner"]', 'div[id*="cookie"]',
    'div[class*="consent"]', 'iframe[src*="ads"]',
    'div[aria-label*="advertisement" i]', 'div[aria-label*="sponsored" i]'
  ];

  function nukeAds() {
    try {
      AD_SELECTORS.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          try { el.remove(); } catch (e) {}
        });
      });
      document.querySelectorAll('div').forEach(el => {
        if (el.id && el.id.includes('visiontap-hud')) return;
        try {
          const style = window.getComputedStyle(el);
          if (style.position === 'fixed' && parseInt(style.zIndex || '0', 10) > 100) {
            el.remove();
          }
        } catch (e2) {}
      });
      document.querySelectorAll('video[src*="ad"], video[src*="adserve"]').forEach(el => {
        try { el.remove(); } catch (e) {}
      });
    } catch (e) {}
  }

  nukeAds();
  let _adObserver = null;
  let _nukeCount = 0;
  try {
    _adObserver = new MutationObserver(() => {
      _nukeCount++;
      if (_nukeCount > 10) {
        if (_adObserver) _adObserver.disconnect();
        return;
      }
      nukeAds();
    });
    if (document.body) {
      _adObserver.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        if (document.body) _adObserver.observe(document.body, { childList: true, subtree: true });
      });
    }
  } catch (e) {}

  // ---- Auto-login (Electron-specific) ----
  (async function autoLogin() {
    try {
      const h = window.location.href.toLowerCase();
      const hasPass = !!(document && document.querySelector('input[type="password"]'));
      const isLogin = /login|signin|sign-in|log-in|auth/i.test(h) || hasPass;
      if (!isLogin) return;

      const pickUser = () => document.querySelector(
        'input[type="email"], input[type="text"], input[type="tel"], input[name*="user" i], input[name*="email" i], input[name*="phone" i], input[name*="username" i]');
      const pickPass = () => document.querySelector('input[type="password"]');
      const setVal = (el, val) => {
        const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        el.focus(); el.click();
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const pickLoginBtn = () => {
        const text = /log\s?in|sign\s?in|signin|login|submit|enter/i;
        const els = Array.from(document.querySelectorAll('input[type="submit"], button[type="submit"], button, input[type="button"]'));
        return els.find(el => {
          const t = (el.value || el.innerText || el.textContent || "").trim();
          return el.type === "submit" || text.test(t);
        }) || null;
      };

      const creds = window.__vtCreds || null;
      if (!creds || !creds.user || !creds.pass) {
        return;
      }

      for (let attempt = 0; attempt < 10; attempt++) {
        const user = pickUser();
        const pass = pickPass();
        if (user && pass) {
          setVal(user, creds.user);
          setVal(pass, creds.pass);
          signal({ type: "vt_log", msg: `Auto-login attempt ${attempt + 1}` });
          await sleep(500);
          const btn = pickLoginBtn();
          if (btn) {
            btn.click();
            await sleep(3000);
            const AUTH_HINTS = ['login', 'signin', 'auth', 'account', 'password'];
            const stillAuth = AUTH_HINTS.some(h2 => window.location.href.toLowerCase().includes(h2));
            if (stillAuth) continue;
            if (!WORK_RE.test(window.location.href)) {
              window.location.href = COLOR_WORK_URL;
            }
            return;
          }
        }
        await sleep(1500);
      }

      if (!WORK_RE.test(window.location.href)) {
        window.location.href = COLOR_WORK_URL;
      }
    } catch (e) {}
  })();

  // ---- Server error watcher ----
  (function () {
    const text = document.body ? (document.body.innerText || "") : "";
    if (/Service Unavailable|maintenance downtime|capacity problems|Apache Server at/.test(text)) {
      signal({ type: "stale_refresh", src: "srvErr" });
      setTimeout(() => { window.location.href = COLOR_WORK_URL; }, 1500);
    }
  })();

  // ---- SQLSTATE watcher ----
  let _sqlFired = false;
  function checkSqlState() {
    if (_sqlFired) return;
    const text = document.body ? document.body.innerText : "";
    if (/sqlstate|no such file or directory|mysql|database connection/.test(text || "")) {
      _sqlFired = true;
      signal({ type: "stale_refresh", src: "sql" });
    }
  }

  // ---- HUD (Electron-specific) ----
  function getOrCreateHUD(slotName) {
    let hud = document.getElementById('visiontap-hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'visiontap-hud';
      hud.style.cssText = 'position:fixed;top:12px;right:12px;z-index:9999999;background:rgba(15,23,42,0.92);border:1px solid #38bdf8;border-radius:8px;padding:10px 14px;color:#f8fafc;font-family:monospace;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,0.5);pointer-events:none;max-width:340px;word-wrap:break-word;';
      hud.innerHTML =
        '<div style="font-weight:bold;color:#38bdf8;margin-bottom:4px;display:flex;justify-content:space-between;">' +
        '<span id="vt-hud-title">VisionTap <span id="vt-hud-slot"></span></span>' +
        '<span id="vt-hud-state" style="color:#4ade80;">READY</span></div>' +
        '<div>Time: <span id="vt-hud-timer" style="color:#facc15;">00:00</span> | Correct: <span id="vt-hud-correct" style="color:#4ade80;">0</span> | Wrong: <span id="vt-hud-wrong" style="color:#f87171;">0</span> | Error: <span id="vt-hud-error" style="color:#facc15;">0</span></div>' +
        '<div id="vt-hud-status" style="margin-top:4px;color:#94a3b8;max-width:320px;white-space:pre-wrap;word-wrap:break-word;">Waiting...</div>';
      document.body.appendChild(hud);
    }
    if (slotName) document.getElementById('vt-hud-slot').innerText = slotName;
    return hud;
  }

  vt.hud = (state) => {
    try {
      if (!state) return;
      getOrCreateHUD(state.slotName);
      if (state.statusText !== undefined) document.getElementById('vt-hud-status').innerText = state.statusText;
      if (state.timerText !== undefined) document.getElementById('vt-hud-timer').innerText = state.timerText;
      if (state.correctCount !== undefined) document.getElementById('vt-hud-correct').innerText = state.correctCount;
      if (state.wrongCount !== undefined) document.getElementById('vt-hud-wrong').innerText = state.wrongCount;
      if (state.errorCount !== undefined) document.getElementById('vt-hud-error').innerText = state.errorCount;
      const s = document.getElementById('vt-hud-state');
      if (s) {
        s.innerText = state.isRunning ? "SCANNING" : "READY";
        s.style.color = state.isRunning ? "#4ade80" : "#f87171";
      }
      // Show last result badge
      if (state.lastTaskCorrect !== undefined) {
        let badge = document.getElementById('vt-hud-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.id = 'vt-hud-badge';
          badge.style.cssText = 'margin-left:8px;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;';
          const titleEl = document.getElementById('vt-hud-title');
          if (titleEl) titleEl.appendChild(badge);
        }
        if (state.lastTaskCorrect === true) {
          badge.textContent = 'CORRECT';
          badge.style.background = '#166534';
          badge.style.color = '#4ade80';
        } else if (state.lastTaskCorrect === false) {
          badge.textContent = 'WRONG';
          badge.style.background = '#7f1d1d';
          badge.style.color = '#f87171';
        } else {
          badge.textContent = '';
          badge.style.background = 'transparent';
        }
      }
    } catch (e) {}
  };

  // ---- Chrome extension message listener ----
  // (In Electron we use __vtapi instead, but this is needed for Chrome compat)
  // Message handling is done via __vtapi methods below.

  // ---- Public API (Electron host calls these) ----
  vt.checkInputReady = () => {
    const box = findAnswerInput();
    const empty = box ? ('' + (box.value || box.textContent || '')).trim() === '' : false;
    const btn = findSubmitButton();
    const loaded = isUIFullyLoaded();
    const imgOk = !!btn && !!box;
    const ready = loaded && empty && imgOk;
    return { ready, url: window.location.href };
  };

  vt.grabImage = async () => ({ imageData: await grabTaskImage() });

  // DEBUG: list all images on page
  vt.debugListImages = () => {
    const imgs = Array.from(document.querySelectorAll('img'));
    return imgs.map(img => ({
      src: (img.src || '').substring(0, 200),
      alt: img.alt || '',
      w: img.naturalWidth || img.width,
      h: img.naturalHeight || img.height,
      parentClass: (img.parentElement && img.parentElement.className) || '',
      visible: img.offsetParent !== null,
      rect: img.getBoundingClientRect ? { x: Math.round(img.getBoundingClientRect().x), y: Math.round(img.getBoundingClientRect().y), w: Math.round(img.getBoundingClientRect().width), h: Math.round(img.getBoundingClientRect().height) } : null
    }));
  };

  // DEBUG: capture entire viewport as image
  vt.debugCaptureViewport = async () => {
    try {
      const canvas = await html2canvas(document.body);
      return canvas.toDataURL('image/png');
    } catch (e) {
      // Fallback: use old approach
      return null;
    }
  };

  vt.fill = async (answer) => {
    if (!answer || answer === "undefined" || answer === "null" || answer === "0" || answer === "NaN") {
      return { status: "blocked" };
    }
    return await pasteAndSubmit(String(answer).trim());
  };

  vt.getVerdict = () => {
    try {
      // Method 1: Check for specific result/alert elements on the page
      const resultSelectors = [
        '.alert', '.result', '.feedback', '.message', '.notification',
        '[class*="result"]', '[class*="feedback"]', '[class*="alert"]',
        '[class*="success"]', '[class*="error"]', '[class*="correct"]',
        '[class*="wrong"]', '[class*="incorrect"]', '.toast',
        '.swal2-popup', '.swal2-html-container', '#swal2-title',
        '.noty_layout', '.noty_body', '.noty_message'
      ];
      for (const sel of resultSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const t = el.innerText.toLowerCase().trim();
          if (t.includes('correct') || t.includes('success') || t.includes('well done')) return { correct: true };
          if (t.includes('wrong') || t.includes('incorrect') || t.includes('try again') || t.includes('error')) return { correct: false };
        }
      }

      // Method 2: Check for green/red colored text (common success/error pattern)
      const allEls = document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, div, strong, b');
      for (const el of allEls) {
        const style = window.getComputedStyle(el);
        const color = style.color;
        const bg = style.backgroundColor;
        const t = el.innerText.toLowerCase().trim();
        if (!t || t.length > 200) continue;
        // Green text often = success
        if ((color.includes('0, 128') || color.includes('34, 197') || color.includes('22, 163') || color.includes('21, 128')) && t.length < 50) {
          if (t.includes('correct') || t.includes('success') || t.includes('well done')) return { correct: true };
        }
        // Red text often = error
        if ((color.includes('220, 38') || color.includes('239, 68') || color.includes('234, 57') || color.includes('185, 28')) && t.length < 50) {
          if (t.includes('wrong') || t.includes('incorrect') || t.includes('try again') || t.includes('error')) return { correct: false };
        }
      }

      // Method 3: Check if the answer input cleared (new task loaded = previous was correct)
      const input = document.querySelector('input[placeholder*="Answer"], input[placeholder*="answer"], input[placeholder*="Enter"], input[type="text"]');
      if (input && input.value === '') {
        // Empty input could mean new task loaded
        // Check if there's a task image (fruit/emoji) present
        const hasTask = document.querySelector('img[src*="emoji"], img[src*="fruit"], img[src*="apple"], img[src*="grape"], img[src*="orange"], img[src*="cherry"]');
        if (hasTask) return { correct: true };
      }

      // Method 4: Fallback - check body text with stricter matching
      const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
      // Look for explicit correct/incorrect messages near submission
      const correctMatch = bodyText.match(/(?:answer|result|status)\s*(?:is|:)?\s*(correct|wrong|incorrect)/i);
      if (correctMatch) {
        const w = correctMatch[1].toLowerCase();
        return { correct: w === 'correct' };
      }

      // Method 5: Check for withdrawal amount increase (most reliable)
      const wm = bodyText.match(/withdrawable\s*[:=]?\s*[₱$]?\s*([0-9]+(?:\.[0-9]+)?)/);
      if (wm && wm[1]) {
        const current = parseFloat(wm[1]);
        if (this._lastWithdrawable && current > this._lastWithdrawable) {
          this._lastWithdrawable = current;
          return { correct: true };
        }
        this._lastWithdrawable = current;
      }

      return { correct: null };
    } catch (e) { return { correct: null }; }
  };

  vt.getTaskMeta = () => {
    const out = { withdrawable: null, pointsDone: null, pointsTotal: null };
    try {
      const text = (document.body ? document.body.innerText : "") || "";
      const low = text.toLowerCase();
      const wm = low.match(/withdrawable\s*[:=]?\s*[₱$]?\s*([0-9]+(?:\.[0-9]+)?)/);
      if (wm && wm[1]) out.withdrawable = wm[1];
      const pm = low.match(/([0-9]+)\s*\/\s*([0-9]+)/);
      if (pm) { out.pointsDone = pm[1]; out.pointsTotal = pm[2]; }
    } catch (e) {}
    return out;
  };

  vt.pageReady = () => ({
    url: window.location.href,
    isECNL: window.location.href.includes("ecnlmediamarket.com"),
    isWork: WORK_RE.test(window.location.href),
    isAuth: /login|signin|auth|account|password/i.test(window.location.href) || !!(document && document.querySelector('input[type="password"]'))
  });

  vt.requestRefresh = () => { signal({ type: "stale_refresh", src: "manual" }); return { status: "ok" }; };

  // ---- Stale page refresh ----
  let staleTimer = null;
  const resetStaleTimer = () => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      signal({ type: "stale_refresh", src: "staleTimer" });
    }, 300000);
  };
  resetStaleTimer();
  try { new MutationObserver(resetStaleTimer).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
  setInterval(checkSqlState, 5000);

  function centerTaskArea() {
    var target = document.querySelector('input[placeholder*="Answer"]') ||
                 document.querySelector('input[placeholder*="answer"]') ||
                 document.querySelector('input[placeholder*="Enter"]') ||
                 document.querySelector('input[type="text"]') ||
                 document.querySelector('button[type="submit"]') ||
                 document.querySelector('form');
    if (target) {
      target.scrollIntoView({ behavior: 'auto', block: 'center' });
    }
  }
  setInterval(centerTaskArea, 1500);
  try { new MutationObserver(centerTaskArea).observe(document.body, { childList: true, subtree: true }); } catch (e) {}

  window.__vtapi = vt;
})();
