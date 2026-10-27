'use strict';

// Runs only in the local test browser. Fills an empty answer input and submits it
// only after the page exposes an enabled, visible Submit button.
function installColorHelper(hostname) {
  if (location.hostname !== hostname) return;
  const installHider = () => {
    if (document.getElementById?.('visiontap-encodra-hide-style')) return;
    const style = document.createElement('style');
    style.id = 'visiontap-encodra-hide-style';
    style.textContent = 'p, footer { display: none !important; visibility: hidden !important; }';
    (document.head || document.documentElement)?.appendChild?.(style);
  };
  installHider();
  document.addEventListener?.('DOMContentLoaded', installHider, { once:true });
  if (window.__vtColorSuggestion) return;
  window.__vtColorSuggestion = true;
  const palette = [
    ['black', [17,17,17]], ['white', [250,250,250]],
    ['red', [229,57,53]], ['orange', [255,143,0]],
    ['yellow', [253,216,53]], ['green', [67,160,71]],
    ['blue', [30,136,229]], ['purple', [142,36,170]],
    ['pink', [248,128,171]], ['brown', [141,90,59]]
  ];
  let panel, lastText = '', lastSubmission = null, pendingSubmission = null, lastRetryButton = null;
  window.__vtColorState = { status:'starting', answer:null, shapeNumber:null, submissions:0, updatedAt:Date.now() };
  const visible = element => {
    if (!element.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})) return false;
    const r = element.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const show = text => {
    if (!document.body) return;
    if (!panel?.isConnected) {
      panel = document.createElement('div');
      panel.setAttribute('role', 'status');
      panel.style.cssText = 'position:fixed;right:16px;top:16px;z-index:2147483647;max-width:245px;padding:14px 18px;border:2px solid #38bdf8;border-radius:12px;background:#101827;color:#fff;font:15px/1.5 system-ui;white-space:pre-line;pointer-events:none;box-shadow:0 4px 20px #0005';
      document.body.appendChild(panel);
      lastText = '';
    }
    if (text !== lastText) { panel.textContent = text; lastText = text; }
    window.__vtColorState.updatedAt = Date.now();
    window.__vtColorState.message = text;
  };
  const fillEmptyAnswer = (task, answer) => {
    const input = task.querySelector('#task-answer');
    if (!input || !visible(input)) return 'missing';
    if (String(input.value || '').trim()) return 'paused';
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    descriptor.set.call(input, answer);
    input.dispatchEvent(new Event('input', {bubbles:true}));
    input.dispatchEvent(new Event('change', {bubbles:true}));
    return 'filled';
  };
  const submitFilledAnswer = (task, svg, number, answer) => {
    const input = task.querySelector('#task-answer');
    if (!input || String(input.value || '').trim().toLowerCase() !== answer) return 'waiting';
    const button = [...task.querySelectorAll('button')]
      .find(el => visible(el) && /^submit$/i.test(String(el.innerText || el.textContent || '').trim()));
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true'
      || getComputedStyle(button).pointerEvents === 'none') return 'waiting';
    if (lastSubmission?.input === input && lastSubmission?.svg === svg
      && lastSubmission.number === number && lastSubmission.answer === answer) return 'submitted';
    const samePending = pendingSubmission?.input === input && pendingSubmission?.svg === svg
      && pendingSubmission.number === number && pendingSubmission.answer === answer;
    if (!samePending) {
      pendingSubmission = {input, svg, number, answer, readyAt:Date.now() + 1000 + Math.random() * 1000};
      return 'delaying';
    }
    if (Date.now() < pendingSubmission.readyAt) return 'delaying';
    lastSubmission = {input, svg, number, answer};
    pendingSubmission = null;
    button.click();
    window.__vtColorState.submissions += 1;
    window.__vtColorState.lastSubmittedAt = Date.now();
    return 'submitted';
  };
  const scan = () => {
    try {
      if (window.__vtColorPaused) return show('VisionTap • Auto-submit mode\nPaused');
      const retryButton = [...document.querySelectorAll('button')]
        .find(el => visible(el) && /^try again$/i.test(String(el.innerText || el.textContent || '').trim())
          && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
          && getComputedStyle(el).pointerEvents !== 'none');
      if (retryButton) {
        if (retryButton !== lastRetryButton) {
          lastRetryButton = retryButton;
          retryButton.click();
        }
        return show('VisionTap • Recovery mode\nTry Again clicked — waiting for the color task');
      }
      lastRetryButton = null;
      // Select only the task container supplied by the user. Never read page source,
      // hidden text, script state, network responses, or unrelated page contents.
      const containers = [...document.querySelectorAll('div.flex.flex-col.gap-4')]
        .filter(visible).filter(el => el.querySelector('.task-image svg'));
      const candidates = containers.filter(el => !containers.some(other => other !== el && el.contains(other)));
      if (candidates.length !== 1) return show('VisionTap • Manual mode\nWaiting for one visible color task');
      const task = candidates[0];
      const heading = [...task.children].find(el => visible(el) && el.classList.contains('font-bold'));
      const match = heading?.innerText.match(/color of shape number\s*(\d+)/i);
      const svg = task.querySelector('.task-image svg');
      if (!match || !svg || !visible(svg)) return show('VisionTap • Manual mode\nWaiting for the visible color task');
      const bounds = svg.getBoundingClientRect();
      const shapes = [...svg.querySelectorAll('path,circle,ellipse,rect,polygon')]
        .filter(visible).map(el => ({el, box:el.getBoundingClientRect()}))
        .filter(({box}) => box.width < bounds.width * .45 && box.height < bounds.height * .45);
      if (!shapes.length) return show('VisionTap • Manual mode\nNo visible shapes found');
      // Group by visible row centers, then sort left to right; DOM order is irrelevant.
      shapes.sort((a,b) => (a.box.top+a.box.height/2)-(b.box.top+b.box.height/2));
      const rows = [];
      for (const shape of shapes) {
        const cy = shape.box.top + shape.box.height/2;
        let row = rows.find(r => Math.abs(r.cy-cy) < Math.min(r.height,shape.box.height)*.45);
        if (!row) { row = {cy,height:shape.box.height,items:[]}; rows.push(row); }
        row.items.push(shape);
      }
      const columns = rows[0].items.length;
      if (columns < 2 || rows.some(row => row.items.length !== columns))
        return show('VisionTap • Manual mode\nGrid unclear — no suggestion');
      const ordered = rows.flatMap(row => row.items.sort((a,b) => a.box.left-b.box.left));
      const number = Number(match[1]);
      if (number < 1 || number > ordered.length) return show('VisionTap • Manual mode\nTask number is outside the grid');
      const style = getComputedStyle(ordered[number-1].el);
      const rgb = style.fill.match(/^rgb\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)\s*\)$/);
      if (!rgb || Number(style.fillOpacity) !== 1 || Number(style.opacity) !== 1)
        return show('VisionTap • Manual mode\nColor is ambiguous — no suggestion');
      const color = rgb.slice(1).map(Number);
      const ranked = palette.map(([name,value]) => ({name,distance:Math.hypot(...value.map((v,i)=>v-color[i]))}))
        .sort((a,b)=>a.distance-b.distance);
      if (ranked[0].distance > 55 || ranked[1].distance-ranked[0].distance < 25)
        return show('VisionTap • Manual mode\nUncertain color — check manually');
      const answer = ranked[0].name;
      window.__vtColorState.answer = answer;
      window.__vtColorState.shapeNumber = number;
      const fillState = fillEmptyAnswer(task, answer);
      if (fillState === 'missing') return show(`VisionTap • Fill mode\nShape ${number}: ${answer.toUpperCase()}\nWaiting for a visible answer box`);
      if (fillState === 'filled') return show(`VisionTap • Auto-submit mode\nShape ${number}: ${answer.toUpperCase()}\nFilled — waiting for Submit`);
      const submitState = submitFilledAnswer(task, svg, number, answer);
      if (submitState === 'waiting') return show(`VisionTap • Auto-submit mode\nShape ${number}: ${answer.toUpperCase()}\nWaiting for Submit to become available`);
      if (submitState === 'delaying') return show(`VisionTap • Auto-submit mode\nShape ${number}: ${answer.toUpperCase()}\nWaiting 1–2 seconds before Submit`);
      window.__vtColorState.status = 'submitted';
      show(`VisionTap • Auto-submit mode\nShape ${number}: ${answer.toUpperCase()}\nSubmitted — waiting for a new task`);
    } catch (_) { show('VisionTap • Manual mode\nUnable to read visible task'); }
  };
  // Small scoped scan handles client-side task changes without page reloads.
  setInterval(scan, 250);
  scan();
}

module.exports = { installColorHelper };

