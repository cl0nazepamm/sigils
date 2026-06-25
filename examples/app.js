import { createDemoContext } from './shared/demoContext.js';
import * as studio from './modes/realtime.js';

const panelRoot = document.getElementById('mode-panel');
const infoRoot = document.getElementById('info');

const ctx = await createDemoContext();
const unmount = studio.mount(ctx, { panelRoot, infoRoot });

addEventListener('beforeunload', () => unmount());
