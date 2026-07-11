/**
 * Path normalization + resampling helpers.
 *
 * A "path" is a polyline: an array of 2D points. We accept several loose input
 * shapes and normalize everything to `number[][]` (array of `[x, y]` pairs),
 * and a "path set" to `number[][][]` (array of polylines). Callers that opt
 * into point radii keep a third `[x, y, radiusScale]` channel.
 */

/** @typedef {[number, number]} Pt2 */
/** @typedef {Pt2[]} Polyline */

/**
 * Coerce a single path into `Pt2[]`.
 * Accepts: `[[x,y],...]`, `[{x,y},...]`, or a flat `[x0,y0,x1,y1,...]`.
 * @param {*} path
 * @param {{pointRadius?: boolean, preserveTrailing?: boolean}} [opts]
 * @returns {Polyline}
 */
export function toPolyline(path, opts = {}) {
  if (!path || path.length === 0) return [];
  const pointRadius = opts.pointRadius === true;
  const preserveTrailing = opts.preserveTrailing === true;

  // Flat numeric array -> pairs.
  if (typeof path[0] === 'number') {
    const out = [];
    for (let i = 0; i + 1 < path.length; i += 2) {
      out.push(pointRadius ? [path[i], path[i + 1], 1] : [path[i], path[i + 1]]);
    }
    return out;
  }

  // Array of {x, y}.
  if (typeof path[0] === 'object' && !Array.isArray(path[0]) && 'x' in path[0]) {
    return path.map((p) => {
      if (pointRadius) return [p.x, p.y, radiusScale(p.radiusScale ?? p.radius)];
      if (preserveTrailing && Number.isFinite(p.z)) return [p.x, p.y, p.z];
      return [p.x, p.y];
    });
  }

  // Already array of pairs.
  return path.map((p) => {
    if (pointRadius) return [p[0], p[1], radiusScale(p[2])];
    if (preserveTrailing) return p.slice();
    return [p[0], p[1]];
  });
}

/**
 * Coerce input into a set of polylines. A single polyline is wrapped into a set.
 * @param {*} input - one path or an array of paths
 * @param {{pointRadius?: boolean, preserveTrailing?: boolean}} [opts]
 * @returns {Polyline[]}
 */
export function toPathSet(input, opts = {}) {
  if (!input || input.length === 0) return [];

  // Detect "array of paths": first element is itself a non-empty path-like.
  const first = input[0];
  const looksLikePathOfPaths =
    Array.isArray(first) &&
    first.length > 0 &&
    (Array.isArray(first[0]) || (typeof first[0] === 'object' && 'x' in first[0]));

  if (looksLikePathOfPaths) return input.map((path) => toPolyline(path, opts));
  return [toPolyline(input, opts)];
}

/** Axis-aligned bounds over a path set. */
export function boundsOf(pathSet) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of pathSet) {
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Area-weighted centroid (here: simple average of vertices). */
export function centroidOf(pathSet) {
  let sx = 0, sy = 0, n = 0;
  for (const poly of pathSet) {
    for (const [x, y] of poly) {
      sx += x;
      sy += y;
      n++;
    }
  }
  return n ? [sx / n, sy / n] : [0, 0];
}

/**
 * Resample a polyline to roughly uniform segment length (arc-length walk).
 * Keeps endpoints. Returns a new polyline.
 * @param {Polyline} poly
 * @param {number} step - target spacing in world units
 * @returns {Polyline}
 */
export function resampleByLength(poly, step) {
  if (poly.length < 2 || step <= 0) return poly.map(clonePoint);

  const out = [clonePoint(poly[0])];
  let carry = 0; // distance accumulated since last emitted point

  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    let [ax, ay] = a;
    const [bx, by] = b;
    let segLen = Math.hypot(bx - ax, by - ay);
    if (segLen === 0) continue;

    const fullLen = segLen;
    let traveled = 0;
    let remain = segLen;
    const dirx = (bx - ax) / segLen;
    const diry = (by - ay) / segLen;

    while (carry + remain >= step) {
      const advance = step - carry;
      ax += dirx * advance;
      ay += diry * advance;
      traveled += advance;
      out.push(interpolatePoint(a, b, traveled / fullLen, ax, ay));
      remain -= advance;
      carry = 0;
    }
    carry += remain;
  }

  const last = poly[poly.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > step * 0.01) out.push(clonePoint(last));
  return out;
}

function interpolatePoint(a, b, t, x, y) {
  const dimensions = Math.max(a.length ?? 2, b.length ?? 2);
  if (dimensions <= 2) return [x, y];
  const point = [x, y];
  for (let d = 2; d < dimensions; d++) {
    const av = Number(a[d]);
    const bv = Number(b[d]);
    if (Number.isFinite(av) && Number.isFinite(bv)) point[d] = av + (bv - av) * t;
    else if (Number.isFinite(av)) point[d] = av;
    else if (Number.isFinite(bv)) point[d] = bv;
  }
  return point;
}

function clonePoint(point) {
  return Array.isArray(point) ? point.slice() : [point[0], point[1]];
}

function radiusScale(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 1;
}
