import { createDemoContext } from './shared/demoContext.js';
import * as realtime from './modes/realtime.js';
import * as meshless from './modes/meshless.js';
import * as surface from './modes/surface.js';
import { createSigilState } from '../src/index.js';
import { demoModeLabel, resolveDemoStartup } from './shared/demoModeState.js';
import { normalizeCvRadiusScales, sampleSplinePoints } from './shared/strokeSession.js';

// Drawing keeps the stable `realtime` id and remains the default (index 0).
const MODES = [realtime, meshless, surface];

const STORAGE_KEY = 'sigils.demo.v1';
const PERSIST_IDLE_MS = 500;
const SAVE_STATUS_DELAY_MS = 180;

const panel = document.getElementById('panel');
const panelRoot = document.getElementById('mode-panel');
const infoRoot = document.getElementById('info');

// The switcher lives outside #mode-panel because mount() overwrites the panel body.
const switchWrap = document.createElement('div');
switchWrap.className = 'mode-switch';
switchWrap.innerHTML = `
  <label for="mode-select">Creator</label>
  <select id="mode-select" title="Switch modes (keys 1–${MODES.length})"></select>
  <span id="save-status" role="status" aria-live="polite">Saved</span>
  <button id="panel-collapse" type="button" title="Collapse panel" aria-label="Collapse panel">–</button>
`;
panel.insertBefore(switchWrap, panelRoot);

const select = switchWrap.querySelector('#mode-select');
const saveStatus = switchWrap.querySelector('#save-status');

const selectionLock = document.createElement('label');
selectionLock.className = 'selection-lock';
selectionLock.htmlFor = 'block-selection';
selectionLock.title = 'Ignore existing strokes so you only draw new ones';
selectionLock.innerHTML = `
  <input id="block-selection" type="checkbox" />
  <span>Draw only</span>
`;
const selectionBlockInput = selectionLock.querySelector('#block-selection');

/** Keep the shared lock below mode chrome / draw tools after each mode mount. */
function placeSelectionLock() {
  const host = panelRoot.querySelector('[data-selection-lock-host]');
  if (host) {
    host.replaceChildren(selectionLock);
    return;
  }
  const head = panelRoot.querySelector('.mode-head');
  if (head) {
    head.after(selectionLock);
    return;
  }
  panelRoot.prepend(selectionLock);
}

const ctx = await createDemoContext();
const sharedState = createSigilState();
const sharedStrokes = [];
const interactionState = new EventTarget();
interactionState.blockSelection = false;
// Mode-private state (e.g. paint-on-mesh strokes + target) that should
// survive switching away and back within the session.
const modeStores = new Map();

// WebGL2 can display TSL chrome, but field/laplacian compute is WebGPU-only.
// Pin the field backend so rebuilds don't attempt GPU kernels that will fail.
if (ctx.renderBackend === 'webgl' && sharedState.backend !== 'cpu') {
  sharedState.backend = 'cpu';
  console.info('Sigils Creator: WebGL path — field backend forced to cpu.');
}

for (const mode of MODES) {
  const label = demoModeLabel(mode.meta);
  const opt = new Option(label, mode.meta.id);
  if (ctx.renderBackend === 'webgl' && mode.meta.id === 'meshless') {
    opt.disabled = true;
    opt.textContent = `${label} (needs WebGPU)`;
  }
  select.add(opt);
}

let activeUnmount = null;
let activeId = null;

// --- session persistence -----------------------------------------------
// Controls, strokes, active mode and the panel collapse state round-trip
// through localStorage so a reload doesn't wipe tuned settings or drawings.

let persistTimer = 0;
let saveStatusTimer = 0;
let lastPersistedPayload = null;

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    lastPersistedPayload = raw;
    return parsed;
  } catch {
    return null;
  }
}

