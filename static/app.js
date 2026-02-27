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
const USER_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const THEME_STORAGE_KEY = "timesync_theme";
const THEME_COOKIE_KEY = "timesync_theme";
const THEME_COOKIE_DAYS = 365;
let lastOverlapFreeData = null;

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

const BUSY_BLOCK_PALETTE_LIGHT = [
  { fill: "rgba(99, 102, 241, 0.30)", border: "rgba(99, 102, 241, 0.62)" },
  { fill: "rgba(249, 115, 22, 0.26)", border: "rgba(234, 88, 12, 0.68)" },
  { fill: "rgba(217, 70, 239, 0.24)", border: "rgba(162, 28, 175, 0.68)" },
  { fill: "rgba(245, 158, 11, 0.28)", border: "rgba(245, 158, 11, 0.62)" },
  { fill: "rgba(56, 189, 248, 0.28)", border: "rgba(56, 189, 248, 0.62)" },
  { fill: "rgba(71, 85, 105, 0.24)", border: "rgba(51, 65, 85, 0.68)" },
  { fill: "rgba(132, 204, 22, 0.28)", border: "rgba(132, 204, 22, 0.62)" },
  { fill: "rgba(168, 85, 247, 0.28)", border: "rgba(168, 85, 247, 0.62)" },
];

const BUSY_BLOCK_PALETTE_DARK = [
  { fill: "rgba(96, 165, 250, 0.50)", border: "rgba(147, 197, 253, 0.95)" },
  { fill: "rgba(251, 146, 60, 0.48)", border: "rgba(253, 186, 116, 0.95)" },
  { fill: "rgba(236, 72, 153, 0.50)", border: "rgba(249, 168, 212, 0.96)" },
  { fill: "rgba(34, 211, 238, 0.48)", border: "rgba(103, 232, 249, 0.95)" },
  { fill: "rgba(168, 85, 247, 0.56)", border: "rgba(216, 180, 254, 0.99)" },
  { fill: "rgba(248, 113, 113, 0.44)", border: "rgba(252, 165, 165, 0.95)" },
  { fill: "rgba(250, 204, 21, 0.50)", border: "rgba(253, 230, 138, 0.97)" },
  { fill: "rgba(250, 204, 21, 0.44)", border: "rgba(253, 224, 71, 0.95)" },
];

function getBusyPalette() {
  return document.body.classList.contains("dark-mode")
    ? BUSY_BLOCK_PALETTE_DARK
    : BUSY_BLOCK_PALETTE_LIGHT;
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
  return normalizeUserKeyInput(document.getElementById("schedule-key").value);
}

function setWorkspaceLocked(locked) {
  document.body.classList.toggle("workspace-locked", Boolean(locked));

  const gate = document.getElementById("workspace-gate");
  if (gate) {
    gate.classList.toggle("hidden", !locked);
  }
}

function syncUserKeyInputs() {
  const mainInput = document.getElementById("schedule-key");
  const gateInput = document.getElementById("gate-user-key");
  if (!mainInput || !gateInput) return;
  if (document.activeElement === gateInput) return;
  gateInput.value = normalizeUserKeyInput(mainInput.value);
}

