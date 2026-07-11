import { clampCvRadiusScale } from './strokeSession.js';

const DEFAULT_SEED = 13;
const DEFAULT_NORMAL = [0, 0, 1];
const DEFAULT_DEGREE = 3;
const DEFAULT_SAMPLES_PER_SPAN = 16;

function finiteTuple3(value) {
  return Array.isArray(value)
    && value.length === 3
    && value.every(Number.isFinite)
    ? value.slice()
    : null;
}

function normalized3(value, fallback = DEFAULT_NORMAL) {
  const tuple = finiteTuple3(value);
  if (!tuple) return null;
  const length = Math.hypot(tuple[0], tuple[1], tuple[2]);
  if (length <= 1e-12) return fallback.slice();
  tuple[0] /= length;
  tuple[1] /= length;
  tuple[2] /= length;
  return tuple;
}

function cleanRadius(value, fallback = null) {
  if (value == null) return fallback;
  if (!Number.isFinite(value) || value <= 0) return null;
  return clampCvRadiusScale(value);
}

/** Sanitize one target-local surface sample without retaining extra fields. */
export function cleanSurfaceSample(value, { requireRadius = false } = {}) {
  const p = finiteTuple3(value?.p);
  const n = normalized3(value?.n);
  if (!p || !n) return null;
  const radiusScale = cleanRadius(value?.radiusScale, requireRadius ? null : undefined);
  if (requireRadius && radiusScale == null) return null;
  if (value?.radiusScale != null && radiusScale == null) return null;
  return radiusScale == null ? { p, n } : { p, n, radiusScale };
}

function cleanFreehandSamples(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const samples = [];
  for (const item of value) {
    const sample = cleanSurfaceSample(item);
    if (!sample) return null;
    samples.push({ ...sample, radiusScale: sample.radiusScale ?? 1 });
  }
  return samples;
}

function cleanSplineCvs(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const cvs = [];
  for (const item of value) {
    const sample = cleanSurfaceSample(item);
    if (!sample) return null;
    cvs.push({ p: sample.p, n: sample.n });
  }
  return cvs;
}

function cleanSplineRadii(cvs, value) {
  if (!Array.isArray(value) || value.length !== cvs.length) return null;
  const radii = [];
  for (const radius of value) {
    const clean = cleanRadius(radius);
    if (clean == null) return null;
    radii.push(clean);
  }
  return radii;
}

function copyIdentity(target, value, fallbackSeed, fallbackId) {
  const safeFallbackSeed = Number.isFinite(fallbackSeed) ? fallbackSeed : DEFAULT_SEED;
  target.seed = Number.isFinite(value?.seed) ? value.seed : safeFallbackSeed;
  const id = Number.isFinite(value?.id)
    ? Math.max(0, Math.floor(value.id))
    : Number.isFinite(fallbackId)
      ? Math.max(0, Math.floor(fallbackId))
      : null;
  if (id != null) target.id = id;
  return target;
}

/** Capture per-stroke symmetry the same way planar Drawing freezes draw settings. */
export function captureSurfaceDrawSettings(settings = {}, center = [0, 0, 0]) {
  const fromCenter = finiteTuple3(center)
    ?? finiteTuple3(settings.center)
    ?? (
      Number.isFinite(settings.centerX)
        ? [settings.centerX, 0, 0]
        : [0, 0, 0]
    );
  return {
    symmetry: Math.max(1, Math.min(12, Math.floor(Number(settings.symmetry) || 1))),
    mirror: settings.mirror === true,
    phase: Number.isFinite(settings.phase) ? settings.phase : 0,
    center: fromCenter.slice(),
  };
}

function cleanDraw(value) {
  if (!value || typeof value !== 'object') return null;
  return captureSurfaceDrawSettings(value, value.center);
}

/**
 * Canonicalize a persisted surface record. Derived path/build caches are
 * deliberately omitted; splines retain only their CV authority.
 */
