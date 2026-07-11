import { bspline, radialSymmetry } from '../../src/index.js';
import { shapeOptionsFromState } from './sigilDefaults.js';

const DRAW_SETTING_KEYS = new Set(['symmetry', 'mirror', 'phase', 'center']);

export const MIN_CV_RADIUS_SCALE = 0.05;
export const MAX_CV_RADIUS_SCALE = 3;

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
export function makeSplineRecord(cvs, closed, state, cvRadiusScales = null) {
  const radii = normalizeCvRadiusScales(cvs, cvRadiusScales);
  const record = {
    kind: 'spline',
    cvs: clonePath(cvs),
    cvRadiusScales: radii,
    closed: closed === true,
    points: sampleSplinePoints(cvs, closed, radii),
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
export function updateSplineRecord(
  record,
  cvs = record.cvs,
  closed = record.closed,
  cvRadiusScales = record.cvRadiusScales,
) {
  record.cvs = clonePath(cvs);
  record.cvRadiusScales = normalizeCvRadiusScales(record.cvs, cvRadiusScales);
  record.closed = closed === true;
  record.points = sampleSplinePoints(record.cvs, record.closed, record.cvRadiusScales);
  record.expanded = expandStrokeRecord(record);
  return record;
}

/** Deep-clone only the fields a user edit may change. */
export function cloneStrokeEdit(record) {
  if (isSplineRecord(record)) {
    return {
      kind: 'spline',
      cvs: clonePath(record.cvs),
      cvRadiusScales: normalizeCvRadiusScales(record.cvs, record.cvRadiusScales).slice(),
      closed: record.closed === true,
    };
  }
  return {
    kind: 'freehand',
    points: clonePath(strokePoints(record)),
  };
}

/** Restore an edit snapshot without changing record identity or draw settings. */
export function restoreStrokeEdit(record, snapshot) {
  if (snapshot?.kind === 'spline') {
    if (!isSplineRecord(record)) {
      throw new TypeError('stroke session: snapshot kind does not match its record.');
    }
    return updateSplineRecord(record, snapshot.cvs, snapshot.closed, snapshot.cvRadiusScales);
  }
  if (snapshot?.kind !== 'freehand' || isSplineRecord(record) || !record) {
    throw new TypeError('stroke session: snapshot kind does not match its record.');
  }
  record.points = clonePath(snapshot.points);
  record.expanded = expandStrokeRecord(record);
  return record;
}

export function sampleSplinePoints(cvs, closed, cvRadiusScales = null) {
  const radiusScales = cvRadiusScales == null
    ? null
    : normalizeCvRadiusScales(cvs, cvRadiusScales);
  const points = bspline(cvs, { closed, radiusScales });
  // The field/strip builders detect closure by endpoint proximity; the periodic
  // sampler omits the seam sample, so close the polyline explicitly.
  if (closed && points.length >= 3) points.push(clonePoint(points[0]));
  return points;
}

/** Sanitize the authoritative per-CV profile while keeping it index-aligned. */
export function normalizeCvRadiusScales(cvs, values, fallback = 1) {
  const safeFallback = clampCvRadiusScale(fallback);
  return cvs.map((_, index) => clampCvRadiusScale(values?.[index], safeFallback));
}

export function clampCvRadiusScale(value, fallback = 1) {
  const n = Number(value);
  const fallbackNumber = Number(fallback);
  const safe = Number.isFinite(n) ? n : Number.isFinite(fallbackNumber) ? fallbackNumber : 1;
  return Math.min(MAX_CV_RADIUS_SCALE, Math.max(MIN_CV_RADIUS_SCALE, safe));
}

/** World-space radius shown by a CV guide ring. */
export function cvRadiusGuideRadius(thickness, radiusScale) {
  const width = Number(thickness);
  const halfWidth = Number.isFinite(width) ? Math.abs(width) * 0.5 : 0;
  return halfWidth * clampCvRadiusScale(radiusScale);
}

/**
 * Convert a radial pointer drag back to the normalized CV radius channel.
 * Keeping the initial pointer distance makes off-center ring grabs jump-free.
 */
export function cvRadiusScaleFromDrag(
  startScale,
  startDistance,
  currentDistance,
  thickness,
) {
  const width = Number(thickness);
  const halfWidth = Number.isFinite(width) ? Math.abs(width) * 0.5 : 0;
  if (halfWidth <= 1e-9) return clampCvRadiusScale(startScale);
  return clampCvRadiusScale(
    Number(startScale) + (Number(currentDistance) - Number(startDistance)) / halfWidth,
    startScale,
  );
}

/**
 * CV splice index for a hit on a uniformly sampled B-spline polyline.
 * Open curves keep endpoints pinned; closed curves may append at `cvCount`.
 *
 * Important: an open cubic only has `n - degree` spans, so the hit parameter
 * must be mapped across the full interior CV range `[1, n-1]`. Using
 * `ceil(span)` alone stranded inserts in the early slots.
 */
export function cvInsertIndexFromHit(cvCount, closed, hit, samplesPerSpan = 16) {
  const n = Math.max(0, Math.floor(Number(cvCount) || 0));
  if (n < 2) return 1;
  const degree = Math.max(1, Math.min(3, n - 1));
  const spans = closed ? n : Math.max(1, n - degree);
  const perSpan = Math.max(2, Math.floor(Number(samplesPerSpan) || 16));
  const segment = Number(hit?.segmentIndex);
  const t = Number(hit?.t);
  const param = Math.min(
    spans,
    Math.max(0, ((Number.isFinite(segment) ? segment : 0) + (Number.isFinite(t) ? t : 0)) / perSpan),
  );
  const u = spans > 0 ? param / spans : 0;
  if (closed) {
    const insertAt = Math.round(u * n);
    if (insertAt <= 0) return 1;
    return insertAt >= n ? n : insertAt;
  }
  const insertAt = Math.round(u * (n - 1));
  return Math.min(n - 1, Math.max(1, insertAt));
}

/**
 * CV splice index from arc-length along a sampled 2D polyline hit.
 * More reliable than span-ceil when the path includes a closed seam sample.
 */
export function cvInsertIndexFromPathHit(cvCount, closed, path, hit) {
  const n = Math.max(0, Math.floor(Number(cvCount) || 0));
  if (n < 2) return 1;
  const segmentIndex = Number(hit?.segmentIndex);
  const tHit = Number(hit?.t);
  if (!Array.isArray(path) || path.length < 2
    || !Number.isFinite(segmentIndex) || segmentIndex < 0) {
    return 1;
  }

  let total = 0;
  let toHit = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const seg = i - 1;
    if (seg < segmentIndex) toHit += len;
    else if (seg === segmentIndex) {
      const t = Number.isFinite(tHit) ? Math.min(1, Math.max(0, tHit)) : 0;
      toHit += len * t;
    }
    total += len;
  }
  if (!(total > 1e-12)) return 1;
  const u = Math.min(1, Math.max(0, toHit / total));
  if (closed) {
    const insertAt = Math.round(u * n);
    if (insertAt <= 0) return 1;
    return insertAt >= n ? n : insertAt;
  }
  const insertAt = Math.round(u * (n - 1));
  return Math.min(n - 1, Math.max(1, insertAt));
}

/** Closest point coordinates on a 2D polyline hit from {@link closestPointOnPolyline2D}. */
export function pointOnPolyline2DHit(path, hit) {
  if (!Array.isArray(path) || path.length === 0 || !hit || hit.segmentIndex < 0) return null;
  if (path.length === 1) return [path[0][0], path[0][1]];
  const a = path[hit.segmentIndex];
  const b = path[hit.segmentIndex + 1] ?? a;
  if (!a || !b) return null;
  const t = Number.isFinite(hit.t) ? hit.t : 0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Pick a direct CV control. The visible center disk wins first, then the
 * radius ring, then the larger forgiving center-hit area used for movement.
 */
export function pickCvControl(point, candidates, opts = {}) {
  if (!point || !Array.isArray(candidates) || candidates.length === 0) return null;
  const handleRadius = Math.max(0, Number(opts.handleRadius) || 0);
  const centerTolerance = Math.max(handleRadius, Number(opts.centerTolerance) || 0);
  const ringTolerance = Math.max(0, Number(opts.ringTolerance) || 0);
  const ringRatioValue = Number(opts.ringInnerRatio ?? 0.9);
  const ringInnerRatio = Number.isFinite(ringRatioValue)
    ? Math.min(1, Math.max(0, ringRatioValue))
    : 0.9;
  const thickness = opts.thickness;
  let handleHit = null;
  let handleDistance = handleRadius;
  let ringHit = null;
  let ringResidual = ringTolerance;
  let centerHit = null;
  let centerDistance = centerTolerance;

  for (const candidate of candidates) {
    const cv = candidate?.cv;
    if (!cv) continue;
    const distance = Math.hypot(point[0] - cv[0], point[1] - cv[1]);

    if (distance <= handleRadius && (!handleHit || distance < handleDistance)) {
      handleHit = candidate;
      handleDistance = distance;
    }

    const outerRadius = cvRadiusGuideRadius(thickness, candidate.radiusScale);
    const innerRadius = outerRadius * ringInnerRatio;
    const residual = distance < innerRadius
      ? innerRadius - distance
      : distance > outerRadius
        ? distance - outerRadius
        : 0;
    if (residual <= ringTolerance && (!ringHit || residual < ringResidual)) {
      ringHit = candidate;
      ringResidual = residual;
    }

    if (distance <= centerTolerance && (!centerHit || distance < centerDistance)) {
      centerHit = candidate;
      centerDistance = distance;
    }
  }

  if (handleHit) return { ...handleHit, kind: 'move' };
  if (ringHit) return { ...ringHit, kind: 'radius' };
  if (centerHit) return { ...centerHit, kind: 'move' };
  return null;
}

/** Shortest 2D distance from a point to a sampled polyline. */
export function distanceToPolyline2D(point, path) {
  return closestPointOnPolyline2D(point, path).distance;
}

/** Nearest sampled segment plus its interpolated point-radius channel. */
export function closestPointOnPolyline2D(point, path) {
  if (!point || !Array.isArray(path) || path.length === 0) {
    return { distance: Infinity, segmentIndex: -1, t: 0, radiusScale: 1 };
  }
  if (path.length === 1) {
    return {
      distance: Math.hypot(point[0] - path[0][0], point[1] - path[0][1]),
      segmentIndex: 0,
      t: 0,
      radiusScale: clampCvRadiusScale(path[0][2]),
    };
  }
  let best = { distance: Infinity, segmentIndex: -1, t: 0, radiusScale: 1 };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    let t = len2 > 0
      ? ((point[0] - a[0]) * vx + (point[1] - a[1]) * vy) / len2
      : 0;
    t = Math.min(1, Math.max(0, t));
    const distance = Math.hypot(
      point[0] - (a[0] + vx * t),
      point[1] - (a[1] + vy * t),
    );
    if (distance < best.distance) {
      const radiusA = clampCvRadiusScale(a[2]);
      const radiusB = clampCvRadiusScale(b[2]);
      best = {
        distance,
        segmentIndex: i - 1,
        t,
        radiusScale: radiusA + (radiusB - radiusA) * t,
      };
    }
  }
  return best;
}

/** Number/order of visible copies generated for one captured stroke. */
export function strokeCopyCount(draw) {
  const symmetry = Math.max(1, Math.floor(draw?.symmetry ?? 1));
  return symmetry * (draw?.mirror === true ? 2 : 1);
}

/** Map an authoritative CV into one rendered symmetry copy. */
export function transformStrokeCopyPoint(point, draw, copyIndex = 0) {
  const transform = strokeCopyTransform(draw, copyIndex);
  let dx = point[0] - transform.cx;
  const dy = point[1] - transform.cy;
  if (transform.flip) dx = -dx;
  return [
    transform.cx + dx * transform.ca - dy * transform.sa,
    transform.cy + dx * transform.sa + dy * transform.ca,
    ...point.slice(2),
  ];
}

/** Map a pointer on a rendered symmetry copy back into authoritative CV space. */
export function inverseStrokeCopyPoint(point, draw, copyIndex = 0) {
  const transform = strokeCopyTransform(draw, copyIndex);
  const x = point[0] - transform.cx;
  const y = point[1] - transform.cy;
  let dx = x * transform.ca + y * transform.sa;
  const dy = -x * transform.sa + y * transform.ca;
  if (transform.flip) dx = -dx;
  return [transform.cx + dx, transform.cy + dy, ...point.slice(2)];
}

function strokeCopyTransform(draw, copyIndex) {
  const symmetry = Math.max(1, Math.floor(draw?.symmetry ?? 1));
  const mirror = draw?.mirror === true;
  const count = strokeCopyCount(draw);
  const index = Math.min(count - 1, Math.max(0, Math.floor(copyIndex) || 0));
  // expandPoints deliberately bypasses radialSymmetry for one unmirrored copy,
  // so phase is likewise ignored here to match the rendered path exactly.
  const bypassed = symmetry === 1 && !mirror;
  const stride = mirror ? 2 : 1;
  const rotationIndex = Math.floor(index / stride);
  const angle = bypassed ? 0 : (draw?.phase ?? 0) + (rotationIndex * Math.PI * 2) / symmetry;
  const center = draw?.center ?? [0, 0];
  return {
    cx: center[0],
    cy: center[1],
    ca: Math.cos(angle),
    sa: Math.sin(angle),
    flip: mirror && index % 2 === 1,
  };
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
    pointRadius: true,
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
  return point.slice();
}