function syncActiveUserDisplay() {
  const display = document.getElementById("active-user-display");
  const typedKey = getProfileKey();
  setWorkspaceLocked(!activeProfileKey);
  syncUserKeyInputs();

  if (!display) return;

  if (activeProfileKey) {
    display.textContent = `Current schedule: ${activeProfileKey}`;
    display.className = "active-user-display profile-ready";
    return;
  }

  if (typedKey) {
    display.textContent = `Current schedule: not loaded (${typedKey})`;
    display.className = "active-user-display profile-pending";
    return;
  }

  display.textContent = "Current schedule: not loaded";
  display.className = "active-user-display";
}

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.body.classList.toggle("dark-mode", isDark);

  const toggleBtn = document.getElementById("theme-toggle");
  if (!toggleBtn) return;

  const iconEl = toggleBtn.querySelector(".theme-toggle-icon");
  const textEl = toggleBtn.querySelector(".theme-toggle-text");
  if (iconEl) iconEl.textContent = isDark ? "☀️" : "🌙";
  if (textEl) textEl.textContent = isDark ? "Light Mode" : "Dark Mode";
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
    if (lastOverlapFreeData) {
      renderWeeklyView(lastOverlapFreeData);
    }
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
  const deleteBtn = document.getElementById("delete-comparison");

  select.innerHTML = "";

  if (comparisonSchedules.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No saved comparison schedules";
    select.appendChild(opt);
    selectedComparisonId = null;
    nameInput.value = "";
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
  nameInput.value = selected ? selected.name : "";
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
  document.getElementById("comparison-name").value = "";
  renderComparisonSelect();
  setComparisonStatus(`Deleted "${selected.name}".`);

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

    document.getElementById("schedule-key").value = key;
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
    syncActiveUserDisplay();
    setPersistStatus("Enter your User ID first.", true);
    return;
  }
  if (!isValidUserKey(key)) {
    activeProfileKey = null;
    syncActiveUserDisplay();
    setPersistStatus("User ID must be 3-32 chars: lowercase letters, numbers, '-' or '_'.", true);
    return;
  }

  setPersistStatus("Loading profile...");
  setImportStatus("");

  try {
    const res = await fetch(`/api/profiles/${encodeURIComponent(key)}`);
    const data = await res.json();

    if (!data.ok) {
      activeProfileKey = null;
      syncActiveUserDisplay();
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
    syncActiveUserDisplay();
    clearDaySelections();

    const when = data.updatedAt
      ? `Loaded profile "${key}" (updated ${new Date(data.updatedAt).toLocaleString()}).`
      : `Loaded new profile "${key}".`;
    setPersistStatus(when);
    persistUserKey(key);
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
  persistUserKey(key);
  if (!key) {
    setPersistStatus("Enter your User ID first.", true);
    return false;
  }
  if (!isValidUserKey(key)) {
    setPersistStatus("User ID must be 3-32 chars: lowercase letters, numbers, '-' or '_'.", true);
    return false;
  }
  if (requireLoadedContext && !ensureProfileContextForUpdate(key)) {
    return false;
  }

  const draftName = document.getElementById("comparison-name").value.trim();
  if (!selectedComparisonId && bBusy.length > 0 && !draftName) {
    setPersistStatus("Name the imported comparison and click Save Comparison before updating.", true);
    return false;
  }

  maybeSaveDraftIntoComparisons();
  if (!silent) setPersistStatus("Updating schedule...");

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
      setPersistStatus(data.error || "Failed to update schedule.", true);
      return false;
    }

    const when = data.updatedAt
      ? new Date(data.updatedAt).toLocaleString()
      : "just now";
    if (!silent) setPersistStatus(`Updated schedule "${key}" at ${when}.`);
    activeProfileKey = key;
    comparisonContextKey = key;
    persistUserKey(key);
    syncActiveUserDisplay();
    return true;
  } catch (err) {
    setPersistStatus(`Error updating schedule: ${String(err)}`, true);
    return false;
  }
}

