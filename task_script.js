(function stayOnColorsPage() {
  try {
    const href = window.location.href;
    const AUTH_HINTS = ['login', 'signin', 'auth', 'account', 'password'];
    const isAuthPage = AUTH_HINTS.some(h => href.toLowerCase().includes(h));
    if (href.includes("ecnlmediamarket.com") && !isAuthPage && !href.includes("/solving-colors")) {
      window.location.href = "https://ecnlmediamarket.com/solving-colors";
    }
  } catch (e) {}
})();

function findAnswerInput() {
  const inputs = Array.from(document.querySelectorAll('input, textarea'));
  return inputs.find(el => {
    const p = ((el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
    return p.includes('type') || p.includes('answer');
  }) || inputs[0] || null;
}

function findSubmitButton() {
  const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'));
  return btns.find(b => {
    const txt = (b.textContent || b.value || '').toLowerCase();
    return txt.includes('submit') || txt.includes('solve') || txt.includes('answer');
  });
}

function isUIFullyLoaded() {
  const input = findAnswerInput();
  const btn = findSubmitButton();
  if (!input || !btn) return false;

  const inputRect = input.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  return inputRect.width > 0 && inputRect.height > 0 && btnRect.width > 0 && btnRect.height > 0;
}

function hasErrorOrMissingImage() {
  const input = findAnswerInput();
  const btn = findSubmitButton();
  if (!input || !btn) return true;

  const imgs = Array.from(document.querySelectorAll('img'));
  const targetImg = imgs.find(img => {
    const src = (img.src || '').toLowerCase();
    const isBadImage = src.includes('avatar') || src.includes('logo') || src.includes('profile') || src.includes('icon');
    return !isBadImage && (img.naturalWidth >= 300 || img.width >= 300);
  });

  if (!targetImg || targetImg.naturalWidth < 100) return true;

  const errorIndicators = document.querySelectorAll('.error, .alert, [role="alert"], .loading');
  for (const el of errorIndicators) {
    if (el.textContent.toLowerCase().includes('error') || el.textContent.toLowerCase().includes('failed')) {
      return true;
    }
  }

  return false;
}

async function grabTaskImage() {
  if (!isUIFullyLoaded()) return null;

  const imgs = Array.from(document.querySelectorAll('img'));
  let targetImg = imgs.find(img => /magic-colors|magiccount/i.test(img.src));

  if (!targetImg) {
    targetImg = imgs.find(img => {
      const src = (img.src || '').toLowerCase();
      const isBadImage = src.includes('avatar') || src.includes('logo') || src.includes('profile') || src.includes('icon');
      return !isBadImage && (img.naturalWidth >= 300 || img.width >= 300);
    });
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

async function pasteAndSubmit(answerColor) {
  if (!isUIFullyLoaded()) return;
  
  if (!answerColor || answerColor === "undefined" || answerColor === "null" || answerColor === "0" || answerColor === "NaN") {
    console.log("[VisionTap] Invalid answer rejected:", answerColor);
    return;
  }

  try {
    await navigator.clipboard.writeText(answerColor);
  } catch (e) {}

  const inputBox = findAnswerInput();
  if (!inputBox) return;

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
}

function getVerdict() {
  try {
    const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
    
    if (bodyText.includes('correct') && !bodyText.includes('incorrect') && !bodyText.includes('wrong')) {
      return { correct: true };
    }
    if (bodyText.includes('success') && !bodyText.includes('error') && !bodyText.includes('failed')) {
      return { correct: true };
    }
    if (bodyText.includes('good') && !bodyText.includes('error')) {
      return { correct: true };
    }
    if (bodyText.includes('wrong') || bodyText.includes('incorrect') || bodyText.includes('try again')) {
      return { correct: false };
    }
    if (bodyText.includes('error') || bodyText.includes('refresh') || bodyText.includes('loading')) {
      return { correct: null };
    }
    
    return { correct: null };
  } catch (e) {
    return { correct: null };
  }
}

function extractTaskInfo() {
  const result = { targetNum: null, taskText: null };
  try {
    const bodyText = document.body ? document.body.innerText : '';
    
    const countMatch = bodyText.match(/how many\s+(\w+)\s+do you see/i);
    if (countMatch) {
      result.taskText = countMatch[0];
    }
    
    const numberMatch = bodyText.match(/(?:count|find|look for)\s+(\d+)/i);
    if (numberMatch) {
      result.targetNum = parseInt(numberMatch[1], 10);
    }
    
    const enterMatch = bodyText.match(/enter the number of\s+(\w+)/i);
    if (enterMatch) {
      result.taskText = enterMatch[0];
    }
  } catch (e) {}
  return result;
}

let idleTimer = setTimeout(() => window.location.reload(), 90000);
function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => window.location.reload(), 90000);
}

let errorCheckTimer = null;
function startErrorCheck() {
  if (errorCheckTimer) clearInterval(errorCheckTimer);
  errorCheckTimer = setInterval(() => {
    if (hasErrorOrMissingImage()) {
      window.location.reload();
    }
  }, 10000);
}
startErrorCheck();

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  resetIdleTimer();

  if (req.action === "get_task_data") {
    if (hasErrorOrMissingImage()) {
      window.location.reload();
      sendResponse({ imageData: null, error: true });
      return true;
    }
    grabTaskImage().then(imgData => {
      const taskInfo = extractTaskInfo();
      sendResponse({ 
        imageData: imgData,
        targetNum: taskInfo.targetNum,
        taskText: taskInfo.taskText
      });
    });
    return true;
  }

  if (req.action === "paste_and_submit" && req.color) {
    pasteAndSubmit(req.color).then(() => {
      sendResponse({ status: "done" });
    });
    return true;
  }

  if (req.action === "get_verdict") {
    sendResponse(getVerdict());
    return true;
  }
});
