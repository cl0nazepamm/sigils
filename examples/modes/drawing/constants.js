/**
 * Drawing mode picking / history / tool constants.
 */

import {
  MAX_CV_RADIUS_SCALE,
  MIN_CV_RADIUS_SCALE,
} from '../../shared/strokeSession.js';

export const PICK_RADIUS_PX = 14;
export const HANDLE_RADIUS_PX = 5;
export const RADIUS_PICK_TOLERANCE_PX = 8;
export const TOUCH_HANDLE_RADIUS_PX = 12;
export const TOUCH_PICK_RADIUS_PX = 20;
export const TOUCH_RADIUS_TOLERANCE_PX = 14;
export const STROKE_PICK_PAD_PX = 6;
export const DOUBLE_CLICK_WINDOW_MS = 600;
export const DOUBLE_CLICK_SLOP_PX = 8;
export const CLOSE_MIN_CVS = 3;
export const MAX_HISTORY = 100;

export const CV_RADIUS_SPEC = {
  key: 'cvRadiusScale',
  label: 'New point width ×',
  type: 'range',
  min: MIN_CV_RADIUS_SCALE,
  max: MAX_CV_RADIUS_SCALE,
  step: 0.01,
};

export const ACTIVE_CVS_SPEC = {
  key: 'showActiveCvs',
  label: 'Show curve points',
  type: 'check',
};

export const DRAW_TOOLS = new Set(['freehand', 'spline']);
