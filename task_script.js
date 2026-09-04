// AUTO-RESTART ENGINE & SERVER ERROR RECOVERY
//
// ECNL "stay on the work page" failsafe:
// If ECNL ever drops us somewhere other than the animal-solving page (e.g. it
// redirects to /dashboard or /home), bring us straight back to the work page.
// This runs on every ECNL page because the content script injects at
// ecnlmediamarket.com/*, including the dashboard.
(function stayOnAnimalsPage() {
  try {
    const href = window.location.href;
    if (href.includes("ecnlmediamarket.com") &&
        !href.includes("/solving-animals") &&
        !href.includes("/solving-math")) {
      console.warn("[VisionTap] On non-work ECNL page, forcing /solving-animals:", href);
      window.location.href = "https://ecnlmediamarket.com/solving-animals";
      return;
    }
  } catch (e) {}
})();

(async function initServerErrorChecker() {
  const pageText = document.body ? (document.body.innerText || "") : "";
  
  const isServerError = pageText.includes("Service Unavailable") || 
                        pageText.includes("maintenance downtime") || 
                        pageText.includes("capacity problems") ||
                        pageText.includes("Apache Server at");

  if (isServerError) {
    console.warn("[VisionTap] Server error detected! Setting auto-restart flag and redirecting...");
    
    await chrome.storage.local.set({ autoStartAfterRedirect: true });
    
    setTimeout(() => {
      window.location.href = "https://ecnlmediamarket.com/solving-animals";
    }, 1500);
    return;
  }

  const stored = await chrome.storage.local.get(['autoStartAfterRedirect']);
  if (stored.autoStartAfterRedirect) {
    await chrome.storage.local.remove(['autoStartAfterRedirect']);
    
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: "trigger_scan" });
    }, 1000);
  }
})();

const isMathPage = window.location.href.includes("ecnlmediamarket.com/solving-math");
const isAnimalsPage = window.location.href.includes("ecnlmediamarket.com/solving-animals");

