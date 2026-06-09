'use strict';

const els = {
  stackSelect: document.getElementById('stackSelect'),
  refreshBtn: document.getElementById('refreshBtn'),
  connStatus: document.getElementById('connStatus'),
  version: document.getElementById('version'),
  containerList: document.getElementById('containerList'),
  currentContainer: document.getElementById('currentContainer'),
  logWindow: document.getElementById('logWindow'),
  levelChips: document.getElementById('levelChips'),
  filterInput: document.getElementById('filterInput'),
  autoscroll: document.getElementById('autoscroll'),
  clearBtn: document.getElementById('clearBtn'),
  pinnedList: document.getElementById('pinnedList'),
  pinCount: document.getElementById('pinCount'),
  clearPinsBtn: document.getElementById('clearPinsBtn'),
  themeToggle: document.getElementById('themeToggle'),
  expandAll: document.getElementById('expandAll'),
  collapseAll: document.getElementById('collapseAll'),
  exportMinutes: document.getElementById('exportMinutes'),
  copyRange: document.getElementById('copyRange'),
  downloadRange: document.getElementById('downloadRange'),
  githubLink: document.getElementById('githubLink'),
  ghBadge: document.getElementById('ghBadge'),
};

const PIN_KEY = 'cargoclue.pins.v1';
const THEME_KEY = 'cargoclue.theme';
const EXPORT_MIN_KEY = 'cargoclue.exportMinutes';
const NO_STACK = '(no stack)';

const state = {
  containers: [],
  active: null,          // { kind: 'container'|'stack', key, title, multi }
  ws: null,
  filter: '',
  levelFilter: new Set(), // empty = show all levels
  collapsed: new Set(),   // collapsed stack names
  updates: {},            // containerId -> true when an image update is available
  pins: loadPins(),
  lines: [],              // raw log entries for re-filtering
};

/* ---------------- Pins (localStorage) ---------------- */
function loadPins() {
  try { return JSON.parse(localStorage.getItem(PIN_KEY)) || []; }
  catch { return []; }
}
function savePins() { localStorage.setItem(PIN_KEY, JSON.stringify(state.pins)); }
function pinKey(e) { return `${e.containerName}|${e.ts}|${e.text}`; }
function isPinned(e) { return state.pins.some((p) => pinKey(p) === pinKey(e)); }
function togglePin(entry) {
  const k = pinKey(entry);
  const idx = state.pins.findIndex((p) => pinKey(p) === k);
  if (idx >= 0) state.pins.splice(idx, 1);
  else state.pins.push(entry);
  savePins();
  renderPins();
  document.querySelectorAll('.log-line').forEach((node) => {
    if (node.dataset.key === k) {
      node.querySelector('.pin-btn')?.classList.toggle('pinned', isPinned(entry));
    }
  });
}

/* ---------------- Source colours (for aggregated view) ---------------- */
function hueFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}
function srcColor(name) { return `hsl(${hueFor(name)}, 65%, 65%)`; }

/* ---------------- Theme ---------------- */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  els.themeToggle.textContent = theme === 'light' ? '🌙' : '☀️';
  els.themeToggle.title = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

/* ---------------- API ---------------- */
async function fetchVersion() {
  try {
    const { version } = await (await fetch('/api/version')).json();
    if (version) els.version.textContent = 'v' + version;
  } catch { /* ignore */ }
}

async function fetchUpdates() {
  try {
    const { updates } = await (await fetch('/api/updates')).json();
    state.updates = updates || {};
    renderContainers();
  } catch { /* ignore */ }
}

async function fetchSelfUpdate() {
  try {
    const info = await (await fetch('/api/self-update-check')).json();
    if (info.updateAvailable && info.latest) {
      els.ghBadge.hidden = false;
      els.githubLink.classList.add('has-update');
      els.githubLink.title = `New version available: v${info.latest} (you have v${info.current}) — click to view on GitHub`;
    } else {
      els.ghBadge.hidden = true;
      els.githubLink.classList.remove('has-update');
      els.githubLink.title = 'View on GitHub';
    }
  } catch { /* ignore */ }
}

