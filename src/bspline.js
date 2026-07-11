/**
 * Uniform B-spline evaluation from control vertices (CVs).
 *
 * Alias-style CV curves: the CVs form a hull the curve is attracted to, not a
 * set of points the curve passes through (that would be an edit-point /
 * interpolating curve). Open curves use a clamped uniform knot vector, so the
 * curve starts exactly at the first CV and ends exactly at the last; closed
 * curves use a periodic wrap and are C² everywhere with no visible seam.
 *
 * The evaluator is plain de Boor over a uniform knot vector — cheap enough to
 * re-run every pointermove while a CV is dragged. The sampled polyline feeds
 * the normal sigils pipeline (which resamples by arc length anyway), so
 * `samplesPerSpan` only needs to be dense enough to not cut corners.
 */

const DEFAULT_DEGREE = 3;
const DEFAULT_SAMPLES_PER_SPAN = 16;

/**
 * Sample a uniform B-spline defined by `cvs` into a polyline.
 *
 * @param {Array<[number, number]|[number, number, number]>} cvs - 2D or 3D control vertices (2 minimum)
 * @param {object} [opts]
 * @param {boolean} [opts.closed=false] - periodic curve through the CV loop
 * @param {number}  [opts.degree=3] - clamped to what the CV count supports
 * @param {number}  [opts.samplesPerSpan=16] - polyline density per knot span
 * @param {ArrayLike<number>} [opts.radiusScales] - optional normalized half-width per CV
 * @returns {Array<[number, number]|[number, number, number]|[number, number, number, number]>}
 *   sampled polyline ([] when cvs < 2). A radius profile is appended after
 *   the positional coordinates: `[x,y,r]` in 2D, `[x,y,z,r]` in 3D.
 */
export function bspline(cvs, opts = {}) {
  if (!cvs || cvs.length < 2) return [];

  const closed = opts.closed === true;
  const n = cvs.length;
  // An open spline of degree p needs p+1 CVs; a periodic one needs p+2 to have
  // more than one distinct span. Degrade smoothly down to a polyline (p = 1).
  const maxDegree = closed ? Math.max(1, n - 1) : Math.max(1, n - 1);
  const degree = Math.max(1, Math.min(Math.floor(opts.degree ?? DEFAULT_DEGREE), maxDegree));
  const perSpan = Math.max(2, Math.floor(opts.samplesPerSpan ?? DEFAULT_SAMPLES_PER_SPAN));

  // Flat CV coordinates (with the periodic wrap applied) plus reused de Boor
  // scratch rows: this runs on every pointermove of a CV drag, so the per-
  // sample work below must not allocate beyond the output pairs themselves.
  const pointCount = closed ? n + degree : n;
  const px = new Float64Array(pointCount);
  const py = new Float64Array(pointCount);
  const hasZ = cvs.some((point) => point?.length >= 3);
  const pz = hasZ ? new Float64Array(pointCount) : null;
  const hasRadius = opts.radiusScales != null && typeof opts.radiusScales.length === 'number';
  const pr = hasRadius ? new Float64Array(pointCount) : null;
  for (let i = 0; i < pointCount; i++) {
    const p = cvs[i % n];
    px[i] = p[0];
    py[i] = p[1];
    if (pz) {
      const z = Number(p[2]);
      pz[i] = Number.isFinite(z) ? z : 0;
    }
    if (pr) {
      const radius = Number(opts.radiusScales[i % n]);
      pr[i] = Number.isFinite(radius) ? Math.max(0, radius) : 1;
    }
  }
  const knots = closed
    ? uniformKnots(pointCount, degree)
    : clampedKnots(n, degree);

  // Valid parameter domain: [t_degree, t_(pointCount)]. For the periodic wrap
  // that interval covers exactly one full loop.
  const t0 = knots[degree];
  const t1 = knots[pointCount];
  const spans = closed ? n : n - degree;
  const steps = Math.max(1, spans * perSpan);

  const dx = new Float64Array(degree + 1);
  const dy = new Float64Array(degree + 1);
  const dz = pz ? new Float64Array(degree + 1) : null;
  const dr = pr ? new Float64Array(degree + 1) : null;
  const out = [];
  const last = closed ? steps - 1 : steps; // closed: skip duplicate seam point
  for (let s = 0; s <= last; s++) {
    const t = t0 + ((t1 - t0) * s) / steps;
    deBoor(t, degree, px, py, pz, pr, pointCount, knots, dx, dy, dz, dr);
    if (dz) {
      out.push(dr
        ? [dx[degree], dy[degree], dz[degree], Math.max(0, dr[degree])]
        : [dx[degree], dy[degree], dz[degree]]);
    } else {
      out.push(dr
        ? [dx[degree], dy[degree], Math.max(0, dr[degree])]
        : [dx[degree], dy[degree]]);
    }
  }
  return out;
}

/** Clamped uniform knot vector: curve pinned to the first and last CV. */
function clampedKnots(pointCount, degree) {
  const interior = pointCount - degree - 1;
  const knots = new Float64Array(pointCount + degree + 1);
  for (let i = 1; i <= interior; i++) knots[degree + i] = i;
  for (let i = 0; i <= degree; i++) knots[degree + interior + 1 + i] = interior + 1;
  return knots;
}

/** Plain uniform knot vector 0,1,2,… for the periodic (wrapped) case. */
function uniformKnots(pointCount, degree) {
  const knots = new Float64Array(pointCount + degree + 1);
  for (let i = 0; i < knots.length; i++) knots[i] = i;
  return knots;
}

/**
 * de Boor's algorithm at parameter `t`; the result lands in each scratch
 * row's `[degree]` entry. Optional Z/radius rows stay completely out of the
 * 2D path so its arithmetic and output remain exactly compatible.
 */
function deBoor(t, degree, px, py, pz, pr, pointCount, knots, dx, dy, dz, dr) {
  // Find the knot span k with knots[k] <= t < knots[k+1], clamped into the
  // valid domain so t at the exact end of the curve stays well-defined.
  let k = degree;
  const kMax = pointCount - 1;
  while (k < kMax && t >= knots[k + 1]) k++;

  for (let j = 0; j <= degree; j++) {
    dx[j] = px[k - degree + j];
    dy[j] = py[k - degree + j];
    if (dz) dz[j] = pz[k - degree + j];
    if (dr) dr[j] = pr[k - degree + j];
  }

  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j;
      const denom = knots[i + degree - r + 1] - knots[i];
      const alpha = denom > 0 ? (t - knots[i]) / denom : 0;
      dx[j] = (1 - alpha) * dx[j - 1] + alpha * dx[j];
      dy[j] = (1 - alpha) * dy[j - 1] + alpha * dy[j];
      if (dz) dz[j] = (1 - alpha) * dz[j - 1] + alpha * dz[j];
      if (dr) dr[j] = (1 - alpha) * dr[j - 1] + alpha * dr[j];
    }
  }
}