export function cleanSurfaceStrokeRecord(value, fallbackSeed = DEFAULT_SEED, fallbackId = null) {
  if (!value || typeof value !== 'object') return null;
  const draw = cleanDraw(value.draw);
  if (value.kind === 'spline') {
    const cvs = cleanSplineCvs(value.cvs);
    if (!cvs) return null;
    const cvRadiusScales = cleanSplineRadii(cvs, value.cvRadiusScales);
    if (!cvRadiusScales) return null;
    const record = copyIdentity({
      kind: 'spline',
      cvs,
      cvRadiusScales,
      closed: value.closed === true,
    }, value, fallbackSeed, fallbackId);
    if (draw) record.draw = draw;
    return record;
  }

  // Records saved before surface tools existed had no explicit kind.
  if (value.kind != null && value.kind !== 'freehand') return null;
  const raw = cleanFreehandSamples(value.raw);
  if (!raw) return null;
  const record = copyIdentity({ kind: 'freehand', raw }, value, fallbackSeed, fallbackId);
  if (draw) record.draw = draw;
  return record;
}

export function cleanSurfaceStrokeRecords(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((record, index) => cleanSurfaceStrokeRecord(record, index * 7919 + DEFAULT_SEED))
    .filter(Boolean);
}

function recordWithCaches(record) {
  return { ...record, conformed: null, conformedM: null };
}

/** Create a deep-cloned, pressure-ready freehand record. */
export function makeSurfaceFreehandRecord(raw, { seed = DEFAULT_SEED, id = null, draw = null } = {}) {
  const record = cleanSurfaceStrokeRecord({ kind: 'freehand', raw, seed, id, draw }, seed, id);
  if (!record) throw new TypeError('surface stroke: freehand samples must contain finite p/n tuples.');
  return recordWithCaches(record);
}

/** Create an authoritative editable surface B-spline record. */
export function makeSurfaceSplineRecord(
  cvs,
  closed,
  cvRadiusScales,
  { seed = DEFAULT_SEED, id = null, draw = null } = {},
) {
  const record = cleanSurfaceStrokeRecord({
    kind: 'spline', cvs, closed, cvRadiusScales, seed, id, draw,
  }, seed, id);
  if (!record) {
    throw new TypeError('surface stroke: spline CVs and positive radius scales must be index-aligned.');
  }
  return recordWithCaches(record);
}

export function isSurfaceSplineRecord(record) {
  return !!record && record.kind === 'spline';
}

/** Replace spline authority after an edit and invalidate every derived cache. */
export function updateSurfaceSplineRecord(
  record,
  cvs = record?.cvs,
  closed = record?.closed,
  cvRadiusScales = record?.cvRadiusScales,
) {
  if (!isSurfaceSplineRecord(record)) {
    throw new TypeError('surface stroke: update target must be a spline record.');
  }
  const clean = cleanSurfaceStrokeRecord({
    kind: 'spline',
    id: record.id,
    seed: record.seed,
    draw: record.draw,
    cvs,
    closed,
    cvRadiusScales,
  }, record.seed, record.id);
  if (!clean) {
    throw new TypeError('surface stroke: spline CVs and positive radius scales must be index-aligned.');
  }
  record.cvs = clean.cvs;
  record.cvRadiusScales = clean.cvRadiusScales;
  record.closed = clean.closed;
  record.conformed = null;
  record.conformedM = null;
  return record;
}

/**
 * Sample target-local 3D CVs with a uniform B-spline basis. Normals and the
 * radius channel use the exact same weights. `project` may replace each
 * sample with a closest-point result (`{p,n}` or `{point,normal}`).
 */
