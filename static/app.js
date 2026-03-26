// static/app.js

const aBusy = []; // My Schedule busy blocks
const bBusy = []; // Comparison editor busy blocks (legacy editor)
const comparisonSchedules = [];
let selectedComparisonId = null;
let activeProfileKey = null; // currently loaded profile ID in memory
let comparisonContextKey = null; // user ID that current comparison state belongs to
let comparisonDraftSourceUserKey = null; // source user for unsaved imported comparison draft
let comparisonNamePromptResolver = null;
let currentUser = null; // {username, displayName, friendCode} when authenticated
const USER_KEY_STORAGE_KEY = "timesync_user_id";
const USER_KEY_COOKIE_DAYS = 365;
const USER_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const THEME_STORAGE_KEY = "timesync_theme";
const THEME_COOKIE_KEY = "timesync_theme";
const THEME_COOKIE_DAYS = 365;

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ---------- Concept C Grid Constants ----------
const CELL_H = 44; // pixels per hour
const GRID_START_H = 8; // 8 AM
const GRID_END_H = 21; // 9 PM
const FRIEND_CLASSES = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
const FRIEND_COLORS = ['pink', 'cyan', 'amber', 'purple', 'green', 'rose'];
const AVATAR_COLORS = ['pink', 'cyan', 'amber', 'purple', 'green', 'rose'];

// ---------- Concept C state ----------
let individualEls = [];
let mergedEls = [];
let freeEls = [];
let mergedMode = false;
let freeMode = false;
const activePeople = new Set(['you']);

