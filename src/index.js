/**
 * three-sigils — procedural chrome-sigil meshes for three.js.
 *
 * Pipeline: strokes -> radial symmetry -> distance field -> filled marching
 * squares -> solidify -> TSL displacement + chrome shading.
 *
 * Creator/demo helpers (panel state, meshless raymarch) live under examples/.
 */

// High-level
export { createSigil, createSigilAsync } from './createSigil.js';

// Geometry pipeline (compose your own)
export {
  buildSigilGeometry,
  buildSigilGeometryAsync,
  finishSigilGeometryFromField,
  finishSigilGeometryFromFieldAsync,
} from './buildGeometry.js';
export { buildSparseCurveGeometry, buildSparseCurveGeometryAsync } from './sparseCurveGeometry.js';
export { buildGpuDistanceField } from './gpuDistanceField.js';
export { buildGpuFieldMeshAsync, buildGpuBlurredField } from './gpuFieldMesh.js';
export { gpuLaplacianPositions, cpuLaplacianPositions, laplacianPositionsAsync } from './gpuLaplacian.js';
export { bspline } from './bspline.js';
export { buildSurfaceSigilGeometry, SURFACE_SIGIL_DEFAULTS } from './surfaceSigil.js';
export { buildSurfaceVineGeometry, buildSurfaceVineFieldGeometry } from './surfaceVine.js';
export { createMeshIndex } from './meshIndex.js';
export { radialSymmetry } from './symmetry.js';
export {
  prepareStrokes,
  cullPointsByReference,
  resolveFieldThreshold,
  resolveBoundaryFalloff,
} from './strokePipeline.js';
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