export function sampleSurfaceSpline(cvs, opts = {}) {
  const cleanCvs = cleanSplineCvs(cvs);
  if (!cleanCvs) return [];
  const n = cleanCvs.length;
  const radii = opts.radiusScales == null
    ? Array(n).fill(1)
    : cleanSplineRadii(cleanCvs, Array.from(opts.radiusScales));
  if (!radii) {
    throw new TypeError('surface spline: radius scales must be positive and index-aligned with CVs.');
  }

  const closed = opts.closed === true;
  const requestedDegree = Number.isFinite(opts.degree) ? opts.degree : DEFAULT_DEGREE;
  const degree = Math.max(1, Math.min(
    Math.floor(requestedDegree),
    n - 1,
  ));
  const requestedDensity = Number.isFinite(opts.samplesPerSpan)
    ? opts.samplesPerSpan
    : DEFAULT_SAMPLES_PER_SPAN;
  const perSpan = Math.max(2, Math.floor(requestedDensity));
  const pointCount = closed ? n + degree : n;
  const channels = Array.from({ length: 7 }, () => new Float64Array(pointCount));
  for (let i = 0; i < pointCount; i++) {
    const cv = cleanCvs[i % n];
    channels[0][i] = cv.p[0];
    channels[1][i] = cv.p[1];
    channels[2][i] = cv.p[2];
    channels[3][i] = cv.n[0];
    channels[4][i] = cv.n[1];
    channels[5][i] = cv.n[2];
    channels[6][i] = radii[i % n];
  }

  const knots = closed
    ? uniformKnots(pointCount, degree)
    : clampedKnots(n, degree);
  const t0 = knots[degree];
  const t1 = knots[pointCount];
  const spans = closed ? n : n - degree;
  const steps = Math.max(1, spans * perSpan);
  const scratch = channels.map(() => new Float64Array(degree + 1));
  const out = [];
  const last = closed ? steps - 1 : steps;

  for (let sampleIndex = 0; sampleIndex <= last; sampleIndex++) {
    const t = t0 + ((t1 - t0) * sampleIndex) / steps;
    deBoorChannels(t, degree, channels, pointCount, knots, scratch);
    const p = [scratch[0][degree], scratch[1][degree], scratch[2][degree]];
    const nrm = normalized3([
      scratch[3][degree], scratch[4][degree], scratch[5][degree],
    ]) ?? DEFAULT_NORMAL.slice();
    const radiusScale = clampCvRadiusScale(scratch[6][degree]);

    let projectedP = p;
    let projectedN = nrm;
    if (typeof opts.project === 'function') {
      const projected = opts.project(p.slice(), {
        normal: nrm.slice(), radiusScale, sampleIndex, t, closed,
      });
      if (projected != null) {
        const nextP = finiteTuple3(projected.p ?? projected.point);
        const nextN = normalized3(projected.n ?? projected.normal);
        if (!nextP || !nextN) {
          throw new TypeError('surface spline: project() must return finite p/n tuples.');
        }
        projectedP = nextP;
        projectedN = nextN;
      }
    }
    out.push({ p: projectedP, n: projectedN, radiusScale });
  }

  // Surface builders detect closure from endpoint proximity, so make the seam
  // explicit while keeping the periodic evaluator's unique sample sequence.
  if (closed && out.length > 0) out.push(cloneSample(out[0], true));
  return out;
}

function clampedKnots(pointCount, degree) {
  const interior = pointCount - degree - 1;
  const knots = new Float64Array(pointCount + degree + 1);
  for (let i = 1; i <= interior; i++) knots[degree + i] = i;
  for (let i = 0; i <= degree; i++) knots[degree + interior + 1 + i] = interior + 1;
  return knots;
}

function uniformKnots(pointCount, degree) {
  const knots = new Float64Array(pointCount + degree + 1);
  for (let i = 0; i < knots.length; i++) knots[i] = i;
  return knots;
}

function deBoorChannels(t, degree, channels, pointCount, knots, scratch) {
  let k = degree;
  const kMax = pointCount - 1;
  while (k < kMax && t >= knots[k + 1]) k++;

  for (let channel = 0; channel < channels.length; channel++) {
    for (let j = 0; j <= degree; j++) {
      scratch[channel][j] = channels[channel][k - degree + j];
    }
  }
  for (let row = 1; row <= degree; row++) {
    for (let j = degree; j >= row; j--) {
      const i = k - degree + j;
      const denominator = knots[i + degree - row + 1] - knots[i];
      const alpha = denominator > 0 ? (t - knots[i]) / denominator : 0;
      for (let channel = 0; channel < channels.length; channel++) {
        const values = scratch[channel];
        values[j] = (1 - alpha) * values[j - 1] + alpha * values[j];
      }
    }
  }
}

function pointTuple(value) {
  return finiteTuple3(value?.p ?? value);
}

function sampleNormal(value) {
  return normalized3(value?.n ?? value?.normal);
}

function cloneSample(value, includeRadius = value?.radiusScale != null) {
  const sample = { p: value.p.slice(), n: value.n.slice() };
  if (includeRadius) sample.radiusScale = clampCvRadiusScale(value.radiusScale);
  return sample;
}

/**
 * CV splice index from arc-length along a conformed surface path hit.
 * Tracks the painted curve instead of the control hull (which can sit far
 * off the stroke after re-conforming / flow).
 */
export function cvInsertIndexFromSurfacePathHit(cvCount, closed, path, hit) {
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
    const a = cleanSurfaceSample(path[i - 1]);
    const b = cleanSurfaceSample(path[i]);
    if (!a || !b) continue;
    const len = distance3(a.p, b.p);
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

/**
 * CV splice index from the closest control-hull segment to a surface point.
 * Used when the displayed path has been re-conformed and no longer maps 1:1
 * to uniform B-spline spans.
 */
export function cvInsertIndexNearSurfacePoint(cvs, closed, point) {
  const cleanCvs = cleanSplineCvs(cvs);
  const query = pointTuple(point) ?? pointTuple({ p: point });
  if (!cleanCvs || cleanCvs.length < 2 || !query) return 1;
  const n = cleanCvs.length;
  const segs = closed ? n : n - 1;
  let bestDist = Infinity;
  let bestIndex = 1;
  for (let i = 0; i < segs; i++) {
    const a = cleanCvs[i].p;
    const b = cleanCvs[(i + 1) % n].p;
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const vz = b[2] - a[2];
    const len2 = vx * vx + vy * vy + vz * vz;
    let t = len2 > 0
      ? ((query[0] - a[0]) * vx + (query[1] - a[1]) * vy + (query[2] - a[2]) * vz) / len2
      : 0;
    t = Math.min(1, Math.max(0, t));
    const dist = Math.hypot(
      query[0] - (a[0] + vx * t),
      query[1] - (a[1] + vy * t),
      query[2] - (a[2] + vz * t),
    );
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = i + 1;
    }
  }
  return bestIndex;
}

/** Nearest point on a 3D surface polyline, including interpolated normal/radius. */
export function closestPointOnSurfacePolyline(point, path) {
  const query = pointTuple(point);
  if (!query || !Array.isArray(path) || path.length === 0) {
    return {
      distance: Infinity,
      segmentIndex: -1,
      t: 0,
      p: null,
      n: null,
      radiusScale: 1,
    };
  }

  if (path.length === 1) {
    const only = cleanSurfaceSample(path[0]);
    if (!only) return closestPointOnSurfacePolyline(point, []);
    return {
      distance: distance3(query, only.p),
      segmentIndex: 0,
      t: 0,
      p: only.p,
      n: only.n,
      radiusScale: only.radiusScale ?? 1,
    };
  }

  let best = {
    distance: Infinity,
    segmentIndex: -1,
    t: 0,
    p: null,
    n: null,
    radiusScale: 1,
  };
  for (let i = 1; i < path.length; i++) {
    const a = cleanSurfaceSample(path[i - 1]);
    const b = cleanSurfaceSample(path[i]);
    if (!a || !b) continue;
    const vx = b.p[0] - a.p[0];
    const vy = b.p[1] - a.p[1];
    const vz = b.p[2] - a.p[2];
    const len2 = vx * vx + vy * vy + vz * vz;
    let t = len2 > 0
      ? ((query[0] - a.p[0]) * vx
        + (query[1] - a.p[1]) * vy
        + (query[2] - a.p[2]) * vz) / len2
      : 0;
    t = Math.min(1, Math.max(0, t));
    const p = [a.p[0] + vx * t, a.p[1] + vy * t, a.p[2] + vz * t];
    const distance = distance3(query, p);
    if (distance >= best.distance) continue;
    const n = normalized3([
      a.n[0] + (b.n[0] - a.n[0]) * t,
      a.n[1] + (b.n[1] - a.n[1]) * t,
      a.n[2] + (b.n[2] - a.n[2]) * t,
    ]) ?? a.n.slice();
    const radiusA = a.radiusScale ?? 1;
    const radiusB = b.radiusScale ?? 1;
    best = {
      distance,
      segmentIndex: i - 1,
      t,
      p,
      n,
      radiusScale: radiusA + (radiusB - radiusA) * t,
    };
  }
  return best;
}

function distance3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function normalDot(a, b) {
  const na = sampleNormal(a);
  const nb = sampleNormal(b);
  if (!na || !nb) return 1;
  return na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
}

