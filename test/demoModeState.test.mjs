import assert from 'node:assert/strict';
import { createSigilState } from '../examples/shared/sigilDefaults.js';
import {
  demoModeLabel,
  resolveDemoStartup,
  sanitizeDrawTool,
} from '../examples/shared/demoModeState.js';

assert.deepEqual(
  resolveDemoStartup('spline', 'freehand'),
  { mode: 'realtime', drawTool: 'spline' },
  'the removed CV mode reopens Drawing with the CV tool selected',
);
assert.deepEqual(
  resolveDemoStartup('realtime', undefined),
  { mode: 'realtime', drawTool: 'freehand' },
  'old Drawing saves without a tool retain the freehand behavior',
);
assert.deepEqual(
  resolveDemoStartup('meshless', 'spline'),
  { mode: 'meshless', drawTool: 'spline' },
  'other modes preserve a valid saved Drawing tool for the next switch',
);
assert.equal(sanitizeDrawTool('invalid'), 'freehand', 'unknown saved tool values are sanitized');
assert.equal(createSigilState({ drawTool: 'invalid' }).drawTool, 'freehand', 'runtime state sanitizes invalid tools');
assert.equal(createSigilState({ drawTool: 'spline' }).drawTool, 'spline', 'runtime state preserves the CV tool');
assert.equal(demoModeLabel({ id: 'realtime', label: 'Freehand' }), 'Drawing', 'stable realtime id is labeled Drawing');
assert.equal(demoModeLabel({ id: 'surface', label: 'Paint on Mesh' }), 'Paint on Mesh', 'other labels pass through');

console.log('demo mode state OK');
