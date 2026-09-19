// Shell logic: toolbar chips + controls (main window) and the settings page
// (dedicated always-on-top window: shell.html?mode=settings).
(function () {
  const vt = window.visiontap;
  const isSettings = new URLSearchParams(location.search).get("mode") === "settings";

  const chipsEl = document.getElementById("chips");
  const emptyEl = document.getElementById("empty");
  const addBtn = document.getElementById("addBtn");
  const gearBtn = document.getElementById("gearBtn");
  const minBtn = document.getElementById("minBtn");
  const closeBtn = document.getElementById("closeBtn");
  const pauseToggle = document.getElementById("pauseToggle");
  const drawer = document.getElementById("settingsDrawer");
  const closeSettings = document.getElementById("closeSettings");
  const saveSettings = document.getElementById("saveSettings");
  const addSlotBtn = document.getElementById("addSlotBtn");
  const desktopShortcutBtn = document.getElementById("desktopShortcutBtn");
  const slotForms = document.getElementById("slotForms");

  let state = { slots: [], ghosts: [], settings: {} };
  let lastFormIds = "";
  let savedHistory = { users: [], accountNames: [] };

  function loadSavedHistory() {
    try {
      const data = localStorage.getItem('vt_saved_history');
      if (data) savedHistory = JSON.parse(data);
    } catch (e) {}
  }

  function saveToHistory(user, accountName) {
    if (user && !savedHistory.users.includes(user)) {
      savedHistory.users.push(user);
      if (savedHistory.users.length > 20) savedHistory.users.shift();
    }
    if (accountName && !savedHistory.accountNames.includes(accountName)) {
      savedHistory.accountNames.push(accountName);
      if (savedHistory.accountNames.length > 20) savedHistory.accountNames.shift();
    }
    try { localStorage.setItem('vt_saved_history', JSON.stringify(savedHistory)); } catch (e) {}
    updateDatalists();
  }

  function updateDatalists() {
    const usersList = document.getElementById('savedUsers');
    const namesList = document.getElementById('savedAccountNames');
    if (usersList) usersList.innerHTML = savedHistory.users.map(u => `<option value="${escapeHtml(u)}">`).join('');
    if (namesList) namesList.innerHTML = savedHistory.accountNames.map(n => `<option value="${escapeHtml(n)}">`).join('');
  }

  function escapeHtml(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ---- toolbar chips (main window only) ----
  function makeChip(text, cls, title, onclick) {
    const chip = document.createElement("div");
    chip.className = "chip " + cls;
    chip.title = title;
    chip.innerHTML = '<span class="dot"></span><span>' + text + "</span>";
    chip.addEventListener("click", onclick);
    chipsEl.appendChild(chip);
  }

  function renderChips() {
    if (isSettings) return;
    chipsEl.innerHTML = "";
    state.slots.forEach((slot) => {
      const cls = (slot.running ? "running" : "") + (slot.paused ? " paused" : "");
      const pts = slot.pointsDone != null ? slot.pointsDone + "/" + (slot.pointsTotal || "250") : "—";
      makeChip(
        escapeHtml(slot.name) + ' <span class="stat">' + slot.correctCount + "✓ / " + slot.wrongCount + "✗ · " + pts + "</span>" +
          ' <span class="x" data-act="remove">\u00d7</span>',
        cls,
        (slot.status || "") + "\nClick: focus · Right-click: start/stop · Shift+click: reload",
        (e) => {
          if (e.target.dataset && e.target.dataset.act === "remove") { vt.removeSlot(slot.id); return; }
          if (e.shiftKey) { vt.reloadSlot(slot.id); return; }
          vt.focusSlot(slot.id);
        }
      );
    });
    state.ghosts.forEach((g) => {
      makeChip(
        escapeHtml(g.name) + ' <span class="stat">off</span>',
        "",
        "This slot is off (saves RAM). Click to start it.",
        () => vt.bootSlot(g.id)
      );
    });
    emptyEl.classList.toggle("hidden", state.slots.length > 0 || state.ghosts.length > 0);
  }

  // ---- settings page ----
  function sel(id) { return document.getElementById(id); }

  function rememberSlotValues() {
    const mem = {};
    slotForms.querySelectorAll(".slot-card").forEach((c) => {
      mem[c.dataset.id] = {
        accountName: c.querySelector(".sf-account-name").value,
        user: c.querySelector(".cred-user").value,
        pass: c.querySelector(".cred-pass").value,
        zoom: c.querySelector(".sf-zoom").value,
        hud: c.querySelector(".sf-hud").value
      };
    });
    return mem;
  }

  function restoreSlotValues(mem) {
    for (const [id, m] of Object.entries(mem || {})) {
      const card = slotForms.querySelector(`.slot-card[data-id="${id}"]`);
      if (!card) continue;
      const an = card.querySelector(".sf-account-name"); if (an) an.value = m.accountName || "";
      card.querySelector(".cred-user").value = m.user;
      card.querySelector(".cred-pass").value = m.pass;
      const z = card.querySelector(".sf-zoom"); if (z) z.value = m.zoom;
      const h = card.querySelector(".sf-hud"); if (h) h.value = m.hud;
    }
  }

  function dataId(v) {
    return escapeHtml(v).replace(/"/g, "&quot;");
  }

  function renderSlotForms() {
    const mem = rememberSlotValues();
    const all = state.slots.map((s) => ({ kind: "slot", id: s.id, name: s.name, accountName: s.accountName || "", zoom: s.zoom, hud: s.hudEnabled }))
      .concat(state.ghosts.map((g) => ({ kind: "ghost", id: g.id, name: g.name, accountName: g.accountName || "", zoom: 1, hud: true })));
    lastFormIds = all.map((s) => s.id).join(",");
    if (!all.length) {
      slotForms.innerHTML = '<div class="grp" style="font-size:12px;color:#8ea3c0">No slots yet. Click "+ Add account".</div>';
      return;
    }
    slotForms.innerHTML = all.map((s) => `
      <div class="slot-card" data-id="${dataId(s.id)}">
        <div class="sc-head">
          <span>${escapeHtml(s.accountName || s.name)}${s.kind === "ghost" ? ' <span class="ghost-tag">(off)</span>' : ""}</span>
        </div>
        <div class="fields">
          <label class="full">Account name
            <input type="text" class="sf-account-name" placeholder="e.g. Adaiahbi" list="savedAccountNames" />
          </label>
          <label class="full">Username / email
            <input type="text" class="cred-user" placeholder="ecnl username or email" list="savedUsers" />
          </label>
          <label class="full">Password
            <input type="password" class="cred-pass" placeholder="ecnl password" />
          </label>
          <label>Zoom
            <select class="sf-zoom">
              <option value="1">100%</option>
              <option value="0.75">75%</option>
              <option value="0.9">90%</option>
              <option value="1.25">125%</option>
              <option value="1.5">150%</option>
            </select>
          </label>
          <label>HUD
            <select class="sf-hud">
              <option value="true">Show</option>
              <option value="false">Hide</option>
            </select>
          </label>
        </div>
        <div class="sc-actions">
          <button class="small-link save-slot" data-id="${dataId(s.id)}">Save slot</button>
          ${s.kind === "slot" ? '<button class="small-link d logout-slot" data-id="' + dataId(s.id) + '">Log out</button>' : ""}
          <button class="small-link d remove-slot" data-id="${dataId(s.id)}">Remove</button>
        </div>
      </div>`).join("");
    // Prefill zoom/hud/accountName from current slot states when the card is new.
    all.forEach((s) => {
      if (mem[s.id]) return;
      const card = slotForms.querySelector(`.slot-card[data-id="${s.id}"]`);
      if (card && s.kind === "slot") {
        const z = card.querySelector(".sf-zoom"); if (z) z.value = s.zoom || "1";
        const h = card.querySelector(".sf-hud"); if (h) h.value = String(s.hud !== false);
        const an = card.querySelector(".sf-account-name"); if (an && s.accountName) an.value = s.accountName;
      }
    });
    restoreSlotValues(mem);
  }

  function renderFormsIfChanged() {
    if (!isSettings) return;
    const ids = state.slots.map((s) => s.id).concat(state.ghosts.map((g) => g.id)).join(",");
    if (ids !== lastFormIds) renderSlotForms();
  }

  function gatherSlotPayloads() {
    const payloads = [];
    slotForms.querySelectorAll(".slot-card").forEach((card) => {
      const id = card.dataset.id;
      const accountName = card.querySelector(".sf-account-name").value.trim();
      const user = card.querySelector(".cred-user").value.trim();
      const pass = card.querySelector(".cred-pass").value;
      const zoom = Number(card.querySelector(".sf-zoom").value);
      const hud = card.querySelector(".sf-hud").value === "true";
      if (user || pass) payloads.push({ op: "creds", id, user, pass });
      payloads.push({ op: "flags", id, zoom, hud, accountName });
    });
    return payloads;
  }

  function saveAll() {
    const patch = {
      windowSize: { width: Number(sel("setW").value) || 1280, height: Number(sel("setH").value) || 850 },
      gridColumns: Number(sel("setGrid").value) || 0,
      zoomDefault: Number(sel("setZoom").value) || 100,
      delayMult: Number(sel("setDelay").value) || 1,
      pauseWhenHidden: sel("setPauseHidden").checked,
      adBlock: sel("setAdBlock").checked,
      lowRamMode: sel("setLowRam").checked,
      autoStart: sel("setAutoStart").checked
    };
    return vt.setSettings(patch).then(async () => {
      const payloads = gatherSlotPayloads();
      for (const p of payloads) {
        if (p.op === "creds") {
          await vt.setSlotCreds(p.id, p.user, p.pass);
          saveToHistory(p.user, p.accountName);
        } else {
          await vt.setSlotFlags(p.id, { zoom: p.zoom, hud: p.hud, accountName: p.accountName });
        }
      }
    });
  }

  function applySettingsToControls(s) {
    pauseToggle.checked = !!s.pauseWhenHidden;
    sel("setPauseHidden").checked = !!s.pauseWhenHidden;
    sel("setAdBlock").checked = s.adBlock === true;
    sel("setGrid").value = String(s.gridColumns || 0);
    sel("setZoom").value = String(s.zoomDefault || 100);
    sel("setDelay").value = String(s.delayMult || 1);
    sel("setLowRam").checked = s.lowRamMode !== false;
    sel("setAutoStart").checked = s.autoStart !== false;
    const ws = s.windowSize || {};
    sel("setW").value = ws.width || 1280;
    sel("setH").value = ws.height || 850;
  }

  // ---- mode init ----
  loadSavedHistory();
  updateDatalists();
  if (isSettings) {
    document.body.classList.add("settings-page");
    drawer.classList.remove("hidden");
    drawer.classList.add("settings-page");
    document.querySelector(".scr").style.display = "";
    const head = document.querySelector(".page-head");
    if (head) head.style.display = "";
    closeSettings.title = "Close settings window";
    closeSettings.style.display = "inline-block";
  }

  // ---- wiring ----
  vt.onState((st) => {
    state = st;
    renderChips();
    renderFormsIfChanged();
  });
  vt.getState().then((st) => {
    state = st;
    renderChips();
    applySettingsToControls(st.settings || {});
    if (isSettings) renderSlotForms();
  }).catch(() => {});

  if (isSettings) {
    saveSettings.addEventListener("click", () => {
      saveAll().then(() => {
        saveSettings.textContent = "Applied ✓";
        setTimeout(() => { saveSettings.textContent = "Apply"; }, 1500);
      }).catch(() => {});
    });
    addSlotBtn.addEventListener("click", () => {
      vt.addSlot().then(() => {
        setTimeout(() => {
          const cards = slotForms.querySelectorAll(".slot-card");
          if (cards.length) cards[cards.length - 1].scrollIntoView({ behavior: "smooth", block: "center" });
        }, 150);
      });
    });
    closeSettings.addEventListener("click", () => vt.closeSettingsWin());
    desktopShortcutBtn.addEventListener("click", () => {
      desktopShortcutBtn.textContent = "Creating…";
      vt.createDesktopShortcut().then((ok) => {
        desktopShortcutBtn.textContent = ok ? "Desktop shortcut created ✓" : "Shortcut failed";
        setTimeout(() => { desktopShortcutBtn.textContent = "+ Create desktop shortcut"; }, 2000);
      });
    });
    slotForms.addEventListener("click", async (e) => {
      const t = e.target;
      const id = t.dataset.id;
      if (t.classList.contains("logout-slot") && id) {
        await vt.logoutSlot(id);
        renderSlotForms();
      } else if (t.classList.contains("remove-slot") && id) {
        await vt.removeSlot(id);
      } else if (t.classList.contains("save-slot") && id) {
        const card = slotForms.querySelector(`.slot-card[data-id="${id}"]`);
        if (card) {
          const accountName = card.querySelector(".sf-account-name").value.trim();
          const user = card.querySelector(".cred-user").value.trim();
          const pass = card.querySelector(".cred-pass").value;
          await vt.setSlotFlags(id, {
            zoom: Number(card.querySelector(".sf-zoom").value),
            hud: card.querySelector(".sf-hud").value === "true",
            accountName
          });
          if (user || pass) await vt.setSlotCreds(id, user, pass);
          saveToHistory(user, accountName);
          t.textContent = "Saved ✓";
          setTimeout(() => { t.textContent = "Save slot"; }, 1200);
        }
      }
    });
  } else {
    gearBtn.addEventListener("click", () => vt.openSettings());
    addBtn.addEventListener("click", () => vt.addSlot());
    minBtn.addEventListener("click", () => vt.minimize());
    closeBtn.addEventListener("click", () => vt.close());
    pauseToggle.addEventListener("change", () => vt.pauseAll(pauseToggle.checked));
    const restartBtn = document.getElementById("restartBtn");
    const stopBtn = document.getElementById("stopBtn");
    const startBtn = document.getElementById("startBtn");
    const modeToggle = document.getElementById("modeToggle");
    if (modeToggle) {
      vt.getTaskMode().then((r) => {
        const m = (r && r.taskMode) || "color";
        modeToggle.querySelectorAll(".mode-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.mode === m);
        });
      });
      modeToggle.addEventListener("click", (e) => {
        const btn = e.target.closest(".mode-btn");
        if (!btn || !btn.dataset.mode) return;
        vt.setTaskMode(btn.dataset.mode).then(() => {
          modeToggle.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
        });
      });
    }
    if (restartBtn) restartBtn.addEventListener("click", () => { restartBtn.textContent = "…"; vt.restartAll().then(() => { setTimeout(() => { restartBtn.innerHTML = "&#8635;"; }, 1500); }); });
    if (stopBtn) stopBtn.addEventListener("click", () => { stopBtn.textContent = "…"; vt.stopAll().then(() => { setTimeout(() => { stopBtn.innerHTML = "&#9632;"; }, 1500); }); });
    if (startBtn) startBtn.addEventListener("click", () => { startBtn.textContent = "…"; vt.startAll().then(() => { setTimeout(() => { startBtn.innerHTML = "&#9654;"; }, 1500); }); });
    document.addEventListener("keydown", (e) => {
      if (e.altKey && !e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === "m") vt.addSlot();
      if (e.altKey && e.key.toLowerCase() === ",") vt.openSettings();
    });
  }
})();