/**
 * sigils — procedural chrome-sigil meshes for three.js.
 *
 * Pipeline: strokes -> radial symmetry -> distance field -> filled marching
 * squares -> solidify -> TSL displacement + chrome shading.
 */

// High-level
export { createSigil, createSigilAsync } from './createSigil.js';

// Geometry pipeline (compose your own)
export { buildSigilGeometry, buildSigilGeometryAsync } from './buildGeometry.js';
export { buildSparseCurveGeometry } from './sparseCurveGeometry.js';
export { buildGpuDistanceField } from './gpuDistanceField.js';
export { spirograph } from './spirograph.js';
export { radialSymmetry } from './symmetry.js';
export { DistanceField } from './distanceField.js';
export { fillRegion } from './fillRegion.js';

// Material (TSL)
export { createChromeMaterial, updateChromeMaterial } from './tsl/chromeMaterial.js';

// Path utilities
export {
  toPolyline,
  toPathSet,
  boundsOf,
  centroidOf,
  resampleByLength,
} from './internal/paths.js';
