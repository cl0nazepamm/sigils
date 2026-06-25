/**
 * Drop stroke vertices that fail a proximity gate.
 *
 * Matches the curve-native cull pass used before curve-to-mesh in stacked
 * shape pipelines: keep points whose distance to a reference target stays
 * above a cutoff.
 */

import { toPathSet } from './internal/paths.js';

/**
 * @param {*} paths
 * @param {[number, number]|number[][]} reference - point or polyline target
 * @param {number} minDistance - keep points with distance > minDistance
 * @returns {number[][][]}
 */
export function cullStrokePoints(paths, reference, minDistance) {
  const set = toPathSet(paths);
  const refPoly = Array.isArray(reference[0]) ? reference : null;
  const refPoint = refPoly ? null : reference;

  const out = [];
  for (const poly of set) {
    const kept = [];
    for (const pt of poly) {
      const d = refPoly ? distToPolyline(pt, refPoly) : distToPoint(pt, refPoint);
      if (d > minDistance) kept.push(pt);
    }
    if (kept.length >= 2) out.push(kept);
  }
  return out;
}

function distToPoint([px, py], [rx, ry]) {
  return Math.hypot(px - rx, py - ry);
}

function distToPolyline([px, py], poly) {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const d = distToSegment(px, py, poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1]);
    if (d < best) best = d;
  }
  return best;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}