// ---------- Time helpers ----------
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function toHHMM(h, m) {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function minutesToHHMM(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return toHHMM(h, m);
}

function cloneBusyList(list) {
  return (list || []).map((b) => ({ day: b.day, start: b.start, end: b.end }));
}

function makeId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return `cmp-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  }
  return `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// "14:30" -> "2:30 PM"
function to12Hour(hhmm) {
  const [hhStr, mmStr] = hhmm.split(":");
  let hh = parseInt(hhStr, 10);
  const mm = parseInt(mmStr, 10);
  const ampm = hh >= 12 ? "PM" : "AM";
  hh = hh % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${String(mm).padStart(2, "0")} ${ampm}`;
}

function formatRange12(start, end) {
  return `${to12Hour(start)}–${to12Hour(end)}`;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ---------- Concept C data helpers ----------

// Convert "09:30" → 9.5
function hhmmToDecimal(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h + m / 60;
}

// Format decimal hours → "9:30 AM"
function decimalToTimeStr(t) {
  const h = Math.floor(t), m = Math.round((t % 1) * 60);
  const ap = t >= 12 ? 'PM' : 'AM';
  const hd = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return `${hd}:${m.toString().padStart(2, '0')} ${ap}`;
}

// Get all schedule blocks in Concept C format from current data
function getAllScheduleBlocks() {
  const blocks = [];

  // User's blocks
  aBusy.forEach(b => {
    const dayIdx = DAYS.indexOf(b.day);
    if (dayIdx === -1) return;
    const start = hhmmToDecimal(b.start);
    const end = hhmmToDecimal(b.end);
    blocks.push({
      day: dayIdx, start, end,
      label: 'Busy Block',
      sub: `${decimalToTimeStr(start)} – ${decimalToTimeStr(end)}`,
      cls: 'you'
    });
  });

  // Friends' blocks
  comparisonSchedules.forEach((comp, idx) => {
    const cls = FRIEND_CLASSES[idx] || `f${idx + 1}`;
    (comp.busy || []).forEach(b => {
      const dayIdx = DAYS.indexOf(b.day);
      if (dayIdx === -1) return;
      const start = hhmmToDecimal(b.start);
      const end = hhmmToDecimal(b.end);
      blocks.push({
        day: dayIdx, start, end,
        label: comp.name || 'Friend',
        sub: `${decimalToTimeStr(start)} – ${decimalToTimeStr(end)}`,
        cls
      });
    });
  });

  return blocks;
}

// ---------- Concept C grid building ----------

function buildGridStructure() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  grid.innerHTML = '';

  // corner
  const corner = document.createElement('div');
  corner.className = 'time-corner';
  grid.appendChild(corner);

  // Day headers with today highlight
  const today = new Date().getDay(); // 0=Sun, 1=Mon...
  const todayCol = today === 0 ? 6 : today - 1; // convert to Mon=0
  const now = new Date();
  DAYS.forEach((d, i) => {
    const dh = document.createElement('div');
    const dateNum = new Date(now);
    const diff = i - todayCol;
    dateNum.setDate(now.getDate() + diff);
    dh.className = 'day-header' + (i === todayCol ? ' today' : '');
    dh.innerHTML = `<div class="d-name">${d}</div><div class="d-num">${dateNum.getDate()}</div>`;
    grid.appendChild(dh);
  });

  // Time rows
  for (let h = GRID_START_H; h <= GRID_END_H; h++) {
    const ampm = h >= 12 ? 'p' : 'a';
    const disp = h > 12 ? h - 12 : h;
    const tl = document.createElement('div');
    tl.className = 't-label';
    tl.textContent = `${disp}${ampm}`;
    grid.appendChild(tl);
    for (let d = 0; d < 7; d++) {
      const c = document.createElement('div');
      c.className = 'grid-cell';
      grid.appendChild(c);
    }
  }
}

function getColMetrics() {
  const grid = document.getElementById('grid');
  if (!grid) return null;
  const cells = grid.querySelectorAll('.grid-cell');
  if (!cells.length) return null;
  const tw = grid.querySelector('.t-label')?.getBoundingClientRect().width || 44;
  const cw = cells[0].getBoundingClientRect().width;
  const headerH = grid.querySelector('.day-header')?.getBoundingClientRect().height || 44;
  return { tw, cw, headerH };
}

// ---------- Concept C block rendering ----------

function buildIndividualBlocks() {
  individualEls.forEach(el => el.remove());
  individualEls = [];

  const m = getColMetrics();
  if (!m) return;

  const grid = document.getElementById('grid');
  if (!grid) return;

  const allBlocks = getAllScheduleBlocks();
  allBlocks.forEach((b, idx) => {
    if (!activePeople.has(b.cls)) return;
    const el = document.createElement('div');
    el.className = `block ${b.cls} animate-in`;
    el.style.cssText = `
      top: ${m.headerH + (b.start - GRID_START_H) * CELL_H}px;
      height: ${(b.end - b.start) * CELL_H - 2}px;
      left: ${m.tw + b.day * m.cw + 2}px;
      width: ${m.cw - 4}px;
      animation-delay: ${idx * 18}ms;
    `;
    el.innerHTML = `<div class="block-name">${b.label}</div><div class="block-time">${b.sub}</div>`;
    grid.appendChild(el);
    individualEls.push(el);
  });
}

// ---------- Merge intervals algorithm ----------

function computeMergedIntervals() {
  const byDay = {};
  for (let d = 0; d < 7; d++) byDay[d] = [];

  getAllScheduleBlocks()
    .filter(b => activePeople.has(b.cls))
    .forEach(b => byDay[b.day].push({ start: b.start, end: b.end }));

  const result = {};
  for (let d = 0; d < 7; d++) {
    const ivs = byDay[d].sort((a, b) => a.start - b.start);
    const merged = [];
    for (const iv of ivs) {
      if (merged.length && iv.start <= merged[merged.length - 1].end) {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, iv.end);
      } else {
        merged.push({ ...iv });
      }
    }
    result[d] = merged;
  }
  return result;
}

function computeFreeIntervals(mergedBusy) {
  const WORK_START = GRID_START_H, WORK_END = GRID_END_H;
  const result = [];
  for (let d = 0; d < 5; d++) { // Mon–Fri only
    const busy = mergedBusy[d];
    let cursor = WORK_START;
    for (const b of busy) {
      if (b.start > cursor + 0.5) {
        result.push({ day: d, start: cursor, end: b.start });
      }
      cursor = Math.max(cursor, b.end);
    }
    if (cursor < WORK_END - 0.5) {
      result.push({ day: d, start: cursor, end: WORK_END });
    }
  }
  return result;
}

function buildMergedBlocks() {
  mergedEls.forEach(el => el.remove());
  mergedEls = [];
  const m = getColMetrics();
  if (!m) return;
  const grid = document.getElementById('grid');
  if (!grid) return;

  const merged = computeMergedIntervals();
  Object.entries(merged).forEach(([dayStr, ivs]) => {
    const d = parseInt(dayStr);
    ivs.forEach(iv => {
      const el = document.createElement('div');
      el.className = 'block merged fading-in';
      const dur = iv.end - iv.start;
      el.style.cssText = `
        top: ${m.headerH + (iv.start - GRID_START_H) * CELL_H}px;
        height: ${dur * CELL_H - 2}px;
        left: ${m.tw + d * m.cw + 2}px;
        width: ${m.cw - 4}px;
        transition: opacity 0.32s ease, transform 0.32s ease;
      `;
      const h = Math.floor(dur);
      const min = Math.round((dur % 1) * 60);
      const durStr = min ? `${h}h ${min}m` : `${h}h`;
      el.innerHTML = `<div class="block-name">Busy</div><div class="block-time">${durStr}</div>`;
      grid.appendChild(el);
      mergedEls.push(el);
    });
  });
}

function buildFreeBlocks() {
  freeEls.forEach(el => el.remove());
  freeEls = [];
  const m = getColMetrics();
  if (!m) return;
  const grid = document.getElementById('grid');
  if (!grid) return;

  const mergedBusy = computeMergedIntervals();
  const freeSlots = computeFreeIntervals(mergedBusy);

  // Update free panel
  const freeList = document.getElementById('free-list');
  const freeCnt = document.getElementById('free-cnt');
  if (freeList) freeList.innerHTML = '';
  if (freeCnt) freeCnt.textContent = freeSlots.length;

  const fmtH = t => {
    const h = Math.floor(t), m = Math.round((t % 1) * 60);
    const ap = t >= 12 ? 'PM' : 'AM';
    const hd = h > 12 ? h - 12 : h || 12;
    return `${hd}:${m.toString().padStart(2, '0')} ${ap}`;
  };
  const dur = (s, e) => {
    const d = e - s;
    const h = Math.floor(d), m = Math.round((d % 1) * 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  };

  freeSlots.forEach(slot => {
    const dayBusy = mergedBusy[slot.day] || [];
    const hasBefore = dayBusy.some(b => b.end <= slot.start + 0.01);
    const hasAfter = dayBusy.some(b => b.start >= slot.end - 0.01);
    const isSandwiched = hasBefore && hasAfter;

    if (freeList) {
      const row = document.createElement('div');
      row.className = 'free-item';
      row.innerHTML = `
        <span class="fi-day">${DAYS[slot.day].substring(0, 3).toUpperCase()}</span>
        <span class="fi-time">${fmtH(slot.start)} – ${fmtH(slot.end)}</span>
        <span class="fi-dur">${dur(slot.start, slot.end)}</span>
      `;
      freeList.appendChild(row);
    }

    if (!freeMode) return;
    const el = document.createElement('div');
    el.className = `block free ${isSandwiched ? 'sandwiched' : 'open'} animate-in`;
    el.style.cssText = `
      top: ${m.headerH + (slot.start - GRID_START_H) * CELL_H}px;
      height: ${(slot.end - slot.start) * CELL_H - 2}px;
      left: ${m.tw + slot.day * m.cw + 2}px;
      width: ${m.cw - 4}px;
    `;
    el.innerHTML = `<div class="block-name">Free Time</div><div class="block-time">${fmtH(slot.start)} – ${fmtH(slot.end)}</div>`;
    grid.appendChild(el);
    freeEls.push(el);
  });
}

// ---------- Toggle handlers ----------

function toggleFreeTime() {
  freeMode = !freeMode;
  const btn = document.getElementById('free-btn');
  const panel = document.getElementById('free-panel');
  if (btn) btn.classList.toggle('active', freeMode);
  if (panel) panel.style.display = freeMode ? 'block' : 'none';
  buildFreeBlocks();
}

function toggleMerge() {
  const btn = document.getElementById('merge-btn');

  if (!mergedMode) {
    mergedMode = true;
    if (btn) btn.classList.add('active');

    buildMergedBlocks();

    individualEls.forEach(el => {
      el.classList.add('fading-out');
    });

    setTimeout(() => {
      individualEls.forEach(el => el.classList.add('hidden-block'));
      mergedEls.forEach(el => {
        requestAnimationFrame(() => {
          el.classList.remove('fading-in');
          el.style.opacity = '1';
          el.style.transform = 'scaleY(1)';
        });
      });
    }, 320);

  } else {
    mergedMode = false;
    if (btn) btn.classList.remove('active');

    mergedEls.forEach(el => {
      el.style.opacity = '0';
      el.style.transform = 'scaleY(0.9)';
    });

    setTimeout(() => {
      mergedEls.forEach(el => el.remove());
      mergedEls = [];
      individualEls.forEach(el => {
        el.classList.remove('hidden-block', 'fading-out');
        el.style.opacity = '0';
        el.style.transform = 'scaleY(0.9)';
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            el.style.transition = 'opacity 0.28s ease, transform 0.28s ease';
            el.style.opacity = '1';
            el.style.transform = 'scaleY(1)';
          });
        });
      });
    }, 320);
  }
}

// ---------- Chips rendering ----------

function renderChips() {
  const container = document.getElementById('chips-container');
  if (!container) return;
  container.innerHTML = '';

  // Reset activePeople to just "you" initially, then re-add based on current state
  // Keep existing activePeople state if it has been modified
  if (!activePeople.has('you')) activePeople.add('you');

  // "You" chip
  const youChip = document.createElement('div');
  youChip.className = 'chip you' + (activePeople.has('you') ? ' active' : '');
  youChip.dataset.person = 'you';
  youChip.innerHTML = `<span class="dot"></span><span class="chip-label">You</span>`;
  youChip.onclick = () => toggleChip(youChip, 'you');
  container.appendChild(youChip);

  // Friend chips
  comparisonSchedules.forEach((comp, idx) => {
    const cls = FRIEND_CLASSES[idx] || `f${idx + 1}`;
    const chip = document.createElement('div');
    // Auto-add to activePeople if not already tracked
    if (!activePeople.has(cls)) activePeople.add(cls);
    chip.className = `chip ${cls}` + (activePeople.has(cls) ? ' active' : '');
    chip.dataset.person = cls;
    chip.innerHTML = `<span class="dot"></span><span class="chip-label">${comp.name || 'Friend'}</span>`;
    chip.onclick = () => toggleChip(chip, cls);
    container.appendChild(chip);
  });
}

function toggleChip(chip, person) {
  chip.classList.toggle('active');
  if (chip.classList.contains('active')) {
    activePeople.add(person);
  } else {
    activePeople.delete(person);
  }

  // Sync the corresponding fr-check in friends list
  const frCheck = document.querySelector(`.fr-check[data-cls="${person}"]`);
  if (frCheck) frCheck.classList.toggle('on', chip.classList.contains('active'));

  if (mergedMode) {
    mergedEls.forEach(el => el.remove());
    mergedEls = [];
    buildMergedBlocks();
    mergedEls.forEach(el => {
      requestAnimationFrame(() => {
        el.classList.remove('fading-in');
        el.style.opacity = '1';
        el.style.transform = 'scaleY(1)';
      });
    });
  } else {
    buildIndividualBlocks();
  }
  if (freeMode) buildFreeBlocks();
}

// ---------- Friends list rendering ----------

function renderFriendsList() {
  const list = document.getElementById('friends-list');
  const countEl = document.getElementById('friends-count');
  const badgeEl = document.getElementById('friends-count-badge');
  if (!list) return;
  list.innerHTML = '';

  const count = comparisonSchedules.length;
  if (countEl) countEl.textContent = count;
  if (badgeEl) badgeEl.textContent = count;

  comparisonSchedules.forEach((comp, idx) => {
    const color = AVATAR_COLORS[idx % AVATAR_COLORS.length];
    const initials = (comp.name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const cls = FRIEND_CLASSES[idx] || `f${idx + 1}`;
    const isActive = activePeople.has(cls);

    const row = document.createElement('div');
    row.className = 'fr-item';
    row.innerHTML = `
      <div class="fr-av ${color}">${initials}</div>
      <div class="fr-name">${comp.name || 'Friend'}</div>
      <div class="fr-code">${comp.sourceUserKey || ''}</div>
      <div class="fr-check ${isActive ? 'on' : ''}" data-cls="${cls}"></div>
    `;
    row.querySelector('.fr-check').onclick = function () {
      this.classList.toggle('on');
      const chip = document.querySelector(`.chip[data-person="${cls}"]`);
      if (chip) chip.click();
    };
    list.appendChild(row);
  });
}

// ---------- Your blocks list rendering ----------

function renderYourBlocks() {
  const list = document.getElementById('your-blocks-list');
  const countEl = document.getElementById('your-blocks-count');
  if (!list) return;
  list.innerHTML = '';
  if (countEl) countEl.textContent = aBusy.length;

  // Sort by day then time
  const sorted = [...aBusy].sort((a, b) => {
    const di = DAYS.indexOf(a.day) - DAYS.indexOf(b.day);
    if (di !== 0) return di;
    return a.start.localeCompare(b.start);
  });

  sorted.forEach(b => {
    const row = document.createElement('div');
    row.className = 'my-block-row';
    row.innerHTML = `
      <span class="mb-day">${b.day.slice(0, 3).toUpperCase()}</span>
      <span class="mb-name">Busy Block</span>
      <span class="mb-time">${to12Hour(b.start)}</span>
    `;
    list.appendChild(row);
  });
}

// ---------- Full re-render ----------

function renderAll() {
  buildGridStructure();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    renderChips();
    buildIndividualBlocks();
    renderFriendsList();
    renderYourBlocks();
    if (freeMode) buildFreeBlocks();
  }));
}

// ---------- Comparison name modal ----------

function closeComparisonNameModal(result) {
  const modal = document.getElementById("comparison-name-modal");
  if (!modal) {
    if (comparisonNamePromptResolver) {
      const resolve = comparisonNamePromptResolver;
      comparisonNamePromptResolver = null;
      resolve(result);
    }
    return;
  }

  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");

  if (comparisonNamePromptResolver) {
    const resolve = comparisonNamePromptResolver;
    comparisonNamePromptResolver = null;
    resolve(result);
  }
}

function initComparisonNameModal() {
  const modal = document.getElementById("comparison-name-modal");
  if (!modal) return;

  const input = document.getElementById("comparison-name-modal-input");
  const cancelBtn = document.getElementById("comparison-name-modal-cancel");
  const confirmBtn = document.getElementById("comparison-name-modal-confirm");

  const cancel = () => closeComparisonNameModal(null);
  const confirm = () => {
    const value = input.value.trim();
    if (!value) {
      input.focus();
      return;
    }
    closeComparisonNameModal(value);
  };

  cancelBtn.onclick = cancel;
  confirmBtn.onclick = confirm;

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirm();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });

  modal.addEventListener("click", (e) => {
    if (e.target === modal) cancel();
  });
}

function requestComparisonName(options = {}) {
  const {
    title = "Name Comparison Schedule",
    message = "Enter a name for this comparison schedule.",
    placeholder = "e.g. Alex",
    defaultValue = "",
  } = options;

  const modal = document.getElementById("comparison-name-modal");
  const titleEl = document.getElementById("comparison-name-modal-title");
  const messageEl = document.getElementById("comparison-name-modal-message");
  const input = document.getElementById("comparison-name-modal-input");

  if (!modal || !titleEl || !messageEl || !input) {
    const fallback = window.prompt(message, defaultValue);
    const trimmed = (fallback || "").trim();
    return Promise.resolve(trimmed || null);
  }

  if (comparisonNamePromptResolver) {
    const resolve = comparisonNamePromptResolver;
    comparisonNamePromptResolver = null;
    resolve(null);
  }

  titleEl.textContent = title;
  messageEl.textContent = message;
  input.placeholder = placeholder;
  input.value = defaultValue || "";

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");

  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);

  return new Promise((resolve) => {
    comparisonNamePromptResolver = resolve;
  });
}

// ---------- Dropdown time picker ----------
function fillTimePicker(prefix, defaults) {
  const hSel = document.getElementById(`${prefix}-h`);
  const mSel = document.getElementById(`${prefix}-m`);
  const apSel = document.getElementById(`${prefix}-ap`);

  if (!hSel || !mSel || !apSel) return;

  hSel.innerHTML = "";
  for (let h = 1; h <= 12; h++) {
    const opt = document.createElement("option");
    opt.value = String(h);
    opt.textContent = String(h);
    hSel.appendChild(opt);
  }

  mSel.innerHTML = "";
  for (let m = 0; m <= 55; m += 5) {
    const opt = document.createElement("option");
    opt.value = String(m);
    opt.textContent = String(m).padStart(2, "0");
    mSel.appendChild(opt);
  }

  apSel.innerHTML = "";
  ["AM", "PM"].forEach((ap) => {
    const opt = document.createElement("option");
    opt.value = ap;
    opt.textContent = ap;
    apSel.appendChild(opt);
  });

  hSel.value = String(defaults.h);
  mSel.value = String(defaults.m);
  apSel.value = defaults.ap;
}

function pickerValueToHHMM(prefix) {
  const h = parseInt(document.getElementById(`${prefix}-h`).value, 10);
  const m = parseInt(document.getElementById(`${prefix}-m`).value, 10);
  const ap = document.getElementById(`${prefix}-ap`).value;

  let hour24 = h % 12;
  if (ap === "PM") hour24 += 12;

  return toHHMM(hour24, m);
}

fillTimePicker("a-start", { h: 9, m: 0, ap: "AM" });
fillTimePicker("a-end", { h: 10, m: 0, ap: "AM" });
fillTimePicker("b-start", { h: 9, m: 30, ap: "AM" });
fillTimePicker("b-end", { h: 10, m: 30, ap: "AM" });

// ---------- Busy list UI ----------
function addBusy(prefix, arr, listId, onChange) {
  if (prefix === "b" && !selectedComparisonId) {
    setComparisonStatus("Create or select a named comparison before adding busy blocks.", true);
    return;
  }

  const dayContainer = document.getElementById(`${prefix}-days`);
  if (!dayContainer) return;
  const selectedDays = Array.from(dayContainer.querySelectorAll("input[type='checkbox']:checked"))
    .map((cb) => cb.value);

  if (selectedDays.length === 0) {
    alert("Select at least one day.");
    return;
  }

  const start = pickerValueToHHMM(`${prefix}-start`);
  const end = pickerValueToHHMM(`${prefix}-end`);

  if (!start || !end || start >= end) {
    alert("Start time must be before end time.");
    return;
  }

  for (const day of selectedDays) {
    arr.push({ day, start, end });
  }

  renderBusyList(arr, listId, onChange);
  if (onChange) onChange();
}

function renderBusyList(arr, listId, onChange) {
  const ul = document.getElementById(listId);
  if (!ul) return;
  ul.innerHTML = "";
  if (!arr.length) {
    const empty = document.createElement("li");
    empty.className = "busy-empty muted";
    empty.textContent = "No busy blocks added yet.";
    ul.appendChild(empty);
    return;
  }

  const byDay = new Map(DAYS.map((day) => [day, []]));
  arr.forEach((b, idx) => {
    if (!byDay.has(b.day)) return;
    byDay.get(b.day).push({ ...b, idx });
  });

  DAYS.forEach((day) => {
    const items = byDay.get(day);
    if (!items.length) return;

    items.sort((a, b) => {
      if (a.start !== b.start) return a.start.localeCompare(b.start);
      return a.end.localeCompare(b.end);
    });

    const group = document.createElement("li");
    group.className = "busy-day-group";

    const header = document.createElement("div");
    header.className = "busy-day-header";
    header.innerHTML = `
      <span class="busy-day-name">${day}</span>
      <span class="busy-day-count">${items.length} block${items.length === 1 ? "" : "s"}</span>
    `;
    group.appendChild(header);

    const rows = document.createElement("div");
    rows.className = "busy-day-items";

    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "busy-row";

      const text = document.createElement("span");
      text.className = "busy-row-time";
      text.textContent = formatRange12(item.start, item.end);
      row.appendChild(text);

      const del = document.createElement("button");
      del.textContent = "x";
      del.className = "del";
      del.onclick = () => {
        arr.splice(item.idx, 1);
        renderBusyList(arr, listId, onChange);
        if (onChange) onChange();
      };
      row.appendChild(del);

      rows.appendChild(row);
    });

    group.appendChild(rows);
    ul.appendChild(group);
  });
}

function replaceBusy(target, next) {
  target.length = 0;
  cloneBusyList(next).forEach((b) => target.push(b));
}

function replaceComparisonSchedules(next) {
  comparisonSchedules.length = 0;
  (next || []).forEach((c) => {
    comparisonSchedules.push({
      id: c.id || makeId(),
      name: (c.name || "Comparison").trim(),
      busy: cloneBusyList(c.busy || []),
      sourceUserKey: c.sourceUserKey || null,
      updatedAt: c.updatedAt || null,
    });
  });
}

function createComparisonSchedule({ name, busy = [], sourceUserKey = null }) {
  const trimmedName = (name || "").trim();
  if (!trimmedName) return null;

  const created = {
    id: makeId(),
    name: trimmedName,
    busy: cloneBusyList(busy),
    sourceUserKey: sourceUserKey || null,
    updatedAt: new Date().toISOString(),
  };

  comparisonSchedules.push(created);
  selectedComparisonId = created.id;
  comparisonDraftSourceUserKey = created.sourceUserKey;

  renderComparisonSelect();
  loadSelectedComparisonIntoEditor();
  return created;
}

function normalizeUserKeyInput(value) {
  return (value || "").trim().toLowerCase();
}

function isValidUserKey(value) {
  return USER_KEY_PATTERN.test(value);
}

function getProfileKey() {
  if (currentUser) return currentUser.username;
  const el = document.getElementById("schedule-key");
  return el ? normalizeUserKeyInput(el.value) : "";
}

function setWorkspaceLocked(locked) {
  document.body.classList.toggle("workspace-locked", Boolean(locked));
}

function syncActiveUserDisplay() {
  setWorkspaceLocked(!currentUser);
  updateUserInfoBar();
}

function updateUserInfoBar() {
  const infoBar = document.getElementById("user-info");
  const nameEl = document.getElementById("user-display-name");
  const codeEl = document.getElementById("user-friend-code");
  const myCodeEl = document.getElementById("my-friend-code");

  // New Concept C UI elements
  const friendCodeDisplay = document.getElementById("friend-code-display");
  const userAvatar = document.getElementById("user-avatar");

  if (currentUser) {
    if (infoBar) infoBar.classList.remove("hidden");
    if (nameEl) nameEl.textContent = currentUser.displayName;
    if (codeEl) codeEl.textContent = currentUser.friendCode;
    if (myCodeEl) myCodeEl.textContent = currentUser.friendCode;

    // Update new UI
    if (friendCodeDisplay) friendCodeDisplay.textContent = currentUser.friendCode || '------';
    if (userAvatar) {
      const initials = (currentUser.displayName || currentUser.username || '?')
        .split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
      userAvatar.textContent = initials;
    }
  } else {
    if (infoBar) infoBar.classList.add("hidden");
    if (friendCodeDisplay) friendCodeDisplay.textContent = '------';
    if (userAvatar) userAvatar.textContent = '?';
  }
}

// ---------- Auth ----------

function showAuthModal() {
  const modal = document.getElementById("auth-modal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  }
}

function hideAuthModal() {
  const modal = document.getElementById("auth-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }
}

function setAuthStatus(msg, isError = false) {
  const el = document.getElementById("auth-status");
  if (!el) return;
  el.textContent = msg;
  el.className = isError ? "persist-error auth-status" : "muted auth-status";
}

async function checkAuth() {
  try {
    const res = await fetch("/api/auth/me");
    const data = await res.json();
    if (data.ok) {
      currentUser = {
        username: data.username,
        displayName: data.displayName,
        friendCode: data.friendCode,
      };
      hideAuthModal();
      syncActiveUserDisplay();
      // Set hidden schedule-key for backward compat
      const skEl = document.getElementById("schedule-key");
      if (skEl) skEl.value = currentUser.username;
      await loadProfile();
      return true;
    }
  } catch (_err) {
    // Not authenticated
  }
  currentUser = null;
  showAuthModal();
  setWorkspaceLocked(true);
  return false;
}

async function signIn(username, password) {
  setAuthStatus("Signing in...");
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!data.ok) {
      setAuthStatus(data.error || "Sign in failed.", true);
      return false;
    }
    currentUser = {
      username: data.username,
      displayName: data.displayName,
      friendCode: data.friendCode,
    };
    const skEl = document.getElementById("schedule-key");
    if (skEl) skEl.value = currentUser.username;
    hideAuthModal();
    syncActiveUserDisplay();
    await loadProfile();
    return true;
  } catch (err) {
    setAuthStatus(`Error: ${String(err)}`, true);
    return false;
  }
}

async function signUp(username, password, displayName) {
  setAuthStatus("Creating account...");
  try {
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, displayName }),
    });
    const data = await res.json();
    if (!data.ok) {
      setAuthStatus(data.error || "Sign up failed.", true);
      return false;
    }
    currentUser = {
      username: data.username,
      displayName: data.displayName,
      friendCode: data.friendCode,
    };
    const skEl = document.getElementById("schedule-key");
    if (skEl) skEl.value = currentUser.username;
    hideAuthModal();
    syncActiveUserDisplay();
    await loadProfile();
    return true;
  } catch (err) {
    setAuthStatus(`Error: ${String(err)}`, true);
    return false;
  }
}

async function signOut() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch (_err) {
    // Ignore
  }
  currentUser = null;
  activeProfileKey = null;
  comparisonContextKey = null;
  replaceBusy(aBusy, []);
  replaceBusy(bBusy, []);
  replaceComparisonSchedules([]);
  selectedComparisonId = null;
  renderBusyList(aBusy, "a-list");
  renderBusyList(bBusy, "b-list", markComparisonDirty);
  renderComparisonSelect();
  clearDaySelections();
  renderAll();

  // Clear form fields and reset to Sign In tab
  const fields = ["auth-signin-username", "auth-signin-password", "auth-signup-username", "auth-signup-display", "auth-signup-password", "auth-signup-confirm"];
  fields.forEach((id) => { const el = document.getElementById(id); if (el) el.value = ""; });
  setAuthStatus("");

  // Reset to Sign In tab
  document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
  const signinTab = document.querySelector('.auth-tab[data-tab="signin"]');
  if (signinTab) signinTab.classList.add("active");
  document.querySelectorAll(".auth-tab-content").forEach((c) => c.classList.add("hidden"));
  const signinContent = document.getElementById("auth-tab-signin");
  if (signinContent) signinContent.classList.remove("hidden");

  showAuthModal();
  setWorkspaceLocked(true);
  updateUserInfoBar();
}

function initAuth() {
  // Tab switching
  const tabs = document.querySelectorAll(".auth-tab");
  tabs.forEach((tab) => {
    tab.onclick = () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll(".auth-tab-content").forEach((c) => c.classList.add("hidden"));
      const target = document.getElementById(`auth-tab-${tab.dataset.tab}`);
      if (target) target.classList.remove("hidden");
      setAuthStatus("");
    };
  });

  // Sign In
  const signInBtn = document.getElementById("auth-signin-btn");
  if (signInBtn) {
    signInBtn.onclick = () => {
      const username = (document.getElementById("auth-signin-username").value || "").trim().toLowerCase();
      const password = document.getElementById("auth-signin-password").value || "";
      if (!username || !password) {
        setAuthStatus("Username and password are required.", true);
        return;
      }
      signIn(username, password);
    };
  }

  // Sign Up
  const signUpBtn = document.getElementById("auth-signup-btn");
  if (signUpBtn) {
    signUpBtn.onclick = () => {
      const username = (document.getElementById("auth-signup-username").value || "").trim().toLowerCase();
      const displayName = (document.getElementById("auth-signup-display").value || "").trim();
      const password = document.getElementById("auth-signup-password").value || "";
      const confirm = document.getElementById("auth-signup-confirm").value || "";
      if (!username) {
        setAuthStatus("Username is required.", true);
        return;
      }
      if (password.length < 6) {
        setAuthStatus("Password must be at least 6 characters.", true);
        return;
      }
      if (password !== confirm) {
        setAuthStatus("Passwords do not match.", true);
        return;
      }
      signUp(username, password, displayName);
    };
  }

  // Enter key on auth inputs
  ["auth-signin-username", "auth-signin-password"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); signInBtn?.click(); }
    });
  });
  ["auth-signup-username", "auth-signup-display", "auth-signup-password", "auth-signup-confirm"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); signUpBtn?.click(); }
    });
  });

  // Sign Out
  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) logoutBtn.onclick = signOut;

  // Copy friend code buttons
  const copyBtns = ["copy-friend-code", "copy-friend-code-hero"];
  copyBtns.forEach((btnId) => {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.onclick = () => {
        if (!currentUser?.friendCode) return;
        navigator.clipboard.writeText(currentUser.friendCode).then(() => {
          btn.textContent = "Copied!";
          setTimeout(() => { btn.textContent = "Copy"; }, 1500);
        }).catch(() => {});
      };
    }
  });
}

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.body.classList.toggle("dark-mode", isDark);
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

  const toggleBtn = document.getElementById("theme-toggle");
  if (!toggleBtn) return;

  const iconEl = toggleBtn.querySelector(".theme-toggle-icon");
  const textEl = toggleBtn.querySelector(".theme-toggle-text");
  if (iconEl) iconEl.textContent = isDark ? "☀️" : "🌙";
  if (textEl) textEl.textContent = isDark ? "Light Mode" : "Dark Mode";

  // Update new theme icon SVG if present
  const svgIcon = document.getElementById("theme-icon");
  if (svgIcon) {
    svgIcon.innerHTML = isDark
      ? `<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>`
      : `<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>`;
  }
}

function readThemeFromCookie() {
  try {
    const key = `${THEME_COOKIE_KEY}=`;
    const parts = document.cookie.split(";");
    for (const rawPart of parts) {
      const part = rawPart.trim();
      if (part.startsWith(key)) {
        const value = decodeURIComponent(part.slice(key.length)).trim().toLowerCase();
        if (value === "dark" || value === "light") return value;
      }
    }
  } catch (_err) {
    // Ignore cookie read failures.
  }
  return "";
}

function persistThemePreference(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  try {
    localStorage.setItem(THEME_STORAGE_KEY, normalized);
  } catch (_err) {
    // Ignore localStorage write failures.
  }
  try {
    document.cookie = `${THEME_COOKIE_KEY}=${encodeURIComponent(normalized)}; Max-Age=${THEME_COOKIE_DAYS * 24 * 60 * 60}; Path=/; SameSite=Lax`;
  } catch (_err) {
    // Ignore cookie write failures.
  }
}

function initThemeToggle() {
  const toggleBtn = document.getElementById("theme-toggle");
  if (!toggleBtn) return;

  let savedTheme = "";
  try {
    savedTheme = (localStorage.getItem(THEME_STORAGE_KEY) || "").trim().toLowerCase();
  } catch (_err) {
    savedTheme = "";
  }
  if (savedTheme !== "dark" && savedTheme !== "light") {
    savedTheme = readThemeFromCookie();
  }

  const initialTheme = savedTheme === "dark" || savedTheme === "light"
    ? savedTheme
    : "light";
  applyTheme(initialTheme);
  persistThemePreference(initialTheme);

  toggleBtn.onclick = () => {
    const nextTheme = document.body.classList.contains("dark-mode") ? "light" : "dark";
    document.body.classList.add("theme-animating");
    applyTheme(nextTheme);
    persistThemePreference(nextTheme);

    setTimeout(() => {
      document.body.classList.remove("theme-animating");
    }, 420);
  };
}

function clearDaySelections() {
  ["a-days", "b-days"].forEach((containerId) => {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll("input[type='checkbox']").forEach((cb) => {
      cb.checked = false;
    });
  });
}

function readStoredUserKey() {
  let localValue = "";
  try {
    localValue = (localStorage.getItem(USER_KEY_STORAGE_KEY) || "").trim().toLowerCase();
  } catch (_err) {
    localValue = "";
  }

  if (localValue) return localValue;

  try {
    const key = `${USER_KEY_STORAGE_KEY}=`;
    const parts = document.cookie.split(";");
    for (const rawPart of parts) {
      const part = rawPart.trim();
      if (part.startsWith(key)) {
        return decodeURIComponent(part.slice(key.length)).trim().toLowerCase();
      }
    }
  } catch (_err) {
    // Ignore cookie read failures.
  }

  return "";
}

function persistUserKey(key) {
  const normalized = (key || "").trim().toLowerCase();

  try {
    if (normalized) localStorage.setItem(USER_KEY_STORAGE_KEY, normalized);
    else localStorage.removeItem(USER_KEY_STORAGE_KEY);
  } catch (_err) {
    // Ignore localStorage failures.
  }

  try {
    if (normalized) {
      document.cookie = `${USER_KEY_STORAGE_KEY}=${encodeURIComponent(normalized)}; Max-Age=${USER_KEY_COOKIE_DAYS * 24 * 60 * 60}; Path=/; SameSite=Lax`;
    } else {
      document.cookie = `${USER_KEY_STORAGE_KEY}=; Max-Age=0; Path=/; SameSite=Lax`;
    }
  } catch (_err) {
    // Ignore cookie write failures.
  }
}

function initUserKeyInput() {
  const input = document.getElementById("schedule-key");
  if (!input) return;
  const stored = readStoredUserKey();
  if (stored) input.value = stored;
  comparisonContextKey = getProfileKey() || null;

  const syncStoredKey = () => {
    const key = getProfileKey();
    persistUserKey(key);
    const comparisonHasData =
      bBusy.length > 0 ||
      comparisonSchedules.length > 0 ||
      (document.getElementById("comparison-name")?.value.trim().length > 0);

    if (comparisonContextKey && key !== comparisonContextKey && comparisonHasData) {
      resetComparisonContext();
      setPersistStatus("User ID changed. My Schedule kept. Comparison schedules reset for this account.");
      setImportStatus("");
    }

    if (activeProfileKey && key !== activeProfileKey) activeProfileKey = null;
    comparisonContextKey = key || null;
    syncActiveUserDisplay();
  };

  input.addEventListener("input", syncStoredKey);
  input.addEventListener("change", syncStoredKey);
  input.addEventListener("blur", syncStoredKey);
  syncActiveUserDisplay();
}

function initWorkspaceGate() {
  const gateInput = document.getElementById("gate-user-key");
  const mainInput = document.getElementById("schedule-key");
  const gateLoadBtn = document.getElementById("gate-load-profile");
  const gateCreateBtn = document.getElementById("gate-create-profile");

  if (gateInput && mainInput) {
    gateInput.value = normalizeUserKeyInput(mainInput.value);
    gateInput.addEventListener("input", () => {
      mainInput.value = normalizeUserKeyInput(gateInput.value);
      mainInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  if (gateLoadBtn && mainInput && gateInput) {
    gateLoadBtn.onclick = async () => {
      mainInput.value = normalizeUserKeyInput(gateInput.value);
      mainInput.dispatchEvent(new Event("change", { bubbles: true }));
      await loadProfile();
    };
  }

  if (gateCreateBtn && gateInput) {
    gateCreateBtn.onclick = async () => {
      await createNewSchedule(gateInput.value);
    };
  }
}

function setPersistStatus(msg, isError = false) {
  const el = document.getElementById("persist-status");
  if (!el) return;
  el.textContent = msg;
  el.className = isError ? "persist-error" : "muted";
}

function setImportStatus(msg, isError = false) {
  const el = document.getElementById("import-status");
  if (!el) return;
  el.textContent = msg;
  el.className = isError ? "persist-error" : "muted";
}

function setComparisonStatus(msg, isError = false) {
  const el = document.getElementById("comparison-status");
  if (!el) return;
  el.textContent = msg;
  el.className = isError ? "persist-error" : "muted";
}

function resetComparisonContext() {
  replaceBusy(bBusy, []);
  replaceComparisonSchedules([]);
  selectedComparisonId = null;

  renderBusyList(bBusy, "b-list", markComparisonDirty);
  renderComparisonSelect();
  const compName = document.getElementById("comparison-name");
  if (compName) compName.value = "";
  setComparisonStatus("No saved comparison selected.");
}

function getSelectedComparison() {
  return comparisonSchedules.find((c) => c.id === selectedComparisonId) || null;
}

function renderComparisonSelect() {
  const select = document.getElementById("comparison-select");
  const nameInput = document.getElementById("comparison-name");
  const deleteBtn = document.getElementById("delete-comparison");

  if (!select) return;

  select.innerHTML = "";

  if (comparisonSchedules.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No saved comparison schedules";
    select.appendChild(opt);
    selectedComparisonId = null;
    if (nameInput) nameInput.value = "";
    if (deleteBtn) deleteBtn.disabled = true;
    setComparisonStatus("No saved comparison selected.");
    return;
  }

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select comparison schedule";
  select.appendChild(placeholder);

  comparisonSchedules.forEach((item) => {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.name;
    select.appendChild(opt);
  });

  if (!selectedComparisonId || !comparisonSchedules.some((c) => c.id === selectedComparisonId)) {
    selectedComparisonId = comparisonSchedules[0].id;
  }

  select.value = selectedComparisonId || "";
  const selected = getSelectedComparison();
  if (nameInput) nameInput.value = selected ? selected.name : "";
  if (deleteBtn) deleteBtn.disabled = comparisonSchedules.length === 0;
}

function loadSelectedComparisonIntoEditor() {
  const selected = getSelectedComparison();

  if (!selected) {
    comparisonDraftSourceUserKey = null;
    replaceBusy(bBusy, []);
    renderBusyList(bBusy, "b-list", markComparisonDirty);
    setComparisonStatus("No saved comparison selected.");
    return;
  }

  comparisonDraftSourceUserKey = selected.sourceUserKey || null;
  replaceBusy(bBusy, selected.busy || []);
  renderBusyList(bBusy, "b-list", markComparisonDirty);
  const compName = document.getElementById("comparison-name");
  if (compName) compName.value = selected.name || "";
  setComparisonStatus(`Loaded "${selected.name}" into editor.`);
}

function markComparisonDirty() {
  comparisonContextKey = getProfileKey() || comparisonContextKey;
  const selected = getSelectedComparison();
  if (selected) {
    setComparisonStatus(`Unsaved changes in "${selected.name}".`);
  } else {
    setComparisonStatus("Unsaved comparison draft.");
  }
}

function saveComparisonFromEditor(options = {}) {
  const { silent = false, allowCreate = true } = options;
  const nameInput = document.getElementById("comparison-name");
  const rawName = nameInput ? nameInput.value.trim() : "";
  const name = rawName;

  if (!name) {
    if (!silent) setComparisonStatus("Enter a Comparison Name before saving.", true);
    return null;
  }

  let selected = getSelectedComparison();
  comparisonContextKey = getProfileKey() || comparisonContextKey;

  if (selected) {
    selected.name = name;
    selected.busy = cloneBusyList(bBusy);
    selected.updatedAt = new Date().toISOString();
  } else if (allowCreate) {
    selected = {
      id: makeId(),
      name,
      busy: cloneBusyList(bBusy),
      sourceUserKey: comparisonDraftSourceUserKey,
      updatedAt: new Date().toISOString(),
    };
    comparisonSchedules.push(selected);
    selectedComparisonId = selected.id;
  }

  comparisonDraftSourceUserKey = selected ? (selected.sourceUserKey || null) : null;

  renderComparisonSelect();
  const compSelect = document.getElementById("comparison-select");
  if (selectedComparisonId && compSelect) {
    compSelect.value = selectedComparisonId;
  }

  if (!silent && selected) {
    setComparisonStatus(`Saved "${selected.name}".`);
  }

  return selected;
}

async function startNewComparisonDraft() {
  const defaultName = `Comparison ${comparisonSchedules.length + 1}`;
  const name = await requestComparisonName({
    title: "New Comparison Schedule",
    message: "Enter a name for the new comparison schedule.",
    placeholder: "e.g. Alex",
    defaultValue: defaultName,
  });

  if (!name) {
    setComparisonStatus("New comparison canceled.");
    return;
  }

  const created = createComparisonSchedule({ name, busy: [], sourceUserKey: null });
  if (!created) {
    setComparisonStatus("Comparison name is required.", true);
    return;
  }

  setComparisonStatus(`Created "${created.name}". Add busy blocks.`);
}

async function deleteSelectedComparison() {
  const selected = getSelectedComparison();
  if (!selected) {
    setComparisonStatus("Select a comparison schedule to delete.", true);
    return;
  }

  const confirmed = window.confirm(`Delete "${selected.name}"? This cannot be undone.`);
  if (!confirmed) return;

  const idx = comparisonSchedules.findIndex((c) => c.id === selected.id);
  if (idx === -1) {
    setComparisonStatus("Selected comparison was not found.", true);
    return;
  }

  comparisonSchedules.splice(idx, 1);
  selectedComparisonId = null;
  comparisonDraftSourceUserKey = null;

  replaceBusy(bBusy, []);
  renderBusyList(bBusy, "b-list", markComparisonDirty);
  const compName = document.getElementById("comparison-name");
  if (compName) compName.value = "";
  renderComparisonSelect();
  setComparisonStatus(`Deleted "${selected.name}".`);
  renderAll();

  const key = getProfileKey();
  if (!key) {
    setPersistStatus("Comparison deleted locally. Enter User ID and click Update Schedule to persist.");
    return;
  }
  if (!activeProfileKey || key !== activeProfileKey) {
    setPersistStatus("Comparison deleted locally. Load or create this profile, then click Update Schedule to persist.");
    return;
  }

  const ok = await saveProfile({ silent: true });
  if (ok) setPersistStatus(`Deleted comparison "${selected.name}" from your profile.`);
}

function resetAllEditorsForCurrentProfile() {
  replaceBusy(aBusy, []);
  replaceBusy(bBusy, []);
  replaceComparisonSchedules([]);
  selectedComparisonId = null;
  comparisonDraftSourceUserKey = null;

  renderBusyList(aBusy, "a-list");
  renderBusyList(bBusy, "b-list", markComparisonDirty);
  renderComparisonSelect();
  setComparisonStatus("No saved comparison selected.");
  setImportStatus("");
}

async function createNewSchedule(preferredUserKey = "") {
  let key = normalizeUserKeyInput(preferredUserKey);

  if (!key) {
    const requestedKey = await requestComparisonName({
      title: "Create New Schedule",
      message: "Enter a new User ID. Existing IDs cannot be overwritten here.",
      placeholder: "e.g. alex-2026",
      defaultValue: "",
    });

    if (!requestedKey) {
      setPersistStatus("Create new schedule canceled.");
      return;
    }
    key = normalizeUserKeyInput(requestedKey);
  }

  if (!isValidUserKey(key)) {
    setPersistStatus("User ID must be 3-32 chars: lowercase letters, numbers, '-' or '_'.", true);
    return;
  }

  setPersistStatus(`Checking availability for "${key}"...`);

  try {
    const res = await fetch(`/api/profiles/${encodeURIComponent(key)}`);
    const data = await res.json();
    if (!data.ok) {
      setPersistStatus(data.error || "Failed to check User ID availability.", true);
      return;
    }

    const hasExistingData =
      Boolean(data.updatedAt) ||
      Boolean((data.mySchedule?.busy || []).length) ||
      Boolean((data.comparisonSchedules || []).length);

    if (hasExistingData) {
      setPersistStatus(`User ID "${key}" already exists. Load it instead, or choose another.`, true);
      return;
    }

    const skEl = document.getElementById("schedule-key");
    if (skEl) skEl.value = key;
    persistUserKey(key);
    activeProfileKey = key;
    comparisonContextKey = key;
    syncActiveUserDisplay();

    resetAllEditorsForCurrentProfile();
    setPersistStatus(`Created new schedule "${key}". Add busy blocks, then click Update Schedule.`);
  } catch (err) {
    setPersistStatus(`Error creating schedule workspace: ${String(err)}`, true);
  }
}

function maybeSaveDraftIntoComparisons() {
  const compName = document.getElementById("comparison-name");
  const hasName = compName ? compName.value.trim().length > 0 : false;
  if (selectedComparisonId) {
    saveComparisonFromEditor({ silent: true, allowCreate: true });
    return;
  }
  if (hasName) {
    saveComparisonFromEditor({ silent: true, allowCreate: true });
  }
}

async function loadProfile() {
  const key = getProfileKey();
  if (!key) {
    activeProfileKey = null;
    syncActiveUserDisplay();
    setPersistStatus("Sign in to load your schedule.", true);
    return;
  }

  setPersistStatus("Loading profile...");
  setImportStatus("");

  try {
    const res = await fetch(`/api/profiles/${encodeURIComponent(key)}`);
    const data = await res.json();

    if (!data.ok) {
      if (res.status === 401) {
        setPersistStatus("Session expired. Please sign in again.", true);
        showAuthModal();
        return;
      }
      activeProfileKey = key;
      comparisonContextKey = key;
      syncActiveUserDisplay();
      setPersistStatus("New account — add busy blocks and save.");
      renderAll();
      return;
    }

    replaceBusy(aBusy, data.mySchedule?.busy || []);
    renderBusyList(aBusy, "a-list");

    replaceComparisonSchedules(data.comparisonSchedules || []);
    selectedComparisonId = data.selectedComparisonId || null;
    renderComparisonSelect();
    loadSelectedComparisonIntoEditor();
    activeProfileKey = key;
    comparisonContextKey = key;
    syncActiveUserDisplay();
    clearDaySelections();

    const when = data.updatedAt
      ? `Schedule loaded (updated ${new Date(data.updatedAt).toLocaleString()}).`
      : "Schedule loaded.";
    setPersistStatus(when);

    // Refresh Concept C grid with loaded data
    renderAll();
  } catch (err) {
    activeProfileKey = null;
    syncActiveUserDisplay();
    setPersistStatus(`Error loading profile: ${String(err)}`, true);
  }
}

function ensureProfileContextForUpdate(key) {
  if (!activeProfileKey) {
    setPersistStatus("Load a profile or create a new schedule before updating.", true);
    return false;
  }
  if (key !== activeProfileKey) {
    setPersistStatus(
      `User ID changed from "${activeProfileKey}" to "${key}". Click Load Profile or Create New Schedule first.`,
      true
    );
    return false;
  }
  return true;
}

async function saveProfile(options = {}) {
  const { silent = false, requireLoadedContext = true } = options;
  const key = getProfileKey();
  if (!key || !currentUser) {
    setPersistStatus("Sign in to save your schedule.", true);
    return false;
  }
  if (requireLoadedContext && !ensureProfileContextForUpdate(key)) {
    return false;
  }

  const compName = document.getElementById("comparison-name");
  const draftName = compName ? compName.value.trim() : "";
  if (!selectedComparisonId && bBusy.length > 0 && !draftName) {
    setPersistStatus("Name the imported comparison and click Save Comparison before updating.", true);
    return false;
  }

  maybeSaveDraftIntoComparisons();
  if (!silent) setPersistStatus("Saving...");

  try {
    const payload = {
      mySchedule: {
        name: "My Schedule",
        busy: cloneBusyList(aBusy),
      },
      comparisonSchedules: comparisonSchedules.map((c) => ({
        id: c.id,
        name: c.name,
        busy: cloneBusyList(c.busy),
        sourceUserKey: c.sourceUserKey || null,
        updatedAt: c.updatedAt || null,
      })),
      selectedComparisonId,
    };

    const res = await fetch(`/api/profiles/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!data.ok) {
      if (res.status === 401) {
        setPersistStatus("Session expired. Please sign in again.", true);
        showAuthModal();
        return false;
      }
      setPersistStatus(data.error || "Failed to save schedule.", true);
      return false;
    }

    const when = data.updatedAt
      ? new Date(data.updatedAt).toLocaleString()
      : "just now";
    if (!silent) setPersistStatus(`Schedule saved at ${when}.`);
    activeProfileKey = key;
    comparisonContextKey = key;
    syncActiveUserDisplay();
    return true;
  } catch (err) {
    setPersistStatus(`Error saving schedule: ${String(err)}`, true);
    return false;
  }
}