function isPoint(p) {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

function sanePath(points, minLength = 2, { pointRadius = false } = {}) {
  if (!Array.isArray(points) || points.length < minLength || !points.every(isPoint)) return null;
  return points.map(([x, y, radiusScale]) => (
    pointRadius && Number.isFinite(radiusScale)
      ? [x, y, radiusScale]
      : [x, y]
  ));
}

/** Rebuild a stroke-session record from its serialized form (drop anything malformed). */
function reviveStroke(s) {
  if (Array.isArray(s)) return sanePath(s, 2, { pointRadius: true }); // legacy plain-path strokes
  if (!s || typeof s !== 'object') return null;
  const draw = {
    symmetry: Math.max(1, Math.floor(s.draw?.symmetry ?? 1)),
    mirror: s.draw?.mirror === true,
    phase: Number.isFinite(s.draw?.phase) ? s.draw.phase : 0,
    center: isPoint(s.draw?.center) ? [s.draw.center[0], s.draw.center[1]] : [0, 0],
  };
  if (s.kind === 'spline') {
    const cvs = sanePath(s.cvs);
    if (!cvs) return null;
    const closed = s.closed === true;
    const cvRadiusScales = normalizeCvRadiusScales(cvs, s.cvRadiusScales);
    return {
      kind: 'spline',
      cvs,
      cvRadiusScales,
      closed,
      points: sampleSplinePoints(cvs, closed, cvRadiusScales),
      draw,
      expanded: null,
    };
  }
  // Preserve an optional third channel so PointerEvent.pressure can map to
  // freehand radius later without another persistence migration.
  const points = sanePath(s.points, 2, { pointRadius: true });
  if (!points) return null;
  return { points, draw, expanded: null };
}

function persist() {
  clearTimeout(persistTimer);
  clearTimeout(saveStatusTimer);
  persistTimer = 0;
  saveStatusTimer = 0;
  try {
    const strokes = sharedStrokes.map((s) => {
      if (Array.isArray(s)) return s;
      if (s.kind === 'spline') {
        return {
          kind: 'spline',
          cvs: s.cvs,
          cvRadiusScales: s.cvRadiusScales,
          closed: s.closed,
          draw: s.draw,
        };
      }
      return { points: s.points, draw: s.draw };
    });
    const savedModeStores = {};
    for (const mode of MODES) {
      const store = modeStores.get(mode.meta.id);
      if (!store || typeof mode.serializeStore !== 'function') continue;
      savedModeStores[mode.meta.id] = mode.serializeStore(store);
    }
    const payload = JSON.stringify({
      version: 4,
      mode: activeId,
      collapsed: panel.classList.contains('collapsed'),
      blockSelection: interactionState.blockSelection,
      controls: sharedState,
      strokes,
      modeStores: savedModeStores,
    });
    // Pointer selection, hover and other display-only interactions still emit
    // input events; avoid rewriting localStorage when serialized state did not
    // actually change.
    if (payload !== lastPersistedPayload) {
      localStorage.setItem(STORAGE_KEY, payload);
      lastPersistedPayload = payload;
    }
    saveStatus.textContent = 'Saved';
    saveStatus.dataset.state = 'saved';
  } catch {
    // Best effort — storage may be unavailable (private mode) or full.
    saveStatus.textContent = 'Not saved';
    saveStatus.dataset.state = 'error';
  }
}

function requestPersist() {
  clearTimeout(persistTimer);
  clearTimeout(saveStatusTimer);
  persistTimer = setTimeout(persist, PERSIST_IDLE_MS);
  // Do not flash "Saving…" for every slider tick. It appears only after the
  // user pauses briefly and a real save is still pending.
  if (saveStatus.dataset.state !== 'saving') {
    saveStatusTimer = setTimeout(() => {
      if (!persistTimer) return;
      saveStatus.textContent = 'Saving…';
      saveStatus.dataset.state = 'saving';
    }, SAVE_STATUS_DELAY_MS);
  }
}

function flushPersist() {
  clearTimeout(persistTimer);
  clearTimeout(saveStatusTimer);
  persistTimer = 0;
  saveStatusTimer = 0;
  persist();
}

const saved = loadSaved();
interactionState.blockSelection = saved?.blockSelection === true;
selectionBlockInput.checked = interactionState.blockSelection;
selectionBlockInput.addEventListener('change', () => {
  interactionState.blockSelection = selectionBlockInput.checked;
  interactionState.dispatchEvent(new Event('blockselectionchange'));
  requestPersist();
});
if (saved?.controls && typeof saved.controls === 'object') {
  for (const [key, value] of Object.entries(saved.controls)) {
    if (key in sharedState && typeof value === typeof sharedState[key]) sharedState[key] = value;
  }
  // Chrome roughness is capped at 0.05 in the demo; older saves may exceed it.
  if (typeof sharedState.roughness === 'number') {
    sharedState.roughness = Math.min(sharedState.roughness, 0.05);
  }
  // Saved hybrid preference is meaningless on the WebGL path.
  if (ctx.renderBackend === 'webgl') sharedState.backend = 'cpu';
}
const startup = resolveDemoStartup(saved?.mode, sharedState.drawTool);
sharedState.drawTool = startup.drawTool;
if (Array.isArray(saved?.strokes)) {
  for (const s of saved.strokes) {
    const record = reviveStroke(s);
    if (record) sharedStrokes.push(record);
  }
}

if (saved?.modeStores && typeof saved.modeStores === 'object') {
  for (const mode of MODES) {
    const value = saved.modeStores[mode.meta.id];
    if (!value || typeof mode.restoreStore !== 'function') continue;
    try {
      modeStores.set(mode.meta.id, await mode.restoreStore(value));
    } catch (error) {
      console.warn(`mode "${mode.meta.id}" state restore failed`, error);
    }
  }
}

addEventListener('pagehide', flushPersist);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPersist();
});
// Incremental saves cover mobile tab eviction and crashes where unload never
// fires. The debounce runs after mode handlers have updated their stores.
panel.addEventListener('input', requestPersist);
panel.addEventListener('change', requestPersist);
panel.addEventListener('click', requestPersist);
addEventListener('pointerup', requestPersist);
addEventListener('keydown', (event) => {
  if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z')
    || event.key === 'Enter') requestPersist();
});

