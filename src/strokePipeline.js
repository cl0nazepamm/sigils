/**
 * Stroke preparation helpers for distance-field rasterization:
 * flatten → stacked rotational copies → resample → optional reference cull → symmetry.
 */

import { toPathSet, resampleByLength, boundsOf, centroidOf } from './internal/paths.js';
import { radialSymmetry } from './symmetry.js';

const TAU = Math.PI * 2;

/**
 * Drop points whose distance to a reference position fails the keep test.
 * When `minDistance` is negative, every finite distance passes (legacy no-op guard).
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
    for (const [x, y] of poly) {
      const d = Math.hypot(x - rx, y - ry);
      if (d > minDistance) kept.push([x, y]);
    }
    if (kept.length >= 2) out.push(kept);
  }
  return out.length ? out : set;
}

/**
 * Accumulated rotational copies (repeat-zone style): each iteration adds another
 * rotated duplicate of the source strokes to the path set.
 *
 * @param {*} paths
 * @param {object} [opts]
 * @param {number} [opts.copies=1] - total layers including the source
 * @param {[number, number]} [opts.center]
 * @param {number} [opts.angleStep] - radians per copy; default `TAU / copies`
 * @returns {import('./internal/paths.js').Polyline[]}
 */
export function stackRotatedCopies(paths, opts = {}) {
  const base = toPathSet(paths);
  const copies = Math.max(1, Math.floor(opts.copies ?? 1));
  if (copies === 1) return base;

  const [cx, cy] = opts.center ?? centroidOf(base);
  const step = opts.angleStep ?? TAU / copies;
  const out = base.map((poly) => poly.map(([x, y]) => [x, y]));

  for (let k = 1; k < copies; k++) {
    const a = step * k;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (const poly of base) {
      out.push(rotatePoly(poly, cx, cy, ca, sa));
    }
  }
  return out;
}

function rotatePoly(poly, cx, cy, ca, sa) {
  const res = new Array(poly.length);
  for (let i = 0; i < poly.length; i++) {
    const dx = poly[i][0] - cx;
    const dy = poly[i][1] - cy;
    res[i] = [cx + dx * ca - dy * sa, cy + dx * sa + dy * ca];
  }
  return res;
}

/**
 * Squash Z onto the XY plane when 3D points are supplied as `[x,y,z]`.
 *
 * @param {import('./internal/paths.js').Polyline[]} set
 * @returns {import('./internal/paths.js').Polyline[]}
 */
export function flattenPaths(set) {
  return set.map((poly) =>
    poly.map((p) => (p.length > 2 ? [p[0], p[1]] : [p[0], p[1]])),
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

  let set = toPathSet(paths);
  if (opts.flatten !== false) set = flattenPaths(set);

  const spiroCopies = opts.spiroCopies ?? opts.spiroStack;
  if (spiroCopies != null && spiroCopies > 1) {
    set = stackRotatedCopies(set, {
      copies: spiroCopies,
      center: opts.center,
      angleStep: opts.spiroAngleStep,
    });
  }

  const size = Math.max(boundsOf(set).width, boundsOf(set).height, 1e-6);
  const fieldRangeMax = opts.fieldRangeMax ?? opts.lineThickness ?? opts.thickness ?? size * 0.06;
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
  const margin = opts.gridBuffer
    ?? opts.margin
    ?? threshold * (opts.gridBufferFactor ?? 1.5);

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
    },
  };
}

/**
 * Convert external shape controls into sigils shape options.
 * Names mirror modifier sockets; values stay in caller units.
 *
 * @param {object} params
 * @returns {object}
 */
export function emblemParamsToOptions(params = {}) {
  const thickness = params.lineThickness ?? params.thickness;
  const peakRaw = params.peakHeight ?? params.peak;
  const peakScale = params.peakHeightScale ?? 1000;

  return {
    ...(thickness != null ? { thickness, fieldRangeMax: thickness, lineThickness: thickness } : {}),
    ...(params.resolution != null ? { resolution: params.resolution } : {}),
    ...(params.spiroCopies != null ? { spiroCopies: params.spiroCopies } : {}),
    ...(params.SPIRO != null ? { spiroCopies: params.SPIRO } : {}),
    ...(params.symmetry != null ? { symmetry: params.symmetry } : {}),
    ...(params.sigilize != null ? { sigilize: params.sigilize } : {}),
    ...(params.sigilizeWeight != null ? { sigilizeWeight: params.sigilizeWeight } : {}),
    ...(params.soften != null ? { heightSmooth: params.soften } : {}),
    ...(params.extrudeBase != null ? { base: params.extrudeBase } : {}),
    ...(params.isoThreshold != null ? { isoThreshold: params.isoThreshold } : { isoThreshold: 0.55517578125 }),
    ...(params.boundaryFalloffNorm != null
      ? { boundaryFalloffNorm: params.boundaryFalloffNorm }
      : { boundaryFalloffNorm: 0.3450927734375 }),
    ...(params.gridBuffer != null ? { gridBuffer: params.gridBuffer } : {}),
    ...(params.referencePoint != null ? { referencePoint: params.referencePoint } : {}),
    ...(params.referenceCullMin != null ? { referenceCullMin: params.referenceCullMin } : {}),
    ...(params.flatten != null ? { flatten: params.flatten } : {}),
    depthMode: params.depthMode ?? 'boundary',
    ...(peakRaw != null ? { peakHeight: peakRaw / peakScale } : {}),
  };
}
