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
 * @param {Array<[number, number]>} cvs - control vertices (2 minimum)
 * @param {object} [opts]
 * @param {boolean} [opts.closed=false] - periodic curve through the CV loop
 * @param {number}  [opts.degree=3] - clamped to what the CV count supports
 * @param {number}  [opts.samplesPerSpan=16] - polyline density per knot span
 * @returns {Array<[number, number]>} sampled polyline ([] when cvs < 2)
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

  const points = closed ? [...cvs, ...cvs.slice(0, degree)] : cvs;
  const knots = closed
    ? uniformKnots(points.length, degree)
    : clampedKnots(n, degree);

  // Valid parameter domain: [t_degree, t_(pointCount)]. For the periodic wrap
  // that interval covers exactly one full loop.
  const t0 = knots[degree];
  const t1 = knots[points.length];
  const spans = closed ? n : n - degree;
  const steps = Math.max(1, spans * perSpan);

  const out = [];
  const last = closed ? steps - 1 : steps; // closed: skip duplicate seam point
  for (let s = 0; s <= last; s++) {
    const t = t0 + ((t1 - t0) * s) / steps;
    out.push(deBoor(t, degree, points, knots));
  }
  return out;
}

/** Clamped uniform knot vector: curve pinned to the first and last CV. */
function clampedKnots(pointCount, degree) {
  const knots = [];
  const interior = pointCount - degree - 1;
  for (let i = 0; i <= degree; i++) knots.push(0);
  for (let i = 1; i <= interior; i++) knots.push(i);
  for (let i = 0; i <= degree; i++) knots.push(interior + 1);
  return knots;
}

/** Plain uniform knot vector 0,1,2,… for the periodic (wrapped) case. */
function uniformKnots(pointCount, degree) {
  const knots = [];
  for (let i = 0; i <= pointCount + degree; i++) knots.push(i);
  return knots;
}

/**
 * de Boor's algorithm at parameter `t`.
 * @returns {[number, number]}
 */
function deBoor(t, degree, points, knots) {
  // Find the knot span k with knots[k] <= t < knots[k+1], clamped into the
  // valid domain so t at the exact end of the curve stays well-defined.
  let k = degree;
  const kMax = points.length - 1;
  while (k < kMax && t >= knots[k + 1]) k++;

  const d = [];
  for (let j = 0; j <= degree; j++) {
    const p = points[k - degree + j];
    d.push([p[0], p[1]]);
  }

  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j;
      const denom = knots[i + degree - r + 1] - knots[i];
      const alpha = denom > 0 ? (t - knots[i]) / denom : 0;
      d[j][0] = (1 - alpha) * d[j - 1][0] + alpha * d[j][0];
      d[j][1] = (1 - alpha) * d[j - 1][1] + alpha * d[j][1];
    }
  }

  return d[degree];
}
