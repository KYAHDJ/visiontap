// VisionTap Slot - Injected page script.
// EXACT clone of VisionTapColor task_script.js behavior + Electron HUD/host bridge.

(function () {
  if (window.__vtapi) return;
  const vt = {};
  window.__vtapi = vt;

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
    }) || null;
  }

  function isCheckingState() {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.some(b => {
      const txt = (b.textContent || '').toLowerCase().trim();
      return txt.includes('checking') || txt.includes('encoded solutions');
    });
  }

  vt.clearSiteData = async () => {
    try {
      document.cookie.split(';').forEach(c => {
        const name = c.split('=')[0].trim();
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=' + window.location.hostname;
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.' + window.location.hostname;
      });
      try { localStorage.clear(); } catch (e) {}
      try { sessionStorage.clear(); } catch (e) {}
      try {
        if (window.indexedDB && window.indexedDB.databases) {
          const dbs = await window.indexedDB.databases();
          for (const db of dbs) {
            if (db.name) window.indexedDB.deleteDatabase(db.name);
          }
        }
      } catch (e) {}
      return { cleared: true };
    } catch (e) { return { cleared: false, error: e.message }; }
  };

  // ---- EXACT Chrome extension: isUIFullyLoaded ----
  function isUIFullyLoaded() {
    const input = findAnswerInput();
    const btn = findSubmitButton();
    if (!input || !btn) return false;
    const inputStyle = window.getComputedStyle(input);
    const btnStyle = window.getComputedStyle(btn);
    if (inputStyle.display === 'none' || btnStyle.display === 'none') return false;
    if (inputStyle.visibility === 'hidden' || btnStyle.visibility === 'hidden') return false;
    return true;
  }

  // ---- EXACT Chrome extension: grabTaskImage ----
  async function grabTaskImage() {
    if (!findAnswerInput()) return null;

    const dbgCanvases = document.querySelectorAll('canvas');
    const dbgImgs = document.querySelectorAll('img');
    const dbgSvgs = document.querySelectorAll('svg');
    const allEls = document.querySelectorAll('*');
    let bgCount = 0;
    for (const el of allEls) {
      const bg = window.getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') bgCount++;
    }
    vt._grabDebug = `canvases=${dbgCanvases.length} imgs=${dbgImgs.length} svgs=${dbgSvgs.length} bgEls=${bgCount} bodyLen=${(document.body.innerHTML||'').length}`;

    // 1. Try canvas elements first
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
      const badKeywords = ['avatar', 'logo', 'profile', 'icon', 'brand', 'header', 'banner', 'favicon', 'loading', 'spinner', 'default', 'placeholder', 'watermark', 'gold', 'shine', 'gradient', 'social', 'share', 'follow'];
      
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

    // Random 1-3s delay after input before submit (weighted: 3s rare ~5%)
    let delayMs;
    const r = Math.random();
    if (r < 0.50) delayMs = 1000 + Math.random() * 500;        // 50% -> 1.0-1.5s
    else if (r < 0.80) delayMs = 1500 + Math.random() * 700;   // 30% -> 1.5-2.2s
    else if (r < 0.95) delayMs = 2200 + Math.random() * 500;   // 15% -> 2.2-2.7s
    else delayMs = 2700 + Math.random() * 300;                 // 5%  -> 2.7-3.0s (rare)
    // console.log(`[VisionTap] submit delay ${Math.round(delayMs)}ms`);
    setTimeout(() => {
      const btn = findSubmitButton();
      if (btn) {
        btn.click();
      } else {
        inputBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      }
    }, Math.round(delayMs));
    return { status: "filled", delayMs: Math.round(delayMs) };
  }

  // ---- EXACT Chrome extension: 60-Second Inactivity Reload Watchdog ----
  // REMOVED for battery saving — only reload on actual stall detection

  // ---- EXACT Chrome extension: ad_blocker nuke (DOM removal, same as ad_blocker.js) ----
  const AD_SELECTORS = [
    'iframe[src*="googleads"]', 'iframe[id*="aswift"]',
    'div[id*="google_ads"]', 'div[id*="ad_container"]',
    '.adsbygoogle', 'ins.adsbygoogle', 'div[class*="adslot"]',
    'div[class*="ad-banner"]', 'div[class*="advert"]', 'div[class*="adunit"]',
    'div[class*="cookie-banner"]', 'div[id*="cookie"]',
    'div[class*="consent"]', 'iframe[src*="ads"]',
    'div[aria-label*="advertisement" i]', 'div[aria-label*="sponsored" i]',
    '#google_vignette', '.google-auto-placed', 'div[id*="google_ads_query"]'
  ];

  function nukeAds() {
    try {
      AD_SELECTORS.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          try { el.remove(); } catch (e) {}
        });
      });
      document.querySelectorAll('video[src*="ad"], video[src*="adserve"]').forEach(el => {
        try { el.remove(); } catch (e) {}
      });
      document.querySelectorAll('div').forEach(el => {
        if (el.id && el.id.includes('visiontap')) return;
        try {
          const style = window.getComputedStyle(el);
          if (style.position === 'fixed' && parseInt(style.zIndex || '0', 10) > 100) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const vw = window.innerWidth || 1;
              const vh = window.innerHeight || 1;
              if (rect.width >= vw * 0.8 && rect.height >= vh * 0.8) return;
              if (el.querySelector && (el.querySelector('input') || el.querySelector('button') || el.querySelector('canvas'))) return;
              if (el.className && (el.className.toString().includes('modal') || el.className.toString().includes('dialog'))) return;
              if (el.querySelector && el.querySelector('form')) return;
            }
            el.remove();
          }
        } catch (e2) {}
      });
    } catch (e) {}
  }

  nukeAds();
  if (window.location.hash && window.location.hash.includes('google')) {
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
  }
  let _adObserver = null;
  let _nukeCount = 0;
  try {
    _adObserver = new MutationObserver(() => {
      _nukeCount++;
      nukeAds();
      if (window.location.hash && window.location.hash.includes('google')) {
        try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
      }
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
    const bodyText = document.body ? (document.body.innerText || '').trim() : '';
    const bodyLen = document.body ? (document.body.innerHTML || '').length : 0;
    const isBlank2026 = bodyText === '2026' || (bodyText.length < 10 && /^\d{4}$/.test(bodyText) && !findAnswerInput());
    const isBlankNoTask = !isBlank2026 && bodyLen < 2000 && !findAnswerInput() && !findSubmitButton();

    const box = findAnswerInput();
    const rawVal = box ? ('' + (box.value || box.textContent || '')).trim() : '';
    const empty = rawVal === '';
    const btn = findSubmitButton();
    const loaded = isUIFullyLoaded();
    const imgOk = !!btn && !!box;
    const checking = isCheckingState();

    if (!empty && box) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(box, '');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const boxStyle = box ? window.getComputedStyle(box) : null;
    const btnStyle = btn ? window.getComputedStyle(btn) : null;
    const boxHidden = boxStyle && (boxStyle.display === 'none' || boxStyle.visibility === 'hidden');
    const btnHidden = btnStyle && (btnStyle.display === 'none' || btnStyle.visibility === 'hidden');

    if (boxHidden || btnHidden) {
      if (!vt._pageHiddenLogged) {
        vt._pageHiddenLogged = true;
        signal({ type: "vt_log", msg: `Page elements hidden (boxHidden=${boxHidden} btnHidden=${btnHidden}). Refresh needed.` });
        signal({ type: "stale_refresh", src: "elements-hidden" });
      }
    } else {
      vt._pageHiddenLogged = false;
    }

    if (isBlank2026 && !vt._blank2026Logged) {
      vt._blank2026Logged = true;
      signal({ type: "vt_log", msg: "2026 blank page detected. Waiting..." });
    } else if (isBlankNoTask && !vt._blankNoTaskLogged) {
      vt._blankNoTaskLogged = true;
      signal({ type: "vt_log", msg: `Blank page (bodyLen=${bodyLen}). Waiting for task content...` });
    } else if (!isBlank2026 && !isBlankNoTask) {
      vt._blank2026Logged = false;
      vt._blankNoTaskLogged = false;
    }

    const ready = loaded && imgOk && !checking && !boxHidden && !btnHidden && !isBlank2026 && !isBlankNoTask;
    const boxRect = box ? box.getBoundingClientRect() : null;
    const btnRect = btn ? btn.getBoundingClientRect() : null;
    const newVal = box ? ('' + (box.value || box.textContent || '')).trim() : '';
    const result = { ready, url: window.location.href, hasBox: !!box, hasBtn: !!btn, checking, boxW: boxRect ? Math.round(boxRect.width) : 0, boxH: boxRect ? Math.round(boxRect.height) : 0, btnW: btnRect ? Math.round(btnRect.width) : 0, btnH: btnRect ? Math.round(btnRect.height) : 0, empty: newVal === '', loaded, boxDisplay: boxStyle ? boxStyle.display : 'none', boxVal: rawVal.substring(0, 60), boxPlaceholder: box ? (box.placeholder || '') : '', isBlank2026, isBlankNoTask };
    if (!box || !btn) {
      if (!vt._domDumpDone || (vt._lastDomDumpUrl !== window.location.href)) {
        vt._domDumpDone = true;
        vt._lastDomDumpUrl = window.location.href;
        try { result.domDump = vt.debugDumpDOM(); } catch (e) { result.domDumpError = e.message; }
      }
    } else {
      vt._domDumpDone = false;
    }
    return result;
  };

  vt.grabImage = async () => ({ imageData: await grabTaskImage() });

  // DEBUG: dump full DOM structure to diagnose why no input/button found
  vt.debugDumpDOM = () => {
    const body = document.body;
    if (!body) return { error: "no body" };
    const allInputs = Array.from(document.querySelectorAll('input, textarea, select'));
    const allButtons = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'));
    const allCanvases = Array.from(document.querySelectorAll('canvas'));
    const allForms = Array.from(document.querySelectorAll('form'));
    const allLinks = Array.from(document.querySelectorAll('a[href]')).slice(0, 20);
    const bodyChildren = Array.from(body.children).map(ch => ({
      tag: ch.tagName,
      id: ch.id || '',
      cls: (ch.className || '').toString().substring(0, 100),
      display: window.getComputedStyle(ch).display,
      children: ch.children.length,
      innerHTML_len: ch.innerHTML ? ch.innerHTML.length : 0,
      text: (ch.innerText || '').substring(0, 200)
    }));
    const fixedDivs = Array.from(document.querySelectorAll('div')).filter(el => {
      const s = window.getComputedStyle(el);
      return s.position === 'fixed' || s.position === 'absolute';
    }).slice(0, 20).map(el => ({
      tag: el.tagName, id: el.id || '', cls: (el.className || '').toString().substring(0, 80),
      pos: window.getComputedStyle(el).position,
      z: window.getComputedStyle(el).zIndex,
      rect: el.getBoundingClientRect ? { x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null,
      hasInput: !!el.querySelector('input'), hasButton: !!el.querySelector('button')
    }));
    return {
      url: window.location.href,
      title: document.title,
      bodyLen: body.innerHTML ? body.innerHTML.length : 0,
      bodyText: (body.innerText || '').substring(0, 500),
      inputs: allInputs.map(i => ({ tag: i.tagName, type: i.type, placeholder: i.placeholder, cls: (i.className||'').substring(0,60), display: window.getComputedStyle(i).display, vis: window.getComputedStyle(i).visibility })),
      buttons: allButtons.map(b => ({ tag: b.tagName, text: (b.textContent||'').substring(0,40), cls: (b.className||'').substring(0,60) })),
      canvases: allCanvases.map(c => ({ w: c.width, h: c.height, display: window.getComputedStyle(c).display })),
      forms: allForms.map(f => ({ id: f.id, action: f.action, method: f.method })),
      links: allLinks.map(a => ({ href: (a.href||'').substring(0,100), text: (a.textContent||'').substring(0,40) })),
      bodyChildren,
      fixedDivs,
      scripts: Array.from(document.querySelectorAll('script[src]')).map(s => s.src.substring(0, 100)).slice(0, 10)
    };
  };

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
      const bodyText = document.body ? document.body.innerText.toLowerCase() : '';

      // Method 1: Check for explicit correct/incorrect messages in body text
      const wrongPatterns = [
        /(?:answer|result|status|response)\s*(?:is|:)?\s*(?:wrong|incorrect|not correct|invalid|try again)/i,
        /(?:wrong|incorrect|not correct|invalid)\s*(?:answer|response)/i,
        /(?:try|please try)\s*again/i,
        /(?:sorry|oops|unfortunately)[,.]?\s*(?:that(?:'s| is)|you(?:'re| are))?\s*(?:wrong|incorrect|not right)/i
      ];
      for (const pat of wrongPatterns) {
        if (pat.test(bodyText)) return { correct: false };
      }
      const correctPatterns = [
        /(?:answer|result|status|response)\s*(?:is|:)?\s*(?:correct|right|well done|accurate)/i,
        /(?:congratulations|nice|great|good)\s*(?:!|\.|,|\s*(?:job|work|answer|response))/i
      ];
      for (const pat of correctPatterns) {
        if (pat.test(bodyText)) return { correct: true };
      }

      // Method 2: Check result/alert/feedback elements
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
          if (t.includes('wrong') || t.includes('incorrect') || t.includes('try again') || t.includes('error') || t.includes('invalid')) return { correct: false };
          if (t.includes('correct') || t.includes('success') || t.includes('well done')) return { correct: true };
        }
      }

      // Method 3: Check for red/green colored text
      const allEls = document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, div, strong, b');
      for (const el of allEls) {
        const t = el.innerText.toLowerCase().trim();
        if (!t || t.length > 200) continue;
        const style = window.getComputedStyle(el);
        const color = style.color;
        if ((color.includes('220, 38') || color.includes('239, 68') || color.includes('234, 57') || color.includes('185, 28')) && t.length < 50) {
          if (t.includes('wrong') || t.includes('incorrect') || t.includes('try again') || t.includes('error') || t.includes('invalid')) return { correct: false };
        }
        if ((color.includes('0, 128') || color.includes('34, 197') || color.includes('22, 163') || color.includes('21, 128')) && t.length < 50) {
          if (t.includes('correct') || t.includes('success') || t.includes('well done')) return { correct: true };
        }
      }

      // Method 4: Check withdrawal amount increase (most reliable for correct)
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
      
      // Find withdrawable amount - try multiple patterns
      const wm = low.match(/withdrawable\s*[:=]?\s*[₱$]?\s*([0-9]+(?:\.[0-9]+)?)/);
      if (wm && wm[1]) out.withdrawable = wm[1];
      if (!out.withdrawable) {
        const bm = low.match(/(?:balance|wallet|available|funds|total)\s*[:=]?\s*[₱$]?\s*([0-9]+(?:\.[0-9]+)?)/);
        if (bm && bm[1]) out.withdrawable = bm[1];
      }
      // More robust withdrawable fallback: look for ₱ or $ amount near progress area
      if (!out.withdrawable) {
        const pm = text.match(/[₱$]\s*([0-9]+(?:\.[0-9]{1,4})?)/);
        if (pm && pm[1]) {
          const v = parseFloat(pm[1]);
          if (v > 5 && v < 100000) out.withdrawable = pm[1];
        }
      }

      // --- POINTS: robust search for X / 250 specifically ---
      // 1) Direct body regex for "X / 250" (most reliable, avoids picking wrong X/Y)
      const m250 = text.match(/(\d{1,3})\s*\/\s*250\b/);
      if (m250) {
        out.pointsDone = m250[1];
        out.pointsTotal = "250";
      }
      // 2) Search elements whose text contains "/250"
      if (!out.pointsDone) {
        const allEls = document.querySelectorAll('*');
        for (const el of allEls) {
          const t = (el.innerText || '').trim();
          if (!t || t.length > 200) continue;
          if (!t.includes('/')) continue;
          // exact X / 250 inside element
          const mm = t.match(/(\d{1,3})\s*\/\s*250\b/);
          if (mm) { out.pointsDone = mm[1]; out.pointsTotal = "250"; break; }
          // exact X/Y but prefer total 250
          const m = t.match(/^(\d{1,3})\s*\/\s*(\d{1,3})$/);
          if (m) {
            const done = parseInt(m[1], 10);
            const total = parseInt(m[2], 10);
            if (total === 250 && done >= 0 && done <= total) {
              out.pointsDone = m[1];
              out.pointsTotal = m[2];
              break;
            }
          }
        }
      }
      // 3) Generic X/Y with total 100-500 if 250 not found
      if (!out.pointsDone) {
        const allEls = document.querySelectorAll('*');
        for (const el of allEls) {
          const t = (el.innerText || '').trim();
          if (t.length > 100 || t.length < 3) continue;
          const m = t.match(/^(\d{1,3})\s*\/\s*(\d{1,3})$/);
          if (m) {
            const done = parseInt(m[1], 10);
            const total = parseInt(m[2], 10);
            if (total >= 100 && total <= 500 && done >= 0 && done <= total) {
              out.pointsDone = m[1];
              out.pointsTotal = m[2];
              break;
            }
          }
        }
      }
      // 4) Fallback generic in body text
      if (!out.pointsDone) {
        const pm = low.match(/([0-9]+)\s*\/\s*([0-9]+)/);
        if (pm) { out.pointsDone = pm[1]; out.pointsTotal = pm[2]; }
      }
      if (!out.pointsDone) {
        const pm2 = low.match(/(?:points?|score|progress)\s*[:=]?\s*([0-9]+)\s*(?:of|\/|out of)\s*([0-9]+)/i);
        if (pm2) { out.pointsDone = pm2[1]; out.pointsTotal = pm2[2]; }
      }
      const progressEls = document.querySelectorAll('[class*="progress"], [class*="points"], [class*="score"], [class*="count"]');
      for (const el of progressEls) {
        const t = (el.innerText || '').trim();
        const m = t.match(/([0-9]+)\s*\/\s*([0-9]+)/);
        if (m && !out.pointsDone) { out.pointsDone = m[1]; out.pointsTotal = m[2]; break; }
      }
      // Debug: expose raw finder for logs
      vt._lastMetaRaw = { bodySnippet: text.substring(0, 400), pointsDone: out.pointsDone, pointsTotal: out.pointsTotal, withdrawable: out.withdrawable };
    } catch (e) {}
    return out;
  };

  vt.pageReady = () => ({
    url: window.location.href,
    isECNL: window.location.href.includes("ecnlmediamarket.com"),
    isWork: WORK_RE.test(window.location.href),
    isAuth: /login|signin|auth|account|password/i.test(window.location.href) || !!(document && document.querySelector('input[type="password"]')),
    grabDebug: vt._grabDebug || null
  });

  vt.requestRefresh = () => { signal({ type: "stale_refresh", src: "manual" }); return { status: "ok" }; };

  // ---- Stale page refresh ----
  let staleTimer = null;
  const resetStaleTimer = () => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      signal({ type: "stale_refresh", src: "staleTimer" });
    }, 120000);
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

})();