async function importFriendSchedule() {
  const key = getProfileKey();
  if (!key) {
    setImportStatus("Enter your User ID first.", true);
    return;
  }
  if (!ensureProfileContextForUpdate(key)) {
    setImportStatus("Load this profile or create a new schedule before importing friends.", true);
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
      <div id="best-open-slots" class="best-open-slots"></div>
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

function parseEventInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function collectEventLayoutState(layer) {
  const layerRect = layer.getBoundingClientRect();
  const entries = [];

  layer.querySelectorAll(".event").forEach((el, idx) => {
    const rect = el.getBoundingClientRect();
    entries.push({
      key: el.dataset.eventKey || `event-${idx}`,
      kind: el.dataset.kind || "",
      day: el.dataset.day || "",
      startMin: parseEventInt(el.dataset.startMin, 0),
      endMin: parseEventInt(el.dataset.endMin, 0),
      left: rect.left - layerRect.left,
      top: rect.top - layerRect.top,
      width: rect.width,
      height: rect.height,
    });
  });

  const byKey = new Map();
  entries.forEach((entry) => {
    if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
  });

  return { entries, byKey };
}

function overlapMinutes(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function unionRect(entries) {
  if (!entries.length) return null;
  const left = Math.min(...entries.map((e) => e.left));
  const top = Math.min(...entries.map((e) => e.top));
  const right = Math.max(...entries.map((e) => e.left + e.width));
  const bottom = Math.max(...entries.map((e) => e.top + e.height));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function bestSourceRectForBusy(nextEntry, previousEntries) {
  const candidates = previousEntries.filter((prev) => {
    if (!prev.kind.startsWith("busy")) return false;
    if (prev.day !== nextEntry.day) return false;
    return overlapMinutes(prev.startMin, prev.endMin, nextEntry.startMin, nextEntry.endMin) > 0;
  });

  if (!candidates.length) return null;

  if (nextEntry.kind === "busy-merged" && candidates.length > 1) {
    return unionRect(candidates);
  }

  let best = candidates[0];
  let bestOverlap = overlapMinutes(best.startMin, best.endMin, nextEntry.startMin, nextEntry.endMin);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const overlap = overlapMinutes(c.startMin, c.endMin, nextEntry.startMin, nextEntry.endMin);
    if (overlap > bestOverlap) {
      best = c;
      bestOverlap = overlap;
    }
  }

  return {
    left: best.left,
    top: best.top,
    width: Math.max(1, best.width),
    height: Math.max(1, best.height),
  };
}

function animateEventLayerTransition(layer, previousState) {
  if (!layer || !previousState) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const layerRect = layer.getBoundingClientRect();
  const nextEntries = [];
  layer.querySelectorAll(".event").forEach((el, idx) => {
    const rect = el.getBoundingClientRect();
    nextEntries.push({
      element: el,
      key: el.dataset.eventKey || `next-${idx}`,
      kind: el.dataset.kind || "",
      day: el.dataset.day || "",
      startMin: parseEventInt(el.dataset.startMin, 0),
      endMin: parseEventInt(el.dataset.endMin, 0),
      left: rect.left - layerRect.left,
      top: rect.top - layerRect.top,
      width: rect.width,
      height: rect.height,
    });
  });

  nextEntries.forEach((entry) => {
    let source = previousState.byKey.get(entry.key) || null;
    if (!source && entry.kind.startsWith("busy")) {
      source = bestSourceRectForBusy(entry, previousState.entries);
    }

    const el = entry.element;
    if (typeof el.animate !== "function") return;

    if (source) {
      const dx = source.left - entry.left;
      const dy = source.top - entry.top;
      const sx = source.width / Math.max(1, entry.width);
      const sy = source.height / Math.max(1, entry.height);

      el.animate(
        [
          {
            transformOrigin: "top left",
            transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
            opacity: 0.76,
          },
          {
            transformOrigin: "top left",
            transform: "translate(0, 0) scale(1, 1)",
            opacity: 1,
          },
        ],
        {
          duration: 345,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
          fill: "both",
        }
      );
      return;
    }

    el.animate(
      [
        { opacity: 0, transform: "translateY(3px) scale(0.985)" },
        { opacity: 1, transform: "translateY(0) scale(1)" },
      ],
      {
        duration: 245,
        easing: "ease-out",
        fill: "both",
      }
    );
  });
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
    el.dataset.eventKey = b.key ? `${className}|${b.key}` : `${className}|${b.day}|${b.start}|${b.end}`;
    el.dataset.kind = className;
    el.dataset.day = b.day;
    el.dataset.startMin = String(s);
    el.dataset.endMin = String(e);
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

function formatDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function getTopOpenSlots(openByDay, limit = 3, allowedDays = DAYS) {
  const daySet = new Set(allowedDays);
  const slots = [];

  for (const day of DAYS) {
    if (!daySet.has(day)) continue;
    const daySlots = openByDay[day] || [];
    daySlots.forEach((slot) => {
      const startMin = toMinutes(slot.start);
      const endMin = toMinutes(slot.end);
      if (endMin <= startMin) return;
      slots.push({
        day,
        start: slot.start,
        end: slot.end,
        durationMin: endMin - startMin,
      });
    });
  }

  slots.sort((a, b) => {
    if (b.durationMin !== a.durationMin) return b.durationMin - a.durationMin;
    const dayDelta = DAYS.indexOf(a.day) - DAYS.indexOf(b.day);
    if (dayDelta !== 0) return dayDelta;
    return a.start.localeCompare(b.start);
  });

  return slots.slice(0, limit);
}

function renderBestOpenSlots(openByDay, showA, showB) {
  const container = document.getElementById("best-open-slots");
  if (!container) return;

  const weekdayDays = DAYS.filter((day) => day !== "Sat" && day !== "Sun");
  let allowedDays = weekdayDays;

  const mode = showA && showB
    ? "Shared availability (weekdays)"
    : showA
      ? "My Schedule availability (weekdays)"
      : showB
        ? "Comparison Schedule availability (weekdays)"
        : "No busy filters selected";

  if (!showA && !showB) {
    container.innerHTML = `
      <div class="slots-head">
        <h3>Best Open Slots</h3>
        <span class="slots-mode">${mode}</span>
      </div>
      <div class="slots-empty muted">Enable My Schedule and/or Comparison Schedule to see ranked open slots.</div>
    `;
    return;
  }

  if (showA && showB) {
    allowedDays = weekdayDays.filter(
      (day) =>
        aBusy.some((b) => b.day === day) &&
        bBusy.some((b) => b.day === day)
    );
  }

  const modeText = showA && showB
    ? allowedDays.length
      ? `Shared campus days: ${allowedDays.join(", ")}`
      : "No shared campus weekdays detected"
    : mode;

  const topSlots = getTopOpenSlots(openByDay, 3, allowedDays);
  const cards = topSlots.length
    ? topSlots.map((slot, idx) => `
      <article class="slot-card">
        <div class="slot-rank">#${idx + 1}</div>
        <div class="slot-day">${slot.day}</div>
        <div class="slot-range">${formatRange12(slot.start, slot.end)}</div>
        <div class="slot-duration">${formatDuration(slot.durationMin)}</div>
      </article>
    `).join("")
    : `<div class="slots-empty muted">${
        showA && showB
          ? "No weekday open slots found where both users appear on campus."
          : "No weekday open slots found in the selected time window."
      }</div>`;

  container.innerHTML = `
    <div class="slots-head">
      <h3>Best Open Slots</h3>
      <span class="slots-mode">${modeText}</span>
    </div>
    <div class="slots-grid">${cards}</div>
  `;
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
        key: `busy-merged|${day}|${minutesToHHMM(m.start)}|${minutesToHHMM(m.end)}`,
      });
    });
  }
  return mergedBlocks;
}