async function fetchStacks() {
  const data = await (await fetch('/api/stacks')).json();
  const current = els.stackSelect.value;
  els.stackSelect.innerHTML = '<option value="all">All stacks</option>';
  for (const s of data.stacks) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    els.stackSelect.appendChild(opt);
  }
  if ([...els.stackSelect.options].some((o) => o.value === current)) {
    els.stackSelect.value = current;
  }
}

async function fetchContainers() {
  const stack = els.stackSelect.value;
  const data = await (await fetch(`/api/containers?stack=${encodeURIComponent(stack)}`)).json();
  state.containers = data.containers || [];
  renderContainers();
}

/* ---------------- Rendering: grouped container list ---------------- */
function groupByStack(containers) {
  const groups = new Map();
  for (const c of containers) {
    if (!groups.has(c.stack)) groups.set(c.stack, []);
    groups.get(c.stack).push(c);
  }
  // Sort: named stacks first (alphabetical), "(no stack)" last.
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === NO_STACK) return 1;
    if (b[0] === NO_STACK) return -1;
    return a[0].localeCompare(b[0]);
  });
}

function renderContainers() {
  els.containerList.innerHTML = '';
  if (state.containers.length === 0) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'No containers found.';
    els.containerList.appendChild(d);
    return;
  }

  for (const [stack, items] of groupByStack(state.containers)) {
    const collapsed = state.collapsed.has(stack);
    const runningCount = items.filter((c) => c.state === 'running').length;
    const isStandalone = stack === NO_STACK;

    const group = document.createElement('div');
    group.className = 'stack-group';

    // --- Stack header ---
    const header = document.createElement('div');
    header.className = 'stack-header'
      + (state.active?.kind === 'stack' && state.active.key === stack ? ' active' : '');

    const caret = document.createElement('button');
    caret.className = 'caret' + (collapsed ? ' collapsed' : '');
    caret.textContent = '▾';
    caret.title = collapsed ? 'Expand' : 'Collapse';
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      if (collapsed) state.collapsed.delete(stack); else state.collapsed.add(stack);
      renderContainers();
    });

    const label = document.createElement('div');
    label.className = 'stack-label';
    label.innerHTML = `<span class="stack-name"></span>
      <span class="stack-count">${runningCount}/${items.length}</span>`;
    label.querySelector('.stack-name').textContent = isStandalone ? 'Standalone' : stack;

    header.appendChild(caret);
    header.appendChild(label);
    // Standalone containers aren't a real stack; only group named stacks for "follow all".
    if (!isStandalone) {
      header.title = 'Follow all logs in this stack';
      header.addEventListener('click', () => selectStack(stack, items));
    } else {
      header.classList.add('no-select');
    }
    group.appendChild(header);

    // --- Container items (indented) ---
    if (!collapsed) {
      for (const c of items) {
        const item = document.createElement('div');
        item.className = 'container-item'
          + (state.active?.kind === 'container' && state.active.key === c.id ? ' active' : '');
        const hasUpdate = state.updates[c.id];
        item.innerHTML = `
          <span class="dot ${c.state === 'running' ? 'running' : ''}"></span>
          <span class="c-meta">
            <div class="c-name">
              <span class="c-name-text"></span>
              ${hasUpdate ? '<span class="update-dot" title="Image update available">⬆</span>' : ''}
            </div>
            <div class="c-sub"></div>
          </span>`;
        item.querySelector('.c-name-text').textContent = c.name;
        item.querySelector('.c-sub').textContent = c.status;
        item.addEventListener('click', () => selectContainer(c));
        group.appendChild(item);
      }
    }

    els.containerList.appendChild(group);
  }
}

/* ---------------- Log streaming ---------------- */
function setConn(label, cls) {
  els.connStatus.textContent = label;
  els.connStatus.className = 'conn' + (cls ? ' ' + cls : '');
}

