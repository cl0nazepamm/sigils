/**
 * Radial symmetry generator.
 *
 * Given a set of strokes, produce N rotated copies around a center point so the
 * result has N-fold rotational symmetry.
 */

import { toPathSet, centroidOf } from './internal/paths.js';

/**
 * @param {*} paths - one path or an array of paths (see toPathSet)
 * @param {object} [opts]
 * @param {number} [opts.symmetry=3]   - number of rotated copies (>=1)
 * @param {[number,number]} [opts.center] - rotation pivot; defaults to centroid
 * @param {number} [opts.phase=0]       - extra rotation applied to every copy (radians)
 * @param {boolean} [opts.mirror=false] - also add a mirrored set (dihedral symmetry)
 * @returns {number[][][]} new path set
 */
export function radialSymmetry(paths, opts = {}) {
  const { symmetry = 3, phase = 0, mirror = false } = opts;
  // Preserve optional payload channels (currently point radius) while only
  // transforming XY. Plain paths remain ordinary `[x, y]` pairs.
  const set = toPathSet(paths, { preserveTrailing: true });
  const [cx, cy] = opts.center ?? centroidOf(set);

  const n = Math.max(1, Math.floor(symmetry));
  const out = [];

  for (let k = 0; k < n; k++) {
    const a = phase + (k * Math.PI * 2) / n;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (const poly of set) {
      out.push(rotatePoly(poly, cx, cy, ca, sa, false));
      if (mirror) out.push(rotatePoly(poly, cx, cy, ca, sa, true));
    }
  }
  return out;
}

function rotatePoly(poly, cx, cy, ca, sa, flip) {
  const res = new Array(poly.length);
  for (let i = 0; i < poly.length; i++) {
    let dx = poly[i][0] - cx;
    let dy = poly[i][1] - cy;
    if (flip) dx = -dx; // reflect across the Y axis before rotating
    res[i] = [cx + dx * ca - dy * sa, cy + dx * sa + dy * ca, ...poly[i].slice(2)];
  }
  return res;
}
