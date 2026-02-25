// static/app.js

const aBusy = []; // My Schedule busy blocks
const bBusy = []; // Comparison editor busy blocks
const comparisonSchedules = [];
let selectedComparisonId = null;
let activeProfileKey = null; // currently loaded profile ID in memory
let comparisonContextKey = null; // user ID that current comparison state belongs to
let comparisonDraftSourceUserKey = null; // source user for unsaved imported comparison draft
let comparisonNamePromptResolver = null;
const USER_KEY_STORAGE_KEY = "timesync_user_id";
const USER_KEY_COOKIE_DAYS = 365;

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Calendar window + resolution
const START_HOUR = 7;   // 7:00 AM
const END_HOUR = 22;    // 10:00 PM (not labeled)
const SLOT_MIN = 5;     // 5-min render grid for accurate placement

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

const BUSY_BLOCK_PALETTE = [
  { fill: "rgba(99, 102, 241, 0.30)", border: "rgba(99, 102, 241, 0.62)" },
  { fill: "rgba(249, 115, 22, 0.26)", border: "rgba(234, 88, 12, 0.68)" },
  { fill: "rgba(217, 70, 239, 0.24)", border: "rgba(162, 28, 175, 0.68)" },
  { fill: "rgba(245, 158, 11, 0.28)", border: "rgba(245, 158, 11, 0.62)" },
  { fill: "rgba(56, 189, 248, 0.28)", border: "rgba(56, 189, 248, 0.62)" },
  { fill: "rgba(71, 85, 105, 0.24)", border: "rgba(51, 65, 85, 0.68)" },
  { fill: "rgba(132, 204, 22, 0.28)", border: "rgba(132, 204, 22, 0.62)" },
  { fill: "rgba(168, 85, 247, 0.28)", border: "rgba(168, 85, 247, 0.62)" },
];

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

fillTimePicker("a-start", { h: 9,  m: 0,  ap: "AM" });
fillTimePicker("a-end",   { h: 10, m: 0,  ap: "AM" });
fillTimePicker("b-start", { h: 9,  m: 30, ap: "AM" });
fillTimePicker("b-end",   { h: 10, m: 30, ap: "AM" });