function openStream(ids, multi) {
  if (state.ws) { state.ws.close(); state.ws = null; }
  state.lines = [];
  els.logWindow.innerHTML = '';

  setConn('connecting…');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/logs?ids=${encodeURIComponent(ids.join(','))}&tail=300`);
  state.ws = ws;

  ws.onopen = () => setConn('live', 'live');
  ws.onclose = () => { if (state.ws === ws) setConn('disconnected'); };
  ws.onerror = () => setConn('error', 'error');
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'log') addLogLine(msg);
    else if (msg.type === 'error') setConn('error: ' + msg.message, 'error');
    else if (msg.type === 'end') setConn('stream ended');
  };
}

function selectContainer(c) {
  state.active = { kind: 'container', key: c.id, title: c.name, multi: false };
  els.currentContainer.textContent = c.name;
  renderContainers();
  openStream([c.id], false);
}

function selectStack(stack, items) {
  const ids = items.map((c) => c.id);
  state.active = { kind: 'stack', key: stack, title: stack, multi: true };
  els.currentContainer.textContent = `${stack} — ${items.length} containers`;
  renderContainers();
  openStream(ids, true);
}

function makeEntry(msg) {
  return {
    containerName: msg.container || state.active?.title || '',
    ts: msg.ts || '',
    level: msg.level,
    stream: msg.stream,
    text: msg.text,
  };
}

function matchesEntry(e) {
  if (state.levelFilter.size && !state.levelFilter.has(e.level)) return false;
  if (state.filter && !e.text.toLowerCase().includes(state.filter)) return false;
  return true;
}

function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d) ? ts : d.toLocaleTimeString();
}

function copyEntry(entry, btn) {
  const parts = [entry.ts, entry.containerName, entry.text].filter(Boolean);
  const text = parts.join(' ');
  const done = () => {
    const prev = btn.textContent;
    btn.textContent = '✓';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = prev; btn.classList.remove('copied'); }, 900);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { /* ignore */ }
  document.body.removeChild(ta);
}

/* ---------------- Time-window export ---------------- */
function flashBtn(btn, symbol, cls) {
  const prev = btn.textContent;
  btn.textContent = symbol;
  if (cls) btn.classList.add(cls);
  setTimeout(() => { btn.textContent = prev; if (cls) btn.classList.remove(cls); }, 900);
}

function exportMinutesValue() {
  const n = parseInt(els.exportMinutes.value, 10);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

function formatEntry(e) {
  return [e.ts, e.containerName, e.level.toUpperCase(), e.text].filter(Boolean).join(' ');
}

// Lines from the current buffer within the last `minutes` minutes (by timestamp).
function entriesInWindow(minutes) {
  const cutoff = Date.now() - minutes * 60000;
  return state.lines.filter((e) => {
    if (!e.ts) return false;
    const t = new Date(e.ts).getTime();
    return !isNaN(t) && t >= cutoff;
  });
}

function copyRange() {
  const minutes = exportMinutesValue();
  const text = entriesInWindow(minutes).map(formatEntry).join('\n');
  if (!text) { flashBtn(els.copyRange, '∅'); return; }
  const done = () => flashBtn(els.copyRange, '✓', 'copied');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function downloadRange() {
  const minutes = exportMinutesValue();
  const text = entriesInWindow(minutes).map(formatEntry).join('\n');
  if (!text) { flashBtn(els.downloadRange, '∅'); return; }
  const name = (state.active?.title || 'logs').replace(/[\\/:*?"<>|]+/g, '-').toUpperCase();
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const minLabel = `LAST ${minutes} MINUTE${minutes === 1 ? '' : 'S'}`;
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name} - ${stamp} - ${minLabel}.log`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
  flashBtn(els.downloadRange, '✓', 'copied');
}

function addLogLine(msg) {
  const entry = makeEntry(msg);
  state.lines.push(entry);
  if (state.lines.length > 5000) state.lines.shift();
  if (matchesEntry(entry)) appendLineNode(entry);
}