async function importFriendSchedule() {
  const key = getProfileKey();
  if (!key || !currentUser) {
    setImportStatus("Sign in first.", true);
    return;
  }

  // Try friend code input first, fall back to friend-user-key for backward compat
  const codeInput = document.getElementById("friend-code-input");
  const legacyInput = document.getElementById("friend-user-key");
  const friendCode = (codeInput?.value || "").trim().toUpperCase();
  const friendKey = (legacyInput?.value || "").trim().toLowerCase();

  if (!friendCode && !friendKey) {
    setImportStatus("Enter a friend code to import.", true);
    return;
  }

  setImportStatus("Importing friend schedule...");

  try {
    let res, data;
    let friendLabel;
    if (friendCode) {
      res = await fetch(`/api/public-schedules/by-code/${encodeURIComponent(friendCode)}`);
      data = await res.json();
      friendLabel = data.displayName || friendCode;
    } else {
      res = await fetch(`/api/public-schedules/${encodeURIComponent(friendKey)}`);
      data = await res.json();
      friendLabel = friendKey;
    }

    if (!data.ok) {
      setImportStatus(data.error || "Failed to import friend schedule.", true);
      return;
    }

    const name = await requestComparisonName({
      title: "Name Imported Comparison",
      message: `Enter a name for ${friendLabel}'s schedule.`,
      placeholder: "e.g. James - Work Week",
      defaultValue: friendLabel,
    });
    if (!name) {
      setImportStatus("Import canceled.");
      return;
    }

    const sourceKey = data.userKey || friendKey || friendCode;
    const created = createComparisonSchedule({
      name,
      busy: data.mySchedule?.busy || [],
      sourceUserKey: sourceKey,
    });
    if (!created) {
      setImportStatus("Comparison name is required.", true);
      return;
    }

    comparisonContextKey = key;
    setComparisonStatus(`Saved "${created.name}".`);
    setImportStatus(`Imported "${friendLabel}" as "${created.name}".`);
    if (codeInput) codeInput.value = "";
    await saveProfile({ silent: true });
    renderAll();
  } catch (err) {
    setImportStatus(`Import error: ${String(err)}`, true);
  }
}