if (isMathPage || isAnimalsPage) {

  const nukeAds = () => {
    const selectors = [
      'iframe[src*="googleads"]',
      'iframe[id*="aswift"]',
      'div[id*="google_ads"]',
      '.adsbygoogle',
      'div[role="dialog"]',
      'ins.adsbygoogle',
      'div[class*="ad"]',
      '.modal-backdrop',
      '.overlay',
      'div[class*="backdrop"]',
      'div[class*="overlay"]'
    ];

    selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(el => el.remove());
    });

    document.querySelectorAll('div').forEach(el => {
      const style = window.getComputedStyle(el);
      if (style.position === 'fixed' && style.zIndex > 100 && !el.id.includes('visiontap-hud')) {
        el.remove();
      }
    });
  };

  nukeAds();
  const observer = new MutationObserver(nukeAds);
  observer.observe(document.body, { childList: true, subtree: true });

  function getOrCreateHUD() {
    let hud = document.getElementById('visiontap-hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'visiontap-hud';
      hud.style.position = 'fixed';
      hud.style.top = '12px';
      hud.style.right = '12px';
      hud.style.zIndex = '9999999';
      hud.style.backgroundColor = 'rgba(15, 23, 42, 0.92)';
      hud.style.border = '1px solid #38bdf8';
      hud.style.borderRadius = '8px';
      hud.style.padding = '10px 14px';
      hud.style.color = '#f8fafc';
      hud.style.fontFamily = 'monospace';
      hud.style.fontSize = '12px';
      hud.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
      hud.style.pointerEvents = 'none';
      hud.style.maxWidth = '340px';
      hud.style.wordWrap = 'break-word';
      hud.innerHTML = `
        <div style="font-weight: bold; color: #38bdf8; margin-bottom: 4px; display: flex; justify-content: space-between;">
          <span>VisionTap Scanner</span>
          <span id="vt-hud-state" style="color: #4ade80;">READY</span>
        </div>
        <div>Time: <span id="vt-hud-timer" style="color: #facc15;">00:00</span> | Done: <span id="vt-hud-count" style="color: #38bdf8;">0</span></div>
        <div id="vt-hud-status" style="margin-top: 4px; color: #94a3b8; max-width: 320px; white-space: pre-wrap; word-wrap: break-word;">Waiting for Alt+M...</div>
        <div style="font-size: 10px; color: #64748b; margin-top: 4px;">Alt+M to scan | Backtick to scan</div>
      `;
      document.body.appendChild(hud);
    }
    return hud;
  }

  function searchDocument(doc) {
    try {
      const candidates = Array.from(doc.querySelectorAll('input, textarea, [contenteditable="true"]'));
      const isTypeable = (el) => {
        if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
        const t = (el.type || 'text').toLowerCase();
        return ['text', 'search', 'number', 'tel', 'email'].includes(t);
      };
      return candidates.find(isTypeable) || candidates[0] || null;
    } catch (e) {
      return null;
    }
  }

  function findTargetInput() {
    let el = searchDocument(document);
    if (el) return el;

    const iframes = document.querySelectorAll('iframe');
    for (const frame of iframes) {
      try {
        const frameDoc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
        if (frameDoc) {
          el = searchDocument(frameDoc);
          if (el) return el;
        }
      } catch (e) {}
    }
    return null;
  }

  function findSubmitButton() {
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn'));
    return buttons.find(b => {
      const txt = (b.textContent || b.value || '').toLowerCase();
      const isVisible = b.offsetWidth > 0 && b.offsetHeight > 0;
      return isVisible && (txt.includes('solve') || txt.includes('submit') || txt.includes('check') || txt.includes('answer'));
    }) || document.querySelector('button[type="submit"]');
  }

  // Returns the "Type the Answer" input box if present and genuinely ready.
  // The answer box carries either a placeholder="Type the Answer" or an
  // associated label / surrounding text. We require that hint so we never
  // trigger detection on a stale/transition page that only has unrelated inputs.
  function findAnswerInput() {
    const doc = document;
    const hint = (el) => {
      const p = ((el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
      if (p.includes('type') && p.includes('answer')) return true;
      if (p.includes('answer')) return true;
      return false;
    };
    const checkDoc = (d) => {
      const all = Array.from(d.querySelectorAll('input, textarea, [contenteditable="true"]'));
      let found = all.find(el => hint(el));
      if (found) return found;
      // Check an adjacent label's text.
      for (const el of all) {
        const box = el.closest('div, label, form');
        if (!box) continue;
        const txt = (box.innerText || '').toLowerCase();
        if (txt.includes('type the answer') || txt.includes('answer')) {
          return el;
        }
      }
      return null;
    };
    let el = checkDoc(doc);
    if (el) return el;
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        const fd = frame.contentDocument;
        if (fd) {
          el = checkDoc(fd);
          if (el) return el;
        }
      } catch (e) {}
    }
    return null;
  }

  function isPageLoading() {
    const pageText = document.body.innerText || "";
    
    const isHardLoading = pageText.includes("Please wait a few seconds") || 
                          pageText.includes("Please wait") || 
                          pageText.includes("Checking encoded solution") ||
                          pageText.includes("Checking encoded solutions");
    
    const targetInput = findTargetInput();
    const submitBtn = findSubmitButton();

    return isHardLoading || !targetInput || !submitBtn;
  }

  async function waitForPageToLoad() {
    let checkCount = 0;
    const waitStart = Date.now();
    const ECNL_NO_TASK_TIMEOUT_MS = 60000;
    while (isPageLoading()) {
      checkCount++;

      if (Date.now() - waitStart >= ECNL_NO_TASK_TIMEOUT_MS) {
        chrome.runtime.sendMessage({ action: "ecnl_stale_refresh" });
        return true;
      }

      const statusEl = document.getElementById('vt-hud-status');
      if (statusEl) statusEl.innerText = `Waiting for task (Check #${checkCount})...`;

      nukeAds();
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
    return true;
  }

  function wipeSystemClipboard() {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText("");
      }
    } catch (e) {}
  }

  // GRAB IMAGE: finds the main ECNL task image and returns it as a data URL.
  // Prefers the magiccount.php image (animal/math task), else the largest
  // visible image. Nukes ads first if requested by the caller.
  async function grabPageImage(nukeAdsFirst) {
    if (nukeAdsFirst) nukeAds();

    const imgs = Array.from(document.querySelectorAll('img'));
    const visible = imgs.filter(img => {
      if (!img.src || img.src.startsWith('data:image/svg')) return false;
      if (img.naturalWidth < 50 || img.naturalHeight < 50) return false;
      const r = img.getBoundingClientRect();
      return r.width > 50 && r.height > 50 && r.top < window.innerHeight && r.bottom > 0;
    });

    if (visible.length === 0) return null;

    // Prefer the task image (magiccount.php), then largest visible.
    const magic = visible.find(img => /magiccount/i.test(img.src));
    const chosen = magic || visible.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))[0];

    try {
      const canvas = document.createElement('canvas');
      canvas.width = chosen.naturalWidth;
      canvas.height = chosen.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(chosen, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');
      if (dataUrl && dataUrl.length > 100) return dataUrl;
    } catch (e) {}

    // Fallback: try fetching the src URL directly
    try {
      const resp = await fetch(chosen.src);
      const blob = await resp.blob();
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    } catch (e) {}

    return null;
  }

  // Is a genuine task image loaded & visible? We never want to scan a
  // transition/loading screen, so require the animal/math image to be present.
  function taskImageVisible() {
    const imgs = Array.from(document.querySelectorAll('img'));
    return imgs.some(img => {
      if (!img.src) return false;
      const isTask = /magiccount|\.php/i.test(img.src) ||
                     (img.naturalWidth >= 400 && img.naturalHeight >= 200) ||
                     (img.width >= 400 && img.height >= 200);
      if (!isTask) return false;
      const r = img.getBoundingClientRect();
      return r.width > 200 && r.height > 100;
    });
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "update_hud") {
      const hud = getOrCreateHUD();
      document.getElementById('vt-hud-status').innerText = request.statusText;
      document.getElementById('vt-hud-timer').innerText = request.timerText;
      document.getElementById('vt-hud-count').innerText = request.tasksCompleted;
      
      const stateEl = document.getElementById('vt-hud-state');
      if (request.isRunning) {
        stateEl.innerText = "SCANNING";
        stateEl.style.color = "#4ade80";
      } else {
        stateEl.innerText = "READY";
        stateEl.style.color = "#f87171";
      }
      sendResponse({ status: "hud_updated" });
      return true;
    }

    if (request.action === "grab_image") {
      grabPageImage(request.nukeAds).then(dataUrl => {
        sendResponse({ imageData: dataUrl });
      });
      return true;
    }

    if (request.action === "check_input_ready") {
      const box = findAnswerInput();
      const empty = box ? ('' + (box.value || box.textContent || '')).trim() === '' : false;
      const notLoading = !isPageLoading();
      const imgOk = taskImageVisible();
      sendResponse({ ready: !!(box && empty && notLoading && imgOk) });
      return true;
    }

    if (request.action === "fill_answer" && request.answer) {
      injectAndSubmit(request.answer);
      sendResponse({ status: "completed" });
      return true;
    }

    if (request.action === "get_verdict") {
      const res = readVerdict();
      sendResponse(res);
      return true;
    }

    if (request.action === "get_task_meta") {
      sendResponse(readTaskMeta());
      return true;
    }

    if (request.action === "get_error_state") {
      sendResponse({ stuckMessage: detectErrorState() });
      return true;
    }

    if (request.action === "prepare_screenshot") {
      nukeAds();
      sendResponse({ status: "ready" });
      return true;
    }
  });

  function detectErrorState() {
    try {
      const body = document.body ? document.body.innerText : "";
      if (!body || !body.trim()) return "blank page";

      const errorMarkers = [
        /incorrect/i, /wrong answer/i, /try again later/i,
        /something went wrong/i, /network error/i, /connection lost/i,
        /server error/i, /500/i, /502/i, /503/i, /524/i,
        /reconnecting/i, /loading error/i, /session expired/i, /logged out/i,
        /sqlstate/i, /no such file or directory/i, /mysql/i, /database connection/i
      ];
      for (const re of errorMarkers) {
        if (re.test(body)) return `error marker: ${re.source}`;
      }
    } catch (e) {
      return "";
    }
    return "";
  }

  let sqlStateFired = false;
  function checkAndFlagSqlState() {
    if (sqlStateFired) return;
    const text = document.body ? document.body.innerText : "";
    if (/sqlstate|no such file or directory|mysql|database connection/.test(text || "")) {
      sqlStateFired = true;
      console.warn("[VisionTap] SQLSTATE/database error detected. Refreshing.");
      chrome.runtime.sendMessage({ action: "ecnl_stale_refresh" });
    }
  }

  const sqlTextWatcher = new MutationObserver(checkAndFlagSqlState);
  try { sqlTextWatcher.observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (e) {}
  setInterval(checkAndFlagSqlState, 2000);

  // Stale page refresh: if no input or submit button for 60s, refresh
  let staleTimer = null;
  function resetStaleTimer() {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      if (isPageLoading()) {
        console.warn("[VisionTap] Page stale for 60s. Refreshing...");
        chrome.runtime.sendMessage({ action: "ecnl_stale_refresh" });
      }
    }, 60000);
  }
  resetStaleTimer();
  new MutationObserver(resetStaleTimer).observe(document.body, { childList: true, subtree: true });

  function injectAndSubmit(answer) {
    nukeAds();

    const cleanAnswer = String(answer || "").trim().replace(/,/g, '');

    const isForbiddenText = /(retry|reject|refresh|loading|please wait|checking encoded|correct answer|success|already been|there are|the box|in progress|fullscreen|submit|gemini)/i.test(cleanAnswer);
    const isNumeric = /^[0-9]+$/.test(cleanAnswer);
    const isSingleWordColor = /^[a-zA-Z]+$/.test(cleanAnswer) && cleanAnswer.length <= 15 && !isForbiddenText;

    const isValidPayload = (isNumeric || isSingleWordColor) && !isForbiddenText;

    if (!isValidPayload) {
      console.warn(`[VisionTap Blocked] Prevented touching input box for payload: "${cleanAnswer}"`);
      return;
    }

    const targetInput = findAnswerInput() || findTargetInput();
    if (!targetInput) return;

    targetInput.focus();
    targetInput.click();
    targetInput.value = '';

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 
      'value'
    ).set;

    nativeSetter.call(targetInput, cleanAnswer);

    targetInput.dispatchEvent(new Event('input', { bubbles: true }));
    targetInput.dispatchEvent(new Event('change', { bubbles: true }));
    targetInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    targetInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));

    setTimeout(() => {
      const btn = findSubmitButton();
      if (btn) {
        btn.click();
        wipeSystemClipboard();
      }
    }, 100);
  }

  // Best-effort: after submitting, read ECNL's feedback (correct/wrong + the
  // right answer) so we can track accuracy. Returns an object, never throws.
  function readVerdict() {
    try {
      const text = (document.body ? document.body.innerText : "") || "";
      const low = text.toLowerCase();
      let correct = null;
      let theirs = null;

      if (/\b(correct|right|good|well done|that'?s right)\b/.test(low)) {
        correct = true;
      } else if (/\b(incorrect|wrong|not correct|try again)\b/.test(low)) {
        correct = false;
      }

      // Look for "answer was X" / "answer is X" / "correct answer X"
      const m = low.match(/answer(?: was| is|:|:)\s*[^a-z]{0,3}([a-z0-9]+)/i);
      if (m && m[1]) theirs = m[1].trim();

      return { correct, theirs, pageSnippet: text.slice(0, 200) };
    } catch (e) {
      return { correct: null, theirs: null, pageSnippet: "" };
    }
  }

  // Best-effort: scrape ECNL task meta (withdrawable peso and task points) so
  // we can report them per task. Parsed from the page's text/attributes.
  function readTaskMeta() {
    const out = { withdrawable: null, pointsDone: null, pointsTotal: null };
    try {
      const text = (document.body ? document.body.innerText : "") || "";
      const low = text.toLowerCase();

      // Task Withdrawable: ₱84.781
      const wm = low.match(/withdrawable\s*[:=]?\s*[₱$]?\s*([0-9]+(?:\.[0-9]+)?)/);
      if (wm && wm[1]) out.withdrawable = wm[1];

      // Task Points: 128 of 250  (also "128/250")
      const pm = low.match(/points\s*[:=]?\s*([0-9]+)\s*(?:of|\/)\s*([0-9]+)/i);
      if (pm) { out.pointsDone = pm[1]; out.pointsTotal = pm[2]; }

      // Fallback: data attributes on task elements.
      if (out.withdrawable == null) {
        const el = document.querySelector('[data-withdrawable], [data-task-withdrawable]');
        if (el) {
          const v = (el.getAttribute('data-withdrawable') || el.getAttribute('data-task-withdrawable') || '').replace(/[₱$,]/g, '');
          if (/^[0-9.]+$/.test(v)) out.withdrawable = v;
        }
      }
    } catch (e) {}
    return out;
  }
}
