/**
 * sigils — procedural chrome-sigil meshes for three.js.
 *
 * Pipeline: strokes -> radial symmetry -> distance field -> filled marching
 * squares -> solidify -> TSL displacement + chrome shading.
 */

// High-level
export { createSigil, createSigilAsync } from './createSigil.js';
export {
  SIGIL_DEFAULTS,
  createSigilState,
  shapeOptionsFromState,
  sparsePreviewOptionsFromState,
  chromeOptionsFromState,
  mergedSigilShapeOptions,
  realtimeMergedShapeOptions,
  DRAW_MERGE_RESOLUTION,
  REALTIME_MERGE_RESOLUTION,
} from './sigilDefaults.js';

// Geometry pipeline (compose your own)
export { buildSigilGeometry, buildSigilGeometryAsync, finishSigilGeometryFromField } from './buildGeometry.js';
export { buildSparseCurveGeometry, buildSparseCurveGeometryAsync } from './sparseCurveGeometry.js';
export { buildGpuDistanceField } from './gpuDistanceField.js';
export { buildGpuFieldMeshAsync, buildGpuBlurredField } from './gpuFieldMesh.js';
export { gpuSigilizePositions, cpuSigilizePositions, sigilizePositionsAsync } from './gpuSigilize.js';
export { spirograph } from './spirograph.js';
export { radialSymmetry } from './symmetry.js';
export {
  prepareStrokes,
  stackRotatedCopies,
  cullPointsByReference,
  emblemParamsToOptions,
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