// ---------- Import friend by code (new Concept C flow) ----------
async function importFriendByCode(friendCode) {
  try {
    const res = await fetch(`/api/friend/${encodeURIComponent(friendCode)}`);
    const data = await res.json();
    if (!data.ok) { alert(data.error || 'Friend not found'); return; }
    const name = data.displayName || data.username || friendCode;
    createComparisonSchedule({ name, busy: data.busy || [], sourceUserKey: friendCode });
    await saveProfile({ silent: true });
    renderAll();
  } catch (e) {
    alert('Error adding friend: ' + e);
  }
}

// ---------- Merge intervals utility (legacy, kept for compat) ----------
function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged = [{ start: sorted[0].start, end: sorted[0].end }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }
  return merged;
}

// ---------- Compare (legacy, updated to call renderAll) ----------
const compareBtn = document.getElementById("compare");
if (compareBtn) {
  compareBtn.onclick = async () => {
    const selected = getSelectedComparison();
    const comparisonName = (document.getElementById("comparison-name")?.value.trim() || selected?.name || "Comparison Schedule");
    const compareStatus = document.getElementById("comparison-status-global");
    if (compareStatus) compareStatus.textContent = "Comparing schedules...";

    // Update bBusy from selected comparison for legacy compat
    if (selected) {
      replaceBusy(bBusy, selected.busy || []);
    }

    renderAll();

    if (compareStatus) compareStatus.textContent = "Comparison updated.";
  };
}