/** Pick a surface CV center or its physical target-local radius ring. */
export function pickSurfaceCvControl(hit, candidates, opts = {}) {
  const p = pointTuple(hit);
  if (!p || !Array.isArray(candidates) || candidates.length === 0) return null;
  const baseRadius = Math.max(0, Number(opts.baseRadius) || 0);
  const handleRadius = Math.max(0, Number(opts.handleRadius) || 0);
  const centerTolerance = Math.max(handleRadius, Number(opts.centerTolerance) || 0);
  const ringTolerance = Math.max(0, Number(opts.ringTolerance) || 0);
  const requestedRingRatio = Number(opts.ringInnerRatio ?? 0.9);
  const ringInnerRatio = Number.isFinite(requestedRingRatio)
    ? Math.min(1, Math.max(0, requestedRingRatio))
    : 0.9;
  const normalDotMin = Number.isFinite(opts.normalDotMin) ? opts.normalDotMin : 0;
  let handleHit = null;
  let ringHit = null;
  let centerHit = null;
  let handleDistance = Infinity;
  let ringResidual = Infinity;
  let centerDistance = Infinity;

  for (const candidate of candidates) {
    const cv = cleanSurfaceSample(candidate?.cv);
    if (!cv || normalDot(hit, cv) < normalDotMin) continue;
    const distance = distance3(p, cv.p);
    if (distance <= handleRadius && distance < handleDistance) {
      handleHit = candidate;
      handleDistance = distance;
    }

    const outerRadius = baseRadius * clampCvRadiusScale(candidate.radiusScale);
    const innerRadius = outerRadius * ringInnerRatio;
    const residual = distance < innerRadius
      ? innerRadius - distance
      : distance > outerRadius
        ? distance - outerRadius
        : 0;
    if (residual <= ringTolerance && residual < ringResidual) {
      ringHit = candidate;
      ringResidual = residual;
    }

    if (distance <= centerTolerance && distance < centerDistance) {
      centerHit = candidate;
      centerDistance = distance;
    }
  }

  if (handleHit) return { ...handleHit, kind: 'move', distance: handleDistance };
  if (ringHit) return { ...ringHit, kind: 'radius', ringResidual };
  if (centerHit) return { ...centerHit, kind: 'move', distance: centerDistance };
  return null;
}

/** Pick a rendered surface stroke from a visible target hit. */
export function pickSurfaceStroke(hit, candidates, opts = {}) {
  if (!pointTuple(hit) || !Array.isArray(candidates)) return null;
  const baseRadius = Math.max(0, Number(opts.baseRadius) || 0);
  const padding = Math.max(0, Number(opts.padding) || 0);
  const normalDotMin = Number.isFinite(opts.normalDotMin) ? opts.normalDotMin : 0;
  let best = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const closest = closestPointOnSurfacePolyline(hit, candidate?.path);
    if (!Number.isFinite(closest.distance) || normalDot(hit, { n: closest.n }) < normalDotMin) continue;
    const localRadius = baseRadius * clampCvRadiusScale(closest.radiusScale);
    const reach = localRadius + padding;
    if (closest.distance > reach) continue;
    const score = closest.distance / Math.max(localRadius, padding, 1e-9);
    if (score < bestScore) {
      bestScore = score;
      best = { ...candidate, closest, reach, score };
    }
  }
  return best;
}

export function surfaceStrokeCopyCount(settings) {
  const symmetry = Math.max(1, Math.floor(settings?.symmetry ?? 1));
  return symmetry * (settings?.mirror === true ? 2 : 1);
}

function surfaceCopyTransform(draw, copyIndex = 0) {
  const symmetry = Math.max(1, Math.floor(draw?.symmetry ?? 1));
  const mirror = draw?.mirror === true;
  const count = surfaceStrokeCopyCount(draw);
  const index = Math.min(count - 1, Math.max(0, Math.floor(copyIndex) || 0));
  const bypassed = symmetry === 1 && !mirror;
  const stride = mirror ? 2 : 1;
  const rotationIndex = Math.floor(index / stride);
  const angle = bypassed ? 0 : (draw?.phase ?? 0) + (rotationIndex * Math.PI * 2) / symmetry;
  const center = finiteTuple3(draw?.center)
    ?? (Number.isFinite(draw?.centerX) ? [draw.centerX, 0, 0] : [0, 0, 0]);
  return {
    cx: center[0],
    cy: center[1],
    cz: center[2],
    ca: Math.cos(angle),
    sa: Math.sin(angle),
    flip: mirror && index % 2 === 1,
    identity: bypassed,
  };
}

