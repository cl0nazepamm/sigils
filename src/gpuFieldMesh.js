/**
 * GPU SDF field → blur → marching-squares fill mesh.
 *
 * Rasterization runs on WebGPU. Smoothing follows the same raw-vs-shaded split as
 * {@link DistanceField}: raw dist/weight for the marching-squares silhouette,
 * blurred copies for height sampling only.
 */

import { BufferGeometry } from 'three';

import { finishSigilGeometryFromFieldAsync } from './buildGeometry.js';
import { buildGpuDistanceField } from './gpuDistanceField.js';
import { prepareStrokes } from './strokePipeline.js';

/**
 * Build a merged chrome mesh: GPU distance field, CPU smooth, CPU marching squares.
 *
 * @param {import('three/webgpu').WebGPURenderer} renderer
 * @param {*} paths
 * @param {object} [opts]
 * @returns {Promise<BufferGeometry>}
 */
export async function buildGpuFieldMeshAsync(renderer, paths, opts = {}) {
  if (!renderer?.computeAsync || !renderer?.getArrayBufferAsync) {
    throw new Error('buildGpuFieldMeshAsync requires a WebGPURenderer with compute/readback support.');
  }

  const field = await buildGpuBlurredField(renderer, paths, opts);
  if (!field) return new BufferGeometry();

  const geo = await finishSigilGeometryFromFieldAsync(field, {
    ...opts,
    renderer,
    threshold: field.meta?.threshold,
    edgeFalloff: field.meta?.boundaryFalloff,
    smooth: field.meta?.smooth,
  });
  geo.userData.buildBackend = 'gpu-sdf-mesh';
  geo.userData.sparseCurveStats = {
    baseSegments: 0,
    drawnSegments: 0,
    vertices: geo.getAttribute('position')?.count ?? 0,
    fieldWidth: field.width,
    fieldHeight: field.height,
  };
  return geo;
}

/**
 * @param {import('three/webgpu').WebGPURenderer} renderer
 * @param {*} paths
 * @param {object} [opts]
 * @returns {Promise<import('./distanceField.js').DistanceField|null>}
 */
export async function buildGpuBlurredField(renderer, paths, opts = {}) {
  const prepared = prepareStrokes(paths, {
    ...opts,
    // Keep the explicit field grid preference from being overwritten by the
    // general geometry resolution, matching the resident meshless path.
    resolution: opts.fieldResolution ?? opts.resolution,
  });

  const field = await buildGpuDistanceField(renderer, prepared.set, prepared.fieldOpts);
  if (!field?._segments?.count) return null;

  field.meta = {
    threshold: prepared.threshold,
    boundaryFalloff: prepared.boundaryFalloff,
    smooth: prepared.smooth,
  };
  return field;
}