// ---------- Event wiring ----------
const aAddBtn = document.getElementById("a-add");
if (aAddBtn) {
  aAddBtn.onclick = () => {
    addBusy("a", aBusy, "a-list");
    renderAll();
  };
}

const bAddBtn = document.getElementById("b-add");
if (bAddBtn) {
  bAddBtn.onclick = () => addBusy("b", bBusy, "b-list", markComparisonDirty);
}

const compSelect = document.getElementById("comparison-select");
if (compSelect) {
  compSelect.onchange = (e) => {
    selectedComparisonId = e.target.value || null;
    loadSelectedComparisonIntoEditor();
  };
}

const newComparisonBtn = document.getElementById("new-comparison");
if (newComparisonBtn) {
  newComparisonBtn.onclick = async () => {
    await startNewComparisonDraft();
    const key = getProfileKey();
    if (key && activeProfileKey && key === activeProfileKey) {
      await saveProfile({ silent: true });
    }
    renderAll();
  };
}

const saveComparisonBtn = document.getElementById("save-comparison");
if (saveComparisonBtn) {
  saveComparisonBtn.onclick = async () => {
    const saved = saveComparisonFromEditor({ silent: false, allowCreate: true });
    if (!saved) return;
    const key = getProfileKey();
    if (!key) {
      setPersistStatus("Comparison saved locally. Enter User ID and click Update Schedule to persist.");
      return;
    }
    if (!activeProfileKey || key !== activeProfileKey) {
      setPersistStatus("Comparison saved locally. Load or create this profile, then click Update Schedule to persist.");
      return;
    }
    const ok = await saveProfile({ silent: true });
    if (ok) setPersistStatus(`Saved comparison "${saved.name}" to your profile.`);
    renderAll();
  };
}