/** Map an authoritative sample into the requested symmetry/mirror display copy. */
export function transformSurfaceCopySample(sample, settings = {}, copyIndex = 0) {
  const clean = cleanSurfaceSample(sample);
  if (!clean) throw new TypeError('surface stroke: copy transform requires a finite surface sample.');
  const transform = surfaceCopyTransform(settings, copyIndex);
  if (transform.identity) return cloneSample(clean);

  let dx = clean.p[0] - transform.cx;
  let dy = clean.p[1] - transform.cy;
  const dz = clean.p[2] - transform.cz;
  let nx = clean.n[0];
  let ny = clean.n[1];
  const nz = clean.n[2];
  if (transform.flip) {
    dx = -dx;
    nx = -nx;
  }
  const x = dx * transform.ca - dy * transform.sa;
  const y = dx * transform.sa + dy * transform.ca;
  const rnx = nx * transform.ca - ny * transform.sa;
  const rny = nx * transform.sa + ny * transform.ca;
  return {
    p: [transform.cx + x, transform.cy + y, transform.cz + dz],
    n: normalized3([rnx, rny, nz]) ?? [rnx, rny, nz],
    ...(clean.radiusScale == null ? {} : { radiusScale: clean.radiusScale }),
  };
}

/** Map a displayed symmetry/mirror copy hit back into authoritative sample space. */
export function inverseSurfaceCopySample(sample, settings = {}, copyIndex = 0) {
  const clean = cleanSurfaceSample(sample);
  if (!clean) throw new TypeError('surface stroke: copy inverse requires a finite surface sample.');
  const transform = surfaceCopyTransform(settings, copyIndex);
  if (transform.identity) return cloneSample(clean);

  let dx = clean.p[0] - transform.cx;
  let dy = clean.p[1] - transform.cy;
  const dz = clean.p[2] - transform.cz;
  let nx = clean.n[0];
  let ny = clean.n[1];
  const nz = clean.n[2];
  // Inverse rotate around Z, then un-flip across the local YZ plane.
  const x = dx * transform.ca + dy * transform.sa;
  const y = -dx * transform.sa + dy * transform.ca;
  const rnx = nx * transform.ca + ny * transform.sa;
  const rny = -nx * transform.sa + ny * transform.ca;
  if (transform.flip) {
    dx = -x;
    nx = -rnx;
    ny = rny;
  } else {
    dx = x;
    nx = rnx;
    ny = rny;
  }
  return {
    p: [transform.cx + dx, transform.cy + y, transform.cz + dz],
    n: normalized3([nx, ny, nz]) ?? [nx, ny, nz],
    ...(clean.radiusScale == null ? {} : { radiusScale: clean.radiusScale }),
  };
}

/** Deep-clone only the fields a user edit may change. */
export function cloneSurfaceStrokeEdit(record) {
  const clean = cleanSurfaceStrokeRecord(record, record?.seed ?? DEFAULT_SEED, record?.id);
  if (!clean) throw new TypeError('surface stroke: cannot snapshot a malformed record.');
  if (clean.kind === 'spline') {
    return {
      kind: 'spline',
      cvs: clean.cvs,
      cvRadiusScales: clean.cvRadiusScales,
      closed: clean.closed,
    };
  }
  return { kind: 'freehand', raw: clean.raw };
}

/** Restore an edit snapshot without changing record identity or its seed. */
export function restoreSurfaceStrokeEdit(record, snapshot) {
  if (snapshot?.kind === 'spline') {
    return updateSurfaceSplineRecord(
      record,
      snapshot.cvs,
      snapshot.closed,
      snapshot.cvRadiusScales,
    );
  }
  if (snapshot?.kind !== 'freehand' || record?.kind !== 'freehand') {
    throw new TypeError('surface stroke: snapshot kind does not match its record.');
  }
  const raw = cleanFreehandSamples(snapshot.raw);
  if (!raw) throw new TypeError('surface stroke: cannot restore malformed freehand samples.');
  record.raw = raw;
  record.conformed = null;
  record.conformedM = null;
  return record;
}