function buildGroupedBusyBlocks(blocks) {
  const groupByTime = new Map();
  let nextId = 1;
  const paletteSet = getBusyPalette();

  return blocks.map((b) => {
    const key = `${b.start}|${b.end}`;
    if (!groupByTime.has(key)) {
      groupByTime.set(key, nextId++);
    }
    const id = groupByTime.get(key);
    const palette = paletteSet[(id - 1) % paletteSet.length];
    return {
      ...b,
      label: `Busy Block ${id}`,
      color: palette.fill,
      border: palette.border,
      key: `busy-${id}|${b.day}|${b.start}|${b.end}`,
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
      const tailToEnd = eMin === dayEndMin && durationMin >= 90;
      const headFromStart = sMin === dayStartMin;
      const showRange = durationMin >= 55 && !tailToEnd;
      const isTiny = durationMin <= 15;
      const isCompact = !showRange && !isTiny;
      const isMiddleGap = sMin > dayStartMin && eMin < dayEndMin;
      const isAnimatedMid = showRange && isMiddleGap;
      const pillText = tailToEnd ? "Open rest of day" : (durationMin < 40 ? "Open" : "Open-time");
      el.className = `event overlap ${isCompact ? "compact-open-slot" : ""} ${isTiny ? "tiny-open-slot" : ""} ${tailToEnd ? "open-tail-slot" : ""} ${headFromStart ? "open-head-slot" : ""} ${isAnimatedMid ? "open-mid-slot" : ""}`.trim();
      el.style.gridRow = `${rowStart} / ${rowEnd}`;
      el.style.gridColumn = `${colStart} / ${colEnd}`;
      el.dataset.eventKey = `open|${day}|${slot.start}|${slot.end}`;
      el.dataset.kind = "open-time";
      el.dataset.day = day;
      el.dataset.startMin = String(sMin);
      el.dataset.endMin = String(eMin);
      if (!isTiny) {
        el.title = `Open-time: ${formatRange12(slot.start, slot.end)}`;
      }

      el.innerHTML = `
        <div class="event-label open-time-label ${isTiny ? "tiny-open-time" : ""} ${showRange ? "" : "compact-open-time"}">
          <span class="open-time-pill ${showRange || tailToEnd ? "" : "short-open-pill"}">${pillText}</span>
          ${isTiny ? "" : `<span class="open-time-range ${showRange ? "" : "hover-only-range"}">${formatRange12(slot.start, slot.end)}</span>`}
        </div>
      `;

      container.appendChild(el);
    }
  }
}

function enableBusyBlockMicroDrag() {
  const layer = document.getElementById("events-layer");
  if (!layer) return;

  const maxDragPx = 10;
  const busyEvents = layer.querySelectorAll(".event.busy-a, .event.busy-b, .event.busy-merged");

  busyEvents.forEach((el) => {
    let dragging = false;
    let pointerId = null;
    let startX = 0;
    let startY = 0;

    const onMove = (evt) => {
      if (!dragging || evt.pointerId !== pointerId) return;
      const dx = clamp(evt.clientX - startX, -maxDragPx, maxDragPx);
      const dy = clamp(evt.clientY - startY, -maxDragPx, maxDragPx);
      el.style.translate = `${dx}px ${dy}px`;
    };

    const finish = (evt) => {
      if (!dragging) return;
      if (evt && pointerId !== null && evt.pointerId !== pointerId) return;

      dragging = false;
      pointerId = null;
      el.classList.remove("busy-dragging");
      el.style.transition = "translate 180ms cubic-bezier(0.2, 0.8, 0.2, 1)";
      el.style.translate = "0px 0px";

      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("pointerleave", finish);
    };

    el.addEventListener("pointerdown", (evt) => {
      if (evt.button !== 0) return;
      dragging = true;
      pointerId = evt.pointerId;
      startX = evt.clientX;
      startY = evt.clientY;
      el.classList.add("busy-dragging");
      el.style.transition = "none";

      try {
        el.setPointerCapture(pointerId);
      } catch (_err) {
        // Ignore pointer capture failures.
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("pointerleave", finish);
      evt.preventDefault();
    });
  });
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
    const openTime = getOpenTimeForSelection(showA, showB, overlapFree);

    const layer = document.getElementById("events-layer");
    const previousState = collectEventLayoutState(layer);
    layer.innerHTML = "";

    if (showA && showB) {
      const mergedBusy = getMergedBusyBlocks(aBusy, bBusy);
      placeBlocks(mergedBusy, "busy-merged");
    } else {
      if (showA) placeBlocks(buildGroupedBusyBlocks(aBusy), "busy-a");
      if (showB) placeBlocks(buildGroupedBusyBlocks(bBusy), "busy-b");
    }

    if (showOverlap) placeOverlap(openTime);
    renderBestOpenSlots(openTime, showA, showB);

    animateEventLayerTransition(layer, previousState);
    enableBusyBlockMicroDrag();
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
  const compareStatus = document.getElementById("comparison-status-global");
  if (compareStatus) compareStatus.textContent = "Comparing schedules and ranking open-time windows...";

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
      if (compareStatus) compareStatus.textContent = "Compare failed: missing open-time data from server.";
      output.innerHTML = `<div class="error">No overlapFree returned.</div>`;
      return;
    }

    renderWeeklyView(data.overlapFree);
    lastOverlapFreeData = data.overlapFree;
    if (compareStatus) compareStatus.textContent = "Comparison updated. Review top open slots and weekly view below.";
  } catch (err) {
    lastOverlapFreeData = null;
    if (compareStatus) compareStatus.textContent = "Compare failed. Check backend/database connectivity and try again.";
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
  const key = getProfileKey();
  if (key && activeProfileKey && key === activeProfileKey) {
    await saveProfile({ silent: true });
  }
};
document.getElementById("save-comparison").onclick = async () => {
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
};
const deleteComparisonBtn = document.getElementById("delete-comparison");
if (deleteComparisonBtn) {
  deleteComparisonBtn.onclick = deleteSelectedComparison;
}
document.getElementById("comparison-name").oninput = markComparisonDirty;

document.getElementById("load-profile").onclick = async () => {
  await loadProfile();
};
const updateProfileBtn = document.getElementById("update-profile") || document.getElementById("save-profile");
if (updateProfileBtn) {
  updateProfileBtn.onclick = () => saveProfile({ silent: false, requireLoadedContext: true });
}
const createProfileBtn = document.getElementById("create-profile");
if (createProfileBtn) {
  createProfileBtn.onclick = createNewSchedule;
}
document.getElementById("import-friend").onclick = importFriendSchedule;

// Initial UI state
initThemeToggle();
initComparisonNameModal();
initUserKeyInput();
initWorkspaceGate();
clearDaySelections();
renderBusyList(aBusy, "a-list");
renderBusyList(bBusy, "b-list", markComparisonDirty);
renderComparisonSelect();

// Auto-load remembered profile key if present.
if (getProfileKey()) {
  loadProfile();
} else {
  setPersistStatus("Enter your User ID, then click Load Profile or Create New Schedule.");
}