const deleteComparisonBtn = document.getElementById("delete-comparison");
if (deleteComparisonBtn) {
  deleteComparisonBtn.onclick = deleteSelectedComparison;
}

const compNameInput = document.getElementById("comparison-name");
if (compNameInput) {
  compNameInput.oninput = markComparisonDirty;
}

const loadProfileBtn = document.getElementById("load-profile");
if (loadProfileBtn) loadProfileBtn.onclick = async () => { await loadProfile(); };

const updateProfileBtn = document.getElementById("update-profile") || document.getElementById("save-profile");
if (updateProfileBtn) {
  updateProfileBtn.onclick = () => saveProfile({ silent: false, requireLoadedContext: false });
}

const createProfileBtn = document.getElementById("create-profile");
if (createProfileBtn) {
  createProfileBtn.onclick = createNewSchedule;
}

const importFriendBtn = document.getElementById("import-friend");
if (importFriendBtn) importFriendBtn.onclick = importFriendSchedule;

// ---------- Schedule Import System ----------

let pendingImportBlocks = [];
let importImageFile = null;

function initImportModal() {
  const modal = document.getElementById("import-schedule-modal");
  if (!modal) return;

  const cancelBtn = document.getElementById("import-modal-cancel");
  const confirmBtn = document.getElementById("import-modal-confirm");
  const closeBtn = document.getElementById("import-close-btn");

  // Tab switching
  modal.querySelectorAll(".import-tab").forEach((tab) => {
    tab.onclick = () => {
      modal.querySelectorAll(".import-tab").forEach((t) => t.classList.remove("active"));
      modal.querySelectorAll(".import-tab-content").forEach((c) => c.classList.add("hidden"));
      tab.classList.add("active");
      const target = document.getElementById("tab-" + tab.dataset.tab);
      if (target) target.classList.remove("hidden");
    };
  });

  // Cancel / close
  if (cancelBtn) cancelBtn.onclick = () => closeImportModal();
  if (closeBtn) closeBtn.onclick = () => closeImportModal();
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeImportModal();
  });

  // Confirm import
  if (confirmBtn) confirmBtn.onclick = () => executeImport();

  // Import target toggle
  const targetSelect = document.getElementById("import-target");
  const compNameInputModal = document.getElementById("import-comparison-name");
  if (targetSelect && compNameInputModal) {
    targetSelect.onchange = () => {
      compNameInputModal.classList.toggle("hidden", targetSelect.value !== "comparison");
    };
  }

  // Screenshot upload
  initScreenshotUpload();

  // Text paste
  const parseTextBtn = document.getElementById("parse-text-btn");
  if (parseTextBtn) {
    parseTextBtn.onclick = () => parseScheduleText();
  }

  // Generate bookmarklet link
  generateBookmarkletLink();
}