// --- panel collapse -------------------------------------------------------

const collapseBtn = switchWrap.querySelector('#panel-collapse');

function setCollapsed(on) {
  panel.classList.toggle('collapsed', on);
  collapseBtn.textContent = on ? '+' : '–';
  collapseBtn.title = on ? 'Expand panel' : 'Collapse panel';
  collapseBtn.setAttribute('aria-label', collapseBtn.title);
  collapseBtn.setAttribute('aria-expanded', String(!on));
}

collapseBtn.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));
if (saved?.collapsed) setCollapsed(true);

// --- mode switching ---------------------------------------------------------

function switchTo(id) {
  if (id === activeId) return;
  // Raymarch needs WebGPU compute — keep the option visible but refuse entry.
  if (ctx.renderBackend === 'webgl' && id === 'meshless') return;
  activeUnmount?.();
  panelRoot.innerHTML = '';
  infoRoot.innerHTML = '';
  const mode = MODES.find((m) => m.meta.id === id) ?? MODES[0];
  let store = modeStores.get(mode.meta.id);
  if (!store) {
    store = {};
    modeStores.set(mode.meta.id, store);
  }
  // If mount() throws partway, the half-mounted mode never returned its unmount
  // closure; clear the active refs so a later switch does not re-call the OLD
  // mode's unmount and so we never hold a stale unmount for a broken mode.
  activeUnmount = null;
  activeId = null;
  try {
    activeUnmount = mode.mount(ctx, {
      panelRoot,
      infoRoot,
      state: sharedState,
      strokes: sharedStrokes,
      store,
      interaction: interactionState,
      requestPersist,
    });
    activeId = mode.meta.id;
    select.value = activeId;
    placeSelectionLock();
    requestPersist();
  } catch (error) {
    console.error(`mode "${id}" failed to mount`, error);
  }
}

select.addEventListener('change', (event) => switchTo(event.target.value));

addEventListener('keydown', (event) => {
  const tag = event.target?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const n = Number(event.key);
  if (Number.isInteger(n) && n >= 1 && n <= MODES.length) switchTo(MODES[n - 1].meta.id);
});

switchTo(
  ctx.renderBackend === 'webgl' && startup.mode === 'meshless'
    ? MODES[0].meta.id
    : startup.mode,
);

addEventListener('beforeunload', () => {
  activeUnmount?.();
  flushPersist();
});