function appendLineNode(entry) {
  const node = document.createElement('div');
  node.className = `log-line level-${entry.level}`;
  node.dataset.key = pinKey(entry);

  const src = state.active?.multi
    ? `<span class="src" style="color:${srcColor(entry.containerName)}"></span>` : '';
  node.innerHTML =
    `<span class="ts">${fmtTs(entry.ts)}</span>` +
    src +
    `<span class="lvl">${entry.level}</span>` +
    `<span class="msg"></span>` +
    `<span class="line-actions">` +
      `<button class="copy-btn" title="Copy entry to clipboard">⧉</button>` +
      `<button class="pin-btn" title="Pin this entry">📌</button>` +
    `</span>`;
  node.querySelector('.msg').textContent = entry.text;
  if (src) node.querySelector('.src').textContent = entry.containerName;

  const copyBtn = node.querySelector('.copy-btn');
  copyBtn.addEventListener('click', (e) => { e.stopPropagation(); copyEntry(entry, copyBtn); });

  const pinBtn = node.querySelector('.pin-btn');
  if (isPinned(entry)) pinBtn.classList.add('pinned');
  pinBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePin(entry); });

  const nearBottom = els.logWindow.scrollHeight - els.logWindow.scrollTop - els.logWindow.clientHeight < 40;
  els.logWindow.appendChild(node);
  if (els.autoscroll.checked && nearBottom) els.logWindow.scrollTop = els.logWindow.scrollHeight;
}

function rerenderLog() {
  els.logWindow.innerHTML = '';
  for (const entry of state.lines) if (matchesEntry(entry)) appendLineNode(entry);
}

/* ---------------- Rendering: pins ---------------- */
function renderPins() {
  els.pinCount.textContent = state.pins.length;
  els.pinnedList.innerHTML = '';
  for (const entry of state.pins) {
    const node = document.createElement('div');
    node.className = `pinned-item level-${entry.level}`;
    node.innerHTML = `
      <button class="unpin" title="Unpin this entry">📌</button>
      <span class="src"></span>
      <span class="ts">${fmtTs(entry.ts)}</span>
      <span class="msg"></span>`;
    const srcEl = node.querySelector('.src');
    srcEl.textContent = entry.containerName || '';
    srcEl.style.color = srcColor(entry.containerName || '');
    node.querySelector('.msg').textContent = entry.text;
    node.querySelector('.unpin').addEventListener('click', () => togglePin(entry));
    els.pinnedList.appendChild(node);
  }
}

/* ---------------- Level chips ---------------- */
els.levelChips.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const lvl = chip.dataset.level;
  if (state.levelFilter.has(lvl)) state.levelFilter.delete(lvl);
  else state.levelFilter.add(lvl);
  chip.classList.toggle('active', state.levelFilter.has(lvl));
  rerenderLog();
});

/* ---------------- Events ---------------- */
els.stackSelect.addEventListener('change', fetchContainers);
els.refreshBtn.addEventListener('click', async () => { await fetchStacks(); await fetchContainers(); });
els.clearBtn.addEventListener('click', () => { state.lines = []; els.logWindow.innerHTML = ''; });
els.clearPinsBtn.addEventListener('click', () => { state.pins = []; savePins(); renderPins(); });
els.filterInput.addEventListener('input', () => {
  state.filter = els.filterInput.value.trim().toLowerCase();
  rerenderLog();
});
els.themeToggle.addEventListener('click', toggleTheme);
els.expandAll.addEventListener('click', () => { state.collapsed.clear(); renderContainers(); });
els.collapseAll.addEventListener('click', () => {
  for (const [stack] of groupByStack(state.containers)) state.collapsed.add(stack);
  renderContainers();
});
els.copyRange.addEventListener('click', copyRange);
els.downloadRange.addEventListener('click', downloadRange);
els.exportMinutes.addEventListener('change', () => {
  localStorage.setItem(EXPORT_MIN_KEY, String(exportMinutesValue()));
});

/* ---------------- Init ---------------- */
(async function init() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
  const savedMin = localStorage.getItem(EXPORT_MIN_KEY);
  if (savedMin) els.exportMinutes.value = savedMin;
  renderPins();
  fetchVersion();
  fetchSelfUpdate();
  try {
    await fetchStacks();
    await fetchContainers();
  } catch (err) {
    setConn('API error: ' + err.message, 'error');
  }
  fetchUpdates();
  // The server warms the update cache asynchronously; re-poll a couple of times
  // shortly after load so the indicators show up without waiting for the long interval.
  setTimeout(fetchUpdates, 8000);
  setTimeout(fetchUpdates, 25000);
  setInterval(fetchContainers, 10000);
  setInterval(fetchUpdates, 10 * 60 * 1000);       // re-check image updates every 10 min
  setInterval(fetchSelfUpdate, 60 * 60 * 1000);    // re-check CargoClue version hourly
})();