function openImportModal() {
  const modal = document.getElementById("import-schedule-modal");
  if (!modal) return;

  pendingImportBlocks = [];
  importImageFile = null;
  hideImportPreview();

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");

  // Reset upload state
  const preview = document.getElementById("upload-preview");
  if (preview) preview.classList.add("hidden");
  const parseBtn = document.getElementById("upload-parse-btn");
  if (parseBtn) parseBtn.disabled = true;
  const uploadStatus = document.getElementById("upload-status");
  if (uploadStatus) uploadStatus.textContent = "";
  const pasteStatus = document.getElementById("paste-status");
  if (pasteStatus) pasteStatus.textContent = "";

  // Reset confirm button
  const confirmBtn = document.getElementById("import-modal-confirm");
  if (confirmBtn) confirmBtn.disabled = true;
}

function closeImportModal() {
  const modal = document.getElementById("import-schedule-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  pendingImportBlocks = [];
  importImageFile = null;
}

function hideImportPreview() {
  const section = document.getElementById("import-preview-section");
  if (section) section.classList.add("hidden");
  const confirmBtn = document.getElementById("import-modal-confirm");
  if (confirmBtn) confirmBtn.disabled = true;
}

function showImportPreview(blocks) {
  pendingImportBlocks = blocks;
  const section = document.getElementById("import-preview-section");
  const list = document.getElementById("import-preview-list");
  const count = document.getElementById("import-block-count");
  const confirmBtn = document.getElementById("import-modal-confirm");

  if (!section || !list || !count) return;

  count.textContent = String(blocks.length);

  // Group by day
  const byDay = {};
  DAYS.forEach((d) => { byDay[d] = []; });
  blocks.forEach((b) => {
    if (byDay[b.day]) byDay[b.day].push(b);
  });

  list.innerHTML = "";
  DAYS.forEach((day) => {
    const items = byDay[day];
    if (!items || !items.length) return;
    items.sort((a, b) => a.start.localeCompare(b.start));
    items.forEach((item) => {
      const div = document.createElement("div");
      div.className = "import-preview-item";
      div.innerHTML = `
        <span class="import-preview-day">${item.day}</span>
        <span class="import-preview-name">${item.name || "Busy"}</span>
        <span class="import-preview-time">${formatRange12(item.start, item.end)}</span>
      `;
      list.appendChild(div);
    });
  });

  section.classList.remove("hidden");
  if (confirmBtn) confirmBtn.disabled = false;
}

function initScreenshotUpload() {
  const dropzone = document.getElementById("upload-dropzone");
  const fileInput = document.getElementById("schedule-image-input");
  const preview = document.getElementById("upload-preview");
  const previewImg = document.getElementById("upload-preview-img");
  const removeBtn = document.getElementById("upload-remove");
  const parseBtn = document.getElementById("upload-parse-btn");

  if (!dropzone || !fileInput) return;

  dropzone.onclick = () => fileInput.click();

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type.startsWith("image/")) {
      handleImageFile(files[0]);
    }
  });

  fileInput.onchange = () => {
    if (fileInput.files.length > 0) {
      handleImageFile(fileInput.files[0]);
    }
  };

  if (removeBtn) {
    removeBtn.onclick = () => {
      importImageFile = null;
      if (preview) preview.classList.add("hidden");
      if (parseBtn) parseBtn.disabled = true;
      if (previewImg) previewImg.src = "";
      fileInput.value = "";
      hideImportPreview();
    };
  }

  if (parseBtn) {
    parseBtn.onclick = () => parseScheduleImage();
  }

  function handleImageFile(file) {
    importImageFile = file;
    if (previewImg) {
      const reader = new FileReader();
      reader.onload = (e) => {
        previewImg.src = e.target.result;
        if (preview) preview.classList.remove("hidden");
      };
      reader.readAsDataURL(file);
    }
    if (parseBtn) parseBtn.disabled = false;
    hideImportPreview();
  }
}

