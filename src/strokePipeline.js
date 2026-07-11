/**
 * Stroke preparation helpers for distance-field rasterization:
 * flatten → resample → optional reference cull → symmetry.
 */

import { toPathSet, resampleByLength, boundsOf } from './internal/paths.js';
import { radialSymmetry } from './symmetry.js';

/**
 * Drop points whose distance to a reference position fails the keep test.
 * Points with distance ≤ `minDistance` are removed.
 *
 * @param {import('./internal/paths.js').Polyline[]} set
 * @param {[number, number]} reference
 * @param {number} minDistance
 * @returns {import('./internal/paths.js').Polyline[]}
 */
export function cullPointsByReference(set, reference, minDistance) {
  if (!reference || !Number.isFinite(minDistance)) return set;
  const [rx, ry] = reference;
  const out = [];
  for (const poly of set) {
    if (poly.length < 2) continue;
    const kept = [];
    for (const point of poly) {
      const [x, y] = point;
      const d = Math.hypot(x - rx, y - ry);
      if (d > minDistance) kept.push(point.slice());
    }
    if (kept.length >= 2) out.push(kept);
  }
  return out.length ? out : set;
}

/**
 * Squash Z onto the XY plane when 3D points are supplied as `[x,y,z]`.
 *
 * @param {import('./internal/paths.js').Polyline[]} set
 * @param {{pointRadius?: boolean}} [opts]
 * @returns {import('./internal/paths.js').Polyline[]}
 */
export function flattenPaths(set, opts = {}) {
  const pointRadius = opts.pointRadius === true;
  return set.map((poly) =>
    poly.map((p) => pointRadius
      ? [p[0], p[1], radiusScale(p[2])]
      : [p[0], p[1]]),
  );
}

/**
 * Map normalized iso + range inputs to world-unit marching threshold.
 *
 * @param {object} opts
 * @param {number} fallbackSize - bounds span for default thickness
 * @returns {number}
 */
export function resolveFieldThreshold(opts, fallbackSize) {
  if (opts.isoThreshold != null && opts.fieldRangeMax != null) {
    return opts.isoThreshold * opts.fieldRangeMax;
  }
  const thickness = opts.thickness ?? fallbackSize * 0.06;
  return thickness * 0.5;
}

/**
 * Boundary-distance falloff in world units (height reaches 1 at this rim distance).
 *
 * @param {object} opts
 * @param {number} threshold
 * @returns {number}
 */
export function resolveBoundaryFalloff(opts, threshold) {
  if (opts.edgeFalloff != null) return opts.edgeFalloff;
  if (opts.boundaryFalloff != null) return opts.boundaryFalloff;
  if (opts.boundaryFalloffNorm != null && opts.fieldRangeMax != null) {
    return opts.boundaryFalloffNorm * opts.fieldRangeMax;
  }
  return threshold;
}

/**
 * Prepare strokes for distance-field rasterization.
 *
 * @param {*} paths
 * @param {object} [opts]
 * @returns {{ set: import('./internal/paths.js').Polyline[], threshold: number, smooth: number, fieldOpts: object, boundaryFalloff: number }}
 */
export function prepareStrokes(paths, opts = {}) {
  const { symmetry = 1, phase = 0, mirror = false, resolution = 240 } = opts;
  const pointRadius = opts.pointRadius === true;

  let set = toPathSet(paths, { pointRadius });
  if (opts.flatten !== false) set = flattenPaths(set, { pointRadius });

  const size = Math.max(boundsOf(set).width, boundsOf(set).height, 1e-6);
  const fieldRangeMax = opts.fieldRangeMax ?? opts.thickness ?? size * 0.06;
  const thickness = opts.thickness ?? fieldRangeMax;
  const resample = opts.resample ?? thickness * 0.12;

  set = set.map((p) => resampleByLength(p, resample));

  if (opts.referencePoint) {
    set = cullPointsByReference(set, opts.referencePoint, opts.referenceCullMin ?? -Infinity);
  }

  if (symmetry > 1 || mirror) {
    set = radialSymmetry(set, { symmetry, phase, mirror, center: opts.center });
  }

  const threshold = resolveFieldThreshold({ ...opts, thickness, fieldRangeMax }, size);
  const smooth = opts.smooth ?? 3;
  const taper = opts.taper ?? 1;
  const taperPower = opts.taperPower ?? 0.6;
  const maxRadius = pointRadius ? maxPointRadius(set) : 1;
  const margin = opts.gridBuffer
    ?? opts.margin
    ?? threshold * maxRadius * (opts.gridBufferFactor ?? 1.5);

  return {
    set,
    threshold,
    smooth,
    boundaryFalloff: resolveBoundaryFalloff({ ...opts, thickness, fieldRangeMax }, threshold),
    fieldOpts: {
      resolution,
      margin,
      smooth,
      taper,
      taperPower,
      pointRadius,
    },
  };
}

function maxPointRadius(set) {
  let max = 0;
  for (const poly of set) {
    for (const point of poly) max = Math.max(max, radiusScale(point[2]));
  }
  return max;
}

function radiusScale(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 1;
}
