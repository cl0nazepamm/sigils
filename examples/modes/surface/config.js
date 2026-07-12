/**
 * Paint-on-Mesh panel specs and interaction constants.
 */

import {
  MAX_CV_RADIUS_SCALE,
  MIN_CV_RADIUS_SCALE,
} from '../../shared/strokeSession.js';

export const SURFACE_CONTROL_SPECS = [
  { type: 'section', label: 'Main', main: true, open: true },
  { key: 'width', label: 'Width', type: 'range', min: 0.002, max: 0.06, step: 0.001, main: true },
  // Peak rides the width as a RATIO: the extractor artifacts live in the
  // aspect (peak/width), so tangling the two keeps every size in the safe
  // band — thin wires get low peaks, big wires tall ones, automatically.
  // Floor is low enough for shallow mesh carves; the field budget still
  // coarsens if an extreme aspect would otherwise fragment.
  { key: 'peak', label: 'Peak ratio', type: 'range', min: 0.05, max: 3, step: 0.01, forge: 'welded', main: true },
  { key: 'patchHeight', label: 'Height', type: 'range', min: 0, max: 0.2, step: 0.001, forge: 'patch', main: true },
  { key: 'conform', label: 'Conform', type: 'range', min: 0, max: 1.5, step: 0.01, main: true },
  { key: 'res', label: 'Resolution', type: 'range', min: 0.5, max: 4, step: 0.05, forge: 'welded', main: true },
  { key: 'patchResolution', label: 'Resolution', type: 'range', min: 0.25, max: 4, step: 0.05, forge: 'patch', main: true },

  { type: 'group' },
  { type: 'section', label: 'Geometry', open: true },
  { key: 'surfaceBackend', label: 'Backend', type: 'select', options: [['welded', 'Welded volume'], ['patch', 'Surface patch']] },
  { key: 'manualMeshing', label: 'Manual meshing', type: 'check' },

  { type: 'section', label: 'Stroke', open: true },
  { key: 'symmetry', label: 'Symmetry', type: 'range', min: 1, max: 12, step: 1, int: true },
  { key: 'mirror', label: 'Mirror', type: 'check' },
  { key: 'flow', label: 'Flow', type: 'range', min: 0, max: 10, step: 1, int: true },
  { key: 'cvRadiusScale', label: 'New point width ×', type: 'range', min: MIN_CV_RADIUS_SCALE, max: MAX_CV_RADIUS_SCALE, step: 0.01, forge: 'surface-cv' },
  { key: 'showActiveCvs', label: 'Show curve points', type: 'check', forge: 'surface-cv' },
  { key: 'guides', label: 'Curves', type: 'check' },
  { type: 'hostReset' },

  { type: 'group' },
  { type: 'section', label: 'Welded volume', forge: 'welded' },
  { key: 'relief', label: 'Relief', type: 'select', options: [['carve', 'carve (peaked)'], ['plateau', 'plateau'], ['round', 'round']] },
  { key: 'melt', label: 'Melt', type: 'range', min: 0, max: 1, step: 0.01 },
  { key: 'taper', label: 'Taper length', type: 'range', min: 1, max: 8, step: 0.1 },
  { key: 'taperPower', label: 'Taper shape', type: 'range', min: 0.3, max: 2.4, step: 0.02 },
  { key: 'wobble', label: 'Wobble', type: 'range', min: 0, max: 1, step: 0.01 },

  { type: 'section', label: 'Thorns', forge: 'welded' },
  { key: 'thorns', label: 'Density', type: 'range', min: 0, max: 1, step: 0.01 },
  { key: 'spike', label: 'Spike', type: 'range', min: 1, max: 7, step: 0.1 },
  { type: 'hostReset' },

  { type: 'section', label: 'Surface patch', forge: 'patch' },
  { key: 'patchRelief', label: 'Relief', type: 'select', options: [['round', 'round (liquid)'], ['carve', 'carve (peaked)'], ['plateau', 'plateau']] },
  { key: 'patchFalloff', label: 'Falloff', type: 'range', min: 0.1, max: 1, step: 0.01 },
  { key: 'patchMelt', label: 'Melt', type: 'range', min: 0, max: 40, step: 1, int: true },
  { key: 'patchTaper', label: 'Taper length', type: 'range', min: 0, max: 8, step: 0.1 },
  { key: 'patchTaperPower', label: 'Taper shape', type: 'range', min: 0.3, max: 2.4, step: 0.05 },
  { key: 'patchPolish', label: 'Liquid polish', type: 'range', min: 0, max: 16, step: 1, int: true },

  { type: 'group' },
  { type: 'section', label: 'Chrome', open: true },
  { key: 'color', label: 'Color', type: 'color', live: true },
  { key: 'metalness', label: 'Metalness', type: 'range', min: 0, max: 1, step: 0.01, live: true },
  { key: 'rough', label: 'Rough', type: 'range', min: 0, max: 1, step: 0.01, live: true },

  { type: 'section', label: 'Target' },
  { key: 'targetColor', label: 'Base color', type: 'color', live: true },
  { key: 'targetMetalness', label: 'Metalness', type: 'range', min: 0, max: 1, step: 0.01, live: true },
  { key: 'targetRoughness', label: 'Roughness', type: 'range', min: 0, max: 1, step: 0.01, live: true },
  { type: 'hostReset' },
];

// world-unit resample step for conformed strokes; dense enough for the
// smallest brush the panel offers, independent of the brush itself so width
// changes never force a re-conform of committed strokes
export const CONFORM_STEP = 0.012;
export const MAX_CONFORM_POINTS = 300;
export const HANDLE_RADIUS_PX = 6;
export const PICK_RADIUS_PX = 15;
export const RADIUS_PICK_TOLERANCE_PX = 8;
export const TOUCH_HANDLE_RADIUS_PX = 12;
export const TOUCH_PICK_RADIUS_PX = 22;
export const TOUCH_RADIUS_TOLERANCE_PX = 14;
export const STROKE_PICK_PAD_PX = 7;
export const CLOSE_MIN_CVS = 3;
export const DOUBLE_CLICK_WINDOW_MS = 600;
export const DOUBLE_CLICK_SLOP_PX = 8;
export const MAX_HISTORY = 64;
export const NAVIGATION_PICK_DEBOUNCE_MS = 180;