async function parseScheduleImage() {
  if (!importImageFile) return;

  const status = document.getElementById("upload-status");
  const parseBtn = document.getElementById("upload-parse-btn");

  if (status) status.textContent = "Extracting schedule from image (this may take a moment)...";
  if (status) status.className = "muted";
  if (parseBtn) parseBtn.disabled = true;

  try {
    const formData = new FormData();
    formData.append("image", importImageFile);

    const res = await fetch("/api/parse-schedule-image", {
      method: "POST",
      body: formData,
    });
    const data = await res.json();

    if (!data.ok) {
      if (status) {
        status.textContent = data.error || "Failed to parse image.";
        status.className = "persist-error";
      }
      if (parseBtn) parseBtn.disabled = false;
      return;
    }

    // If OCR found few or no results, dump text to Paste tab and warn
    if (!data.blocks || data.blocks.length < 3) {
      if (data.ocrText) {
        const textarea = document.getElementById("schedule-text-input");
        if (textarea) textarea.value = data.ocrText;
      }
      if (!data.blocks || data.blocks.length === 0) {
        if (status) {
          status.textContent =
            "OCR couldn't reliably read this image. Raw text has been copied to the Paste Text tab — " +
            "try switching there and editing/replacing it, or use the Paste Text tab with your schedule text directly.";
          status.className = "persist-error";
        }
        if (parseBtn) parseBtn.disabled = false;
        return;
      }
      if (status) {
        status.textContent =
          `OCR found only ${data.blocks.length} blocks (may be incomplete). ` +
          `Raw OCR text copied to Paste Text tab. You can review results below or try Paste Text for better accuracy.`;
        status.className = "persist-error";
      }
      showImportPreview(data.blocks);
      if (parseBtn) parseBtn.disabled = false;
      return;
    }

    if (status) {
      status.textContent = `Found ${data.blocks.length} class blocks!`;
      status.className = "muted";
    }
    showImportPreview(data.blocks);
  } catch (err) {
    if (status) {
      status.textContent = `Error: ${String(err)}`;
      status.className = "persist-error";
    }
  }
  if (parseBtn) parseBtn.disabled = false;
}

async function parseScheduleText() {
  const textarea = document.getElementById("schedule-text-input");
  const status = document.getElementById("paste-status");
  const rawText = (textarea ? textarea.value : "").trim();

  if (!rawText) {
    if (status) {
      status.textContent = "Paste your schedule text first.";
      status.className = "persist-error";
    }
    return;
  }

  if (status) {
    status.textContent = "Parsing schedule...";
    status.className = "muted";
  }

  try {
    const res = await fetch("/api/parse-schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: rawText }),
    });
    const data = await res.json();

    if (!data.ok) {
      if (status) {
        status.textContent = data.error || "Failed to parse text.";
        status.className = "persist-error";
      }
      return;
    }

    if (!data.blocks || data.blocks.length === 0) {
      if (status) {
        status.textContent = data.message || "No schedule entries found. Check the format.";
        status.className = "persist-error";
      }
      return;
    }

    if (status) {
      status.textContent = `Found ${data.blocks.length} class blocks!`;
      status.className = "muted";
    }
    showImportPreview(data.blocks);
  } catch (err) {
    if (status) {
      status.textContent = `Error: ${String(err)}`;
      status.className = "persist-error";
    }
  }
}

function executeImport() {
  if (!pendingImportBlocks.length) return;

  const targetEl = document.getElementById("import-target");
  const target = targetEl ? targetEl.value : "my-schedule";
  const busyBlocks = pendingImportBlocks.map((b) => ({
    day: b.day,
    start: b.start,
    end: b.end,
  }));

  if (target === "my-schedule") {
    replaceBusy(aBusy, busyBlocks);
    renderBusyList(aBusy, "a-list");
    closeImportModal();
    setPersistStatus(
      `Imported ${busyBlocks.length} blocks into My Schedule. Click "Update Schedule" to save.`
    );
    renderAll();
  } else {
    let name = (document.getElementById("import-comparison-name")?.value || "").trim();
    if (!name) name = "Imported Schedule";

    const created = createComparisonSchedule({
      name,
      busy: busyBlocks,
      sourceUserKey: null,
    });

    if (created) {
      closeImportModal();
      setComparisonStatus(`Imported ${busyBlocks.length} blocks as "${created.name}".`);
      setPersistStatus(`Click "Update Schedule" to save the imported comparison.`);
      renderAll();
    }
  }
}

function generateBookmarkletLink() {
  const link = document.getElementById("bookmarklet-link");
  if (!link) return;

  const origin = window.location.origin;
  const bookmarkletCode = `javascript:void(function(){var s=document.createElement('script');s.src='${origin}/static/bookmarklet-cpp.js?t='+Date.now();window.TIMESYNC_ORIGIN='${origin}';document.body.appendChild(s)})()`;

  link.href = bookmarkletCode;

  link.addEventListener("click", (e) => {
    e.preventDefault();
    alert(
      "Drag this button to your bookmarks bar!\n\n" +
      "Then visit your CPP schedule page and click the bookmark to import your schedule."
    );
  });
}

function checkUrlForImportData() {
  const params = new URLSearchParams(window.location.search);
  const importData = params.get("import_schedule");
  const importClipboard = params.get("import_clipboard");

  if (importData) {
    try {
      const blocks = JSON.parse(decodeURIComponent(importData));
      if (Array.isArray(blocks) && blocks.length > 0) {
        window.history.replaceState({}, "", window.location.pathname);

        setTimeout(() => {
          openImportModal();
          showImportPreview(blocks);

          const pasteStatus = document.getElementById("paste-status");
          if (pasteStatus) {
            pasteStatus.textContent = `Schedule data received from bookmarklet! ${blocks.length} blocks found.`;
            pasteStatus.className = "muted";
          }
        }, 500);
      }
    } catch (e) {
      console.error("Failed to parse import_schedule data:", e);
    }
  }

  if (importClipboard) {
    window.history.replaceState({}, "", window.location.pathname);
    setTimeout(() => {
      openImportModal();
      const pastTab = document.querySelector('.import-tab[data-tab="paste"]');
      if (pastTab) pastTab.click();

      const pasteStatus = document.getElementById("paste-status");
      if (pasteStatus) {
        pasteStatus.textContent = "Schedule data is in your clipboard. Paste it in the text area above and click Parse.";
        pasteStatus.className = "muted";
      }
    }, 500);
  }
}

// ---------- New Concept C UI wiring ----------

// Friend code pill copy
document.getElementById('friend-code-display')?.addEventListener('click', function () {
  const code = this.textContent;
  if (code && code !== '------') {
    navigator.clipboard.writeText(code).catch(() => {});
    const orig = this.textContent;
    this.textContent = 'Copied!';
    this.style.color = 'var(--green-neon, #4ade80)';
    setTimeout(() => { this.textContent = orig; this.style.color = ''; }, 1400);
  }
});

// Free time toggle
document.getElementById('free-btn')?.addEventListener('click', toggleFreeTime);

// Merge toggle
document.getElementById('merge-btn')?.addEventListener('click', toggleMerge);

// Quick actions
document.getElementById('qa-import')?.addEventListener('click', () => {
  openImportModal();
});
document.getElementById('qa-share')?.addEventListener('click', () => {
  const code = document.getElementById('friend-code-display')?.textContent;
  if (code && code !== '------') {
    navigator.clipboard.writeText(code).catch(() => {});
  }
});
document.getElementById('qa-add-block')?.addEventListener('click', () => {
  // Scroll legacy add-block section into view if present
  const addSection = document.getElementById('a-add') || document.getElementById('a-days');
  if (addSection) addSection.scrollIntoView({ behavior: 'smooth' });
});

// Add friend by code
document.getElementById('add-friend-btn')?.addEventListener('click', async () => {
  const input = document.getElementById('add-friend-input');
  if (!input) return;
  const code = input.value.trim().toUpperCase();
  if (code.length !== 6) {
    alert('Friend code must be 6 characters.');
    return;
  }
  await importFriendByCode(code);
  input.value = '';
});

// Import tab in topbar opens modal
document.getElementById('open-import-modal')?.addEventListener('click', (e) => {
  e.preventDefault();
  openImportModal();
});

// Resize handler
window.addEventListener('resize', () => {
  buildIndividualBlocks();
  if (mergedMode) buildMergedBlocks();
  if (freeMode) buildFreeBlocks();
});

// ---------- Initial UI state ----------
initThemeToggle();
initComparisonNameModal();
initImportModal();
initAuth();
clearDaySelections();
renderBusyList(aBusy, "a-list");
renderBusyList(bBusy, "b-list", markComparisonDirty);
renderComparisonSelect();

// Check for import data in URL (from bookmarklet redirect)
checkUrlForImportData();

// Check auth session — auto-load profile if authenticated, show auth modal if not
checkAuth();

// Initialize Concept C grid
buildGridStructure();
requestAnimationFrame(() => requestAnimationFrame(() => {
  renderChips();
  buildIndividualBlocks();
  renderFriendsList();
  renderYourBlocks();
}));
