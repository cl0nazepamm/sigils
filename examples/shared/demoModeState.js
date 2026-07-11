export const DRAW_MODE_ID = 'realtime';
export const LEGACY_CV_MODE_ID = 'spline';
export const DRAW_TOOLS = Object.freeze(['freehand', 'spline']);

/** Keep persisted tool values inside the two drawing interactions we support. */
export function sanitizeDrawTool(value) {
  return DRAW_TOOLS.includes(value) ? value : 'freehand';
}

/**
 * Fold the removed standalone CV mode into Drawing without losing its intent.
 * Older saves that last used `spline` reopen Drawing with the CV tool active;
 * all other saves retain a valid explicitly saved drawing tool.
 */
export function resolveDemoStartup(savedMode, savedDrawTool) {
  if (savedMode === LEGACY_CV_MODE_ID) {
    return { mode: DRAW_MODE_ID, drawTool: 'spline' };
  }
  return {
    mode: typeof savedMode === 'string' ? savedMode : DRAW_MODE_ID,
    drawTool: sanitizeDrawTool(savedDrawTool),
  };
}

/** User-facing label while the stable persisted mode id remains `realtime`. */
export function demoModeLabel(meta) {
  return meta?.id === DRAW_MODE_ID ? 'Drawing' : (meta?.label ?? '');
}
