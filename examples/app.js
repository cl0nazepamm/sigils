import { createDemoContext } from './shared/demoContext.js';
import * as realtime from './modes/realtime.js';
import * as spline from './modes/spline.js';
import * as meshless from './modes/meshless.js';
import { createSigilState } from '../src/index.js';

// Registry of example modes. realtime (freehand) stays the default (index 0).
const MODES = [realtime, spline, meshless];

const panel = document.getElementById('panel');
const panelRoot = document.getElementById('mode-panel');
const infoRoot = document.getElementById('info');

// The switcher lives outside #mode-panel because mount() overwrites the panel body.
const switchWrap = document.createElement('div');
switchWrap.className = 'mode-switch';
switchWrap.innerHTML = '<label for="mode-select">Mode</label><select id="mode-select"></select>';
panel.insertBefore(switchWrap, panelRoot);

const select = switchWrap.querySelector('#mode-select');
for (const mode of MODES) select.add(new Option(mode.meta.label, mode.meta.id));

const ctx = await createDemoContext();
const sharedState = createSigilState();
const sharedStrokes = [];

let activeUnmount = null;
let activeId = null;

function switchTo(id) {
  if (id === activeId) return;
  activeUnmount?.();
  panelRoot.innerHTML = '';
  infoRoot.innerHTML = '';
  const mode = MODES.find((m) => m.meta.id === id) ?? MODES[0];
  // If mount() throws partway, the half-mounted mode never returned its unmount
  // closure; clear the active refs so a later switch does not re-call the OLD
  // mode's unmount and so we never hold a stale unmount for a broken mode.
  activeUnmount = null;
  activeId = null;
  try {
    activeUnmount = mode.mount(ctx, { panelRoot, infoRoot, state: sharedState, strokes: sharedStrokes });
    activeId = mode.meta.id;
    select.value = activeId;
  } catch (error) {
    console.error(`mode "${id}" failed to mount`, error);
  }
}

select.addEventListener('change', (event) => switchTo(event.target.value));
switchTo(MODES[0].meta.id);

addEventListener('beforeunload', () => activeUnmount?.());
