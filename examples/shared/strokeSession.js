import {
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
