/**
 * Path normalization + resampling helpers.
 *
 * A "path" is a polyline: an array of 2D points. We accept several loose input
 * shapes and normalize everything to `number[][]` (array of `[x, y]` pairs),
 * and a "path set" to `number[][][]` (array of polylines).
 */

/** @typedef {[number, number]} Pt2 */
/** @typedef {Pt2[]} Polyline */

/**
 * Coerce a single path into `Pt2[]`.
 * Accepts: `[[x,y],...]`, `[{x,y},...]`, or a flat `[x0,y0,x1,y1,...]`.
 * @param {*} path
 * @returns {Polyline}
 */
export function toPolyline(path) {
  if (!path || path.length === 0) return [];

  // Flat numeric array -> pairs.
  if (typeof path[0] === 'number') {
    const out = [];
    for (let i = 0; i + 1 < path.length; i += 2) out.push([path[i], path[i + 1]]);
    return out;
  }

  // Array of {x, y}.
  if (typeof path[0] === 'object' && !Array.isArray(path[0]) && 'x' in path[0]) {
    return path.map((p) => [p.x, p.y]);
  }

  // Already array of pairs.
  return path.map((p) => [p[0], p[1]]);
}

/**
 * Coerce input into a set of polylines. A single polyline is wrapped into a set.
 * @param {*} input - one path or an array of paths
 * @returns {Polyline[]}
 */
export function toPathSet(input) {
  if (!input || input.length === 0) return [];

  // Detect "array of paths": first element is itself a non-empty path-like.
  const first = input[0];
  const looksLikePathOfPaths =
    Array.isArray(first) &&
    first.length > 0 &&
    (Array.isArray(first[0]) || (typeof first[0] === 'object' && 'x' in first[0]));

  if (looksLikePathOfPaths) return input.map(toPolyline);
  return [toPolyline(input)];
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
  if (poly.length < 2 || step <= 0) return poly.slice();

  const out = [poly[0]];
  let carry = 0; // distance accumulated since last emitted point

  for (let i = 1; i < poly.length; i++) {
    let [ax, ay] = out.length ? poly[i - 1] : poly[i - 1];
    const [bx, by] = poly[i];
    let segLen = Math.hypot(bx - ax, by - ay);
    if (segLen === 0) continue;

    let remain = segLen;
    const dirx = (bx - ax) / segLen;
    const diry = (by - ay) / segLen;

    while (carry + remain >= step) {
      const advance = step - carry;
      ax += dirx * advance;
      ay += diry * advance;
      out.push([ax, ay]);
      remain -= advance;
      carry = 0;
    }
    carry += remain;
  }

  const last = poly[poly.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > step * 0.01) out.push(last);
  return out;
}
