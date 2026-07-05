import {
  bspline,
  radialSymmetry,
  shapeOptionsFromState,
} from '../../src/index.js';

const DRAW_SETTING_KEYS = new Set(['symmetry', 'mirror', 'phase', 'center']);

export function isDrawSettingKey(key) {
  return DRAW_SETTING_KEYS.has(key);
}

export function makeStrokeRecord(points, state) {
  const record = {
    points: clonePath(points),
    draw: captureDrawSettings(state),
    expanded: null,
  };
  record.expanded = expandStrokeRecord(record);
  return record;
}

export function strokePoints(stroke) {
  return Array.isArray(stroke) ? stroke : stroke.points;
}

/**
 * Editable CV-curve record (Alias-style B-spline). `points` is the sampled
 * polyline the build pipeline consumes; `cvs` stays authoritative so the
 * curve can be re-edited after commit.
 */
export function makeSplineRecord(cvs, closed, state) {
  const record = {
    kind: 'spline',
    cvs: clonePath(cvs),
    closed: closed === true,
    points: sampleSplinePoints(cvs, closed),
    draw: captureDrawSettings(state),
    expanded: null,
  };
  record.expanded = expandStrokeRecord(record);
  return record;
}

export function isSplineRecord(stroke) {
  return !!stroke && !Array.isArray(stroke) && stroke.kind === 'spline';
}

/** Re-sample a spline record after its CVs changed (drag edit). */
export function updateSplineRecord(record, cvs = record.cvs, closed = record.closed) {
  record.cvs = clonePath(cvs);
  record.closed = closed === true;
  record.points = sampleSplinePoints(record.cvs, record.closed);
  record.expanded = expandStrokeRecord(record);
  return record;
}

export function sampleSplinePoints(cvs, closed) {
  const points = bspline(cvs, { closed });
  // The field/strip builders detect closure by endpoint proximity; the periodic
  // sampler omits the seam sample, so close the polyline explicitly.
  if (closed && points.length >= 3) points.push([points[0][0], points[0][1]]);
  return points;
}

/** Expand loose points with the CURRENT draw settings (live draft preview). */
export function expandActivePaths(points, state) {
  return expandPoints(points, captureDrawSettings(state));
}

export function committedBuildPaths(strokes) {
  const paths = [];
  for (const stroke of strokes) paths.push(...expandedStrokePaths(stroke));
  return paths;
}

export function activeBuildPaths(strokes, current, state) {
  const paths = committedBuildPaths(strokes);
  if (current.length >= 2) {
    paths.push(...expandPoints(current, captureDrawSettings(state)));
  }
  return paths;
}

export function buildOptionsForSession(state) {
  return {
    ...shapeOptionsFromState(state),
    symmetry: 1,
    mirror: false,
    phase: 0,
  };
}

function captureDrawSettings(state) {
  return {
    symmetry: Math.max(1, Math.floor(state.symmetry ?? 1)),
    mirror: state.mirror === true,
    phase: state.phase ?? 0,
    center: clonePoint(state.center ?? [0, 0]),
  };
}

function expandedStrokePaths(stroke) {
  if (Array.isArray(stroke)) return [stroke];
  if (!stroke.expanded) stroke.expanded = expandStrokeRecord(stroke);
  return stroke.expanded;
}

function expandStrokeRecord(stroke) {
  return expandPoints(stroke.points, stroke.draw);
}

function expandPoints(points, draw) {
  if (!points || points.length < 2) return [];
  if ((draw.symmetry ?? 1) <= 1 && draw.mirror !== true) return [clonePath(points)];
  return radialSymmetry([points], draw).map(clonePath);
}

function clonePath(points) {
  return points.map(clonePoint);
}

function clonePoint(point) {
  return [point[0], point[1]];
}
