import { createDemoContext } from './shared/demoContext.js';
import * as realtime from './modes/realtime.js';
import * as meshless from './modes/meshless.js';

// Registry of example modes. realtime stays the default (index 0).
const MODES = [realtime, meshless];

const panel = document.getElementById('panel');
const panelRoot = document.getElementById('mode-panel');
const infoRoot = document.getElementById('info');

// The switcher lives OUTSIDE #mode-panel (mount() overwrites #mode-panel.innerHTML),
// so app.js injects it as a sibling before #mode-panel. The CSS for
// .mode-switch / #mode-hint already ships in index.html.
const switchWrap = document.createElement('div');
switchWrap.className = 'mode-switch';
switchWrap.innerHTML = '<label for="mode-select">Mode</label><select id="mode-select"></select>';
const hintEl = document.createElement('p');
hintEl.id = 'mode-hint';
panel.insertBefore(switchWrap, panelRoot);
panel.insertBefore(hintEl, panelRoot);

const select = switchWrap.querySelector('#mode-select');
for (const mode of MODES) select.add(new Option(mode.meta.label, mode.meta.id));

const ctx = await createDemoContext();

let activeUnmount = null;
let activeId = null;

function switchTo(id) {
  if (id === activeId) return;
  activeUnmount?.();
  panelRoot.innerHTML = '';
  infoRoot.innerHTML = '';
  const mode = MODES.find((m) => m.meta.id === id) ?? MODES[0];
  hintEl.textContent = mode.meta.hint;
  // If mount() throws partway, the half-mounted mode never returned its unmount
  // closure; clear the active refs so a later switch does not re-call the OLD
  // mode's unmount and so we never hold a stale unmount for a broken mode.
  activeUnmount = null;
  activeId = null;
  try {
    activeUnmount = mode.mount(ctx, { panelRoot, infoRoot });
    activeId = mode.meta.id;
    select.value = activeId;
  } catch (error) {
    console.error(`mode "${id}" failed to mount`, error);
  }
}

select.addEventListener('change', (event) => switchTo(event.target.value));
switchTo(MODES[0].meta.id);

addEventListener('beforeunload', () => activeUnmount?.());