// ---------- Busy list UI ----------
function addBusy(prefix, arr, listId, onChange) {
  if (prefix === "b" && !selectedComparisonId) {
    setComparisonStatus("Create or select a named comparison before adding busy blocks.", true);
    return;
  }

  const dayContainer = document.getElementById(`${prefix}-days`);
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
  ul.innerHTML = "";
  arr.forEach((b, i) => {
    const li = document.createElement("li");
    li.textContent = `${b.day} ${formatRange12(b.start, b.end)}`;

    const del = document.createElement("button");
    del.textContent = "x";
    del.className = "del";
    del.onclick = () => {
      arr.splice(i, 1);
      renderBusyList(arr, listId, onChange);
      if (onChange) onChange();
    };

    li.appendChild(del);
    ul.appendChild(li);
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

function getProfileKey() {
  return document.getElementById("schedule-key").value.trim().toLowerCase();
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
  const stored = readStoredUserKey();
  if (stored) input.value = stored;
  comparisonContextKey = getProfileKey() || null;

  const syncStoredKey = () => {
    const key = getProfileKey();
    persistUserKey(key);
    const comparisonHasData =
      bBusy.length > 0 ||
      comparisonSchedules.length > 0 ||
      document.getElementById("comparison-name").value.trim().length > 0;

    if (comparisonContextKey && key !== comparisonContextKey && comparisonHasData) {
      resetComparisonContext();
      setPersistStatus("User ID changed. My Schedule kept. Comparison schedules reset for this account.");
      setImportStatus("");
    }

    if (activeProfileKey && key !== activeProfileKey) activeProfileKey = null;
    comparisonContextKey = key || null;
  };

  input.addEventListener("input", syncStoredKey);
  input.addEventListener("change", syncStoredKey);
  input.addEventListener("blur", syncStoredKey);
}

function setPersistStatus(msg, isError = false) {
  const el = document.getElementById("persist-status");
  el.textContent = msg;
  el.className = isError ? "persist-error" : "muted";
}

function setImportStatus(msg, isError = false) {
  const el = document.getElementById("import-status");
  el.textContent = msg;
  el.className = isError ? "persist-error" : "muted";
}

function setComparisonStatus(msg, isError = false) {
  const el = document.getElementById("comparison-status");
  el.textContent = msg;
  el.className = isError ? "persist-error" : "muted";
}

function resetComparisonContext() {
  replaceBusy(bBusy, []);
  replaceComparisonSchedules([]);
  selectedComparisonId = null;

  renderBusyList(bBusy, "b-list", markComparisonDirty);
  renderComparisonSelect();
  document.getElementById("comparison-name").value = "";
  setComparisonStatus("No saved comparison selected.");
}

function getSelectedComparison() {
  return comparisonSchedules.find((c) => c.id === selectedComparisonId) || null;
}

function renderComparisonSelect() {
  const select = document.getElementById("comparison-select");
  const nameInput = document.getElementById("comparison-name");

  select.innerHTML = "";

  if (comparisonSchedules.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No saved comparison schedules";
    select.appendChild(opt);
    selectedComparisonId = null;
    nameInput.value = "";
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
    selectedComparisonId = null;
  }

  select.value = selectedComparisonId || "";
  const selected = getSelectedComparison();
  nameInput.value = selected ? selected.name : "";
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
  document.getElementById("comparison-name").value = selected.name || "";
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
  const rawName = nameInput.value.trim();
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
  if (selectedComparisonId) {
    document.getElementById("comparison-select").value = selectedComparisonId;
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

function maybeSaveDraftIntoComparisons() {
  const hasName = document.getElementById("comparison-name").value.trim().length > 0;
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
  persistUserKey(key);
  if (!key) {
    activeProfileKey = null;
    setPersistStatus("Enter your User ID first.", true);
    return;
  }

  setPersistStatus("Loading profile...");
  setImportStatus("");

  try {
    const res = await fetch(`/api/profiles/${encodeURIComponent(key)}`);
    const data = await res.json();

    if (!data.ok) {
      activeProfileKey = null;
      setPersistStatus(data.error || "Failed to load profile.", true);
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

    const when = data.updatedAt
      ? `Loaded profile "${key}" (updated ${new Date(data.updatedAt).toLocaleString()}).`
      : `Loaded new profile "${key}".`;
    setPersistStatus(when);
    persistUserKey(key);
  } catch (err) {
    setPersistStatus(`Error loading profile: ${String(err)}`, true);
  }
}

async function saveProfile(options = {}) {
  const { silent = false } = options;
  const key = getProfileKey();
  persistUserKey(key);
  if (!key) {
    setPersistStatus("Enter your User ID first.", true);
    return false;
  }

  const draftName = document.getElementById("comparison-name").value.trim();
  if (!selectedComparisonId && bBusy.length > 0 && !draftName) {
    setPersistStatus("Name the imported comparison and click Save Comparison before saving profile.", true);
    return false;
  }

  maybeSaveDraftIntoComparisons();
  if (!silent) setPersistStatus("Saving profile...");

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
      setPersistStatus(data.error || "Failed to save profile.", true);
      return false;
    }

    const when = data.updatedAt
      ? new Date(data.updatedAt).toLocaleString()
      : "just now";
    if (!silent) setPersistStatus(`Saved profile "${key}" at ${when}.`);
    activeProfileKey = key;
    comparisonContextKey = key;
    persistUserKey(key);
    return true;
  } catch (err) {
    setPersistStatus(`Error saving profile: ${String(err)}`, true);
    return false;
  }
}

async function importFriendSchedule() {
  const key = getProfileKey();
  if (!key) {
    setImportStatus("Enter your User ID first.", true);
    return;
  }

  const friendKey = document.getElementById("friend-user-key").value.trim().toLowerCase();
  if (!friendKey) {
    setImportStatus("Enter a friend User ID to import.", true);
    return;
  }
  if (friendKey === key) {
    setImportStatus("Use a different user ID. You cannot import your own schedule.", true);
    return;
  }

  setImportStatus("Importing friend schedule...");

  try {
    const res = await fetch(`/api/public-schedules/${encodeURIComponent(friendKey)}`);
    const data = await res.json();

    if (!data.ok) {
      setImportStatus(data.error || "Failed to import friend schedule.", true);
      return;
    }

    const name = await requestComparisonName({
      title: "Name Imported Comparison",
      message: `Enter a name for ${friendKey}'s schedule.`,
      placeholder: "e.g. James - Work Week",
      defaultValue: friendKey,
    });
    if (!name) {
      setImportStatus("Import canceled.");
      return;
    }

    const created = createComparisonSchedule({
      name,
      busy: data.mySchedule?.busy || [],
      sourceUserKey: friendKey,
    });
    if (!created) {
      setImportStatus("Comparison name is required.", true);
      return;
    }

    comparisonContextKey = key;
    setComparisonStatus(`Saved "${created.name}".`);
    setImportStatus(`Imported "${friendKey}" as "${created.name}".`);
    await saveProfile({ silent: true });
  } catch (err) {
    setImportStatus(`Import error: ${String(err)}`, true);
  }
}

// ---------- Weekly calendar rendering ----------
function to12HourLabel(totalMin) {
  let h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}${m ? ":" + String(m).padStart(2, "0") : ""} ${ampm}`;
}

function buildCalendarHTML() {
  const totalSlots = ((END_HOUR - START_HOUR) * 60) / SLOT_MIN;

  const dayHeaders = DAYS.map((d) => `<div class="day-header">${d}</div>`).join("");

  const timeRows = [];
  for (let mins = START_HOUR * 60; mins < END_HOUR * 60; mins += SLOT_MIN) {
    const rowStart = 2 + ((mins - START_HOUR * 60) / SLOT_MIN);
    timeRows.push(`<div class="time-label minor-mark" style="grid-row:${rowStart};"></div>`);
  }

  const hourLabels = [];
  for (let h = START_HOUR; h < END_HOUR; h++) {
    const rowStart = 2 + ((h - START_HOUR) * (60 / SLOT_MIN));
    hourLabels.push(`
      <div class="time-label hour-mark" style="grid-row:${rowStart} / span ${60 / SLOT_MIN};">
        ${to12HourLabel(h * 60)}
      </div>
    `);
  }

  const cells = [];
  const rows = totalSlots;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < DAYS.length; c++) {
      cells.push(`<div class="cell" style="grid-row:${r + 2}; grid-column:${c + 2};"></div>`);
    }
  }

  return `
    <div class="calendar">
      <div class="calendar-grid" style="--rows:${totalSlots}; --cols:${DAYS.length};">
        <div class="corner"></div>
        ${dayHeaders}
        ${timeRows.join("")}
        ${hourLabels.join("")}
        ${cells.join("")}
        <div id="events-layer" class="events-layer"></div>
      </div>
    </div>
  `;
}

function placeBlocks(blocks, className) {
  const container = document.getElementById("events-layer");
  const dayStartMin = START_HOUR * 60;
  const dayEndMin = END_HOUR * 60;

  blocks.forEach((b) => {
    if (!DAYS.includes(b.day)) return;

    const s = clamp(toMinutes(b.start), dayStartMin, dayEndMin);
    const e = clamp(toMinutes(b.end), dayStartMin, dayEndMin);
    if (e <= s) return;

    const dayIndex = DAYS.indexOf(b.day);

    const startSlot = Math.floor((s - dayStartMin) / SLOT_MIN);
    const endSlot = Math.ceil((e - dayStartMin) / SLOT_MIN);
    const rowStart = startSlot + 2;
    const rowEnd = endSlot + 2;

    const colStart = dayIndex + 2;
    const colEnd = colStart + 1;

    const el = document.createElement("div");
    el.className = `event ${className}`;
    el.style.gridRow = `${rowStart} / ${rowEnd}`;
    el.style.gridColumn = `${colStart} / ${colEnd}`;
    if (b.color) el.style.background = b.color;
    if (b.border) el.style.borderColor = b.border;
    el.title = `${b.day} ${formatRange12(b.start, b.end)}`;
    const label = b.label || "Busy Block";
    el.innerHTML = `<div class="event-label">${label}<br>${formatRange12(b.start, b.end)}</div>`;
    container.appendChild(el);
  });
}

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

function invertBusyToFree(mergedBusy, dayStartMin, dayEndMin) {
  const free = [];
  let cur = dayStartMin;

  for (const block of mergedBusy) {
    const s = Math.max(block.start, dayStartMin);
    const e = Math.min(block.end, dayEndMin);
    if (e <= dayStartMin || s >= dayEndMin) continue;
    if (cur < s) free.push({ start: cur, end: s });
    cur = Math.max(cur, e);
  }

  if (cur < dayEndMin) free.push({ start: cur, end: dayEndMin });
  return free;
}

function getOpenTimeForSelection(showA, showB, sharedOverlapFree) {
  if (showA && showB) return sharedOverlapFree;

  const dayStartMin = START_HOUR * 60;
  const dayEndMin = END_HOUR * 60;
  const open = Object.fromEntries(DAYS.map((d) => [d, []]));
  let selectedBusy = [];

  if (showA) selectedBusy = aBusy;
  else if (showB) selectedBusy = bBusy;

  if (!showA && !showB) {
    for (const day of DAYS) {
      open[day] = [{ start: minutesToHHMM(dayStartMin), end: minutesToHHMM(dayEndMin) }];
    }
    return open;
  }

  for (const day of DAYS) {
    const mergedBusy = mergeIntervals(
      selectedBusy
        .filter((b) => b.day === day)
        .map((b) => ({ start: toMinutes(b.start), end: toMinutes(b.end) }))
        .filter((b) => b.end > b.start)
    );

    const freeSlots = invertBusyToFree(mergedBusy, dayStartMin, dayEndMin);
    open[day] = freeSlots.map((slot) => ({
      start: minutesToHHMM(slot.start),
      end: minutesToHHMM(slot.end),
    }));
  }

  return open;
}

function getMergedBusyBlocks(aBlocks, bBlocks) {
  const byDay = Object.fromEntries(DAYS.map((d) => [d, []]));
  const combined = [...aBlocks, ...bBlocks];

  combined.forEach((b) => {
    if (!DAYS.includes(b.day)) return;
    const startMin = toMinutes(b.start);
    const endMin = toMinutes(b.end);
    if (endMin <= startMin) return;
    byDay[b.day].push({ start: startMin, end: endMin });
  });

  const mergedBlocks = [];
  for (const day of DAYS) {
    const merged = mergeIntervals(byDay[day]);
    merged.forEach((m) => {
      mergedBlocks.push({
        day,
        start: minutesToHHMM(m.start),
        end: minutesToHHMM(m.end),
      });
    });
  }
  return mergedBlocks;
}

function buildGroupedBusyBlocks(blocks) {
  const groupByTime = new Map();
  let nextId = 1;

  return blocks.map((b) => {
    const key = `${b.start}|${b.end}`;
    if (!groupByTime.has(key)) {
      groupByTime.set(key, nextId++);
    }
    const id = groupByTime.get(key);
    const palette = BUSY_BLOCK_PALETTE[(id - 1) % BUSY_BLOCK_PALETTE.length];
    return {
      ...b,
      label: `Busy Block ${id}`,
      color: palette.fill,
      border: palette.border,
    };
  });
}

function placeOverlap(overlapFree) {
  const container = document.getElementById("events-layer");
  const dayStartMin = START_HOUR * 60;
  const dayEndMin = END_HOUR * 60;

  for (const day of DAYS) {
    const slots = overlapFree[day] || [];
    for (const slot of slots) {
      const b = { day, start: slot.start, end: slot.end };

      const sMin = clamp(toMinutes(b.start), dayStartMin, dayEndMin);
      const eMin = clamp(toMinutes(b.end), dayStartMin, dayEndMin);
      if (eMin <= sMin) continue;
      const durationMin = eMin - sMin;

      const dayIndex = DAYS.indexOf(day);

      const startSlot = Math.floor((sMin - dayStartMin) / SLOT_MIN);
      const endSlot = Math.ceil((eMin - dayStartMin) / SLOT_MIN);
      const rowStart = startSlot + 2;
      const rowEnd = endSlot + 2;

      const colStart = dayIndex + 2;
      const colEnd = colStart + 1;

      const el = document.createElement("div");
      const showRange = durationMin >= 45;
      const isTiny = durationMin <= 15;
      const isCompact = !showRange && !isTiny;
      el.className = `event overlap ${isCompact ? "compact-open-slot" : ""} ${isTiny ? "tiny-open-slot" : ""}`.trim();
      el.style.gridRow = `${rowStart} / ${rowEnd}`;
      el.style.gridColumn = `${colStart} / ${colEnd}`;
      if (!isTiny) {
        el.title = `Open-time: ${formatRange12(slot.start, slot.end)}`;
      }

      el.innerHTML = `
        <div class="event-label open-time-label ${isTiny ? "tiny-open-time" : ""} ${showRange ? "" : "compact-open-time"}">
          <span class="open-time-pill">Open-time</span>
          ${isTiny ? "" : `<span class="open-time-range ${showRange ? "" : "hover-only-range"}">${formatRange12(slot.start, slot.end)}</span>`}
        </div>
      `;

      container.appendChild(el);
    }
  }
}

function renderWeeklyView(overlapFree) {
  const output = document.getElementById("output");
  output.innerHTML = buildCalendarHTML();

  const legend = document.createElement("div");
  legend.className = "legend";
  legend.innerHTML = `
  <label class="legend-item">
    <input type="checkbox" id="toggle-a" checked>
    <span class="swatch busy-a"></span> My Schedule
  </label>

  <label class="legend-item">
    <input type="checkbox" id="toggle-b" checked>
    <span class="swatch busy-b"></span> Comparison Schedule
  </label>

  <label class="legend-item">
    <input type="checkbox" id="toggle-overlap" checked>
    <span class="swatch overlap"></span> Open Time
  </label>
`;
  output.prepend(legend);

  function draw() {
    const showA = document.getElementById("toggle-a").checked;
    const showB = document.getElementById("toggle-b").checked;
    const showOverlap = document.getElementById("toggle-overlap").checked;

    const layer = document.getElementById("events-layer");
    layer.innerHTML = "";

    if (showA && showB) {
      const mergedBusy = getMergedBusyBlocks(aBusy, bBusy);
      placeBlocks(mergedBusy, "busy-merged");
    } else {
      if (showA) placeBlocks(buildGroupedBusyBlocks(aBusy), "busy-a");
      if (showB) placeBlocks(buildGroupedBusyBlocks(bBusy), "busy-b");
    }

    if (showOverlap) {
      const openTime = getOpenTimeForSelection(showA, showB, overlapFree);
      placeOverlap(openTime);
    }
  }

  draw();
  document.getElementById("toggle-a").onchange = draw;
  document.getElementById("toggle-b").onchange = draw;
  document.getElementById("toggle-overlap").onchange = draw;
}

// ---------- Compare ----------
document.getElementById("compare").onclick = async () => {
  const selected = getSelectedComparison();
  const comparisonName = (document.getElementById("comparison-name").value.trim() || selected?.name || "Comparison Schedule");

  const payload = {
    personA: { name: "My Schedule", busy: aBusy },
    personB: { name: comparisonName, busy: bBusy },
  };

  const output = document.getElementById("output");
  output.innerHTML = `<div class="muted">Comparing...</div>`;

  try {
    const res = await fetch("/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!data.overlapFree) {
      output.innerHTML = `<div class="error">No overlapFree returned.</div>`;
      return;
    }

    renderWeeklyView(data.overlapFree);
  } catch (err) {
    output.innerHTML = `<div class="error">Error calling /compare: ${String(err)}</div>`;
  }
};

// ---------- Event wiring ----------
document.getElementById("a-add").onclick = () => addBusy("a", aBusy, "a-list");
document.getElementById("b-add").onclick = () => addBusy("b", bBusy, "b-list", markComparisonDirty);

document.getElementById("comparison-select").onchange = (e) => {
  selectedComparisonId = e.target.value || null;
  loadSelectedComparisonIntoEditor();
};

document.getElementById("new-comparison").onclick = async () => {
  await startNewComparisonDraft();
  if (getProfileKey()) await saveProfile({ silent: true });
};
document.getElementById("save-comparison").onclick = async () => {
  const saved = saveComparisonFromEditor({ silent: false, allowCreate: true });
  if (!saved) return;
  if (!getProfileKey()) {
    setPersistStatus("Comparison saved locally. Enter User ID and click Save Profile to persist.");
    return;
  }
  const ok = await saveProfile({ silent: true });
  if (ok) setPersistStatus(`Saved comparison "${saved.name}" to your profile.`);
};
document.getElementById("comparison-name").oninput = markComparisonDirty;

document.getElementById("load-profile").onclick = loadProfile;
document.getElementById("save-profile").onclick = saveProfile;
document.getElementById("import-friend").onclick = importFriendSchedule;

// Initial UI state
initComparisonNameModal();
initUserKeyInput();
renderBusyList(aBusy, "a-list");
renderBusyList(bBusy, "b-list", markComparisonDirty);
renderComparisonSelect();

// Auto-load remembered profile key if present.
if (getProfileKey()) {
  loadProfile();
} else {
  setPersistStatus("Enter your User ID once, then it will auto-load next time.");
}
