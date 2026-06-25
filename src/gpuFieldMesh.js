/**
 * GPU SDF field → blur → marching-squares fill mesh.
 *
 * Rasterization runs on WebGPU. Smoothing follows the same raw-vs-shaded split as
 * {@link DistanceField}: raw dist/weight for the marching-squares silhouette,
 * blurred copies for height sampling only.
 */

import { StorageBufferAttribute } from 'three/webgpu';
import { BufferGeometry } from 'three';

import { finishSigilGeometryFromField } from './buildGeometry.js';
import { prepareStrokes } from './strokePipeline.js';
import {
  FieldGrid,
  rasterizeField,
  readbackBlurredField,
  blurFieldArray,
} from './internal/gpuFieldCore.js';

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

  const geo = finishSigilGeometryFromField(field, {
    ...opts,
    threshold: field.meta?.threshold,
    edgeFalloff: field.meta?.boundaryFalloff,
    smooth: field.meta?.smooth,
  });
  geo.userData.buildBackend = 'gpu-sdf-mesh';
  geo.userData.sigilizeBackend = 'sdf';
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
 * @returns {Promise<import('./internal/gpuFieldCore.js').ReadbackField|null>}
 */
export async function buildGpuBlurredField(renderer, paths, opts = {}) {
  const prepared = prepareStrokes(paths, {
    resolution: opts.fieldResolution ?? opts.resolution,
    ...opts,
  });

  const { resolution, margin, taper, taperPower, smooth } = prepared.fieldOpts;
  const grid = new FieldGrid(prepared.set, { resolution, margin, taper, taperPower });
  const total = grid.width * grid.height;
  if (grid.segmentCount === 0) return null;

  const segmentsAttr = new StorageBufferAttribute(grid.segmentData, 4);
  const fieldAttr = new StorageBufferAttribute(new Float32Array(total * 2), 2);

  await rasterizeField(renderer, grid, segmentsAttr, fieldAttr);

  const field = await readbackBlurredField(renderer, grid, fieldAttr);
  const smoothPasses = Math.max(0, Math.floor(smooth));
  if (smoothPasses > 0) {
    field.distS = blurFieldArray(field.dist, grid.width, grid.height, smoothPasses);
    field.weightS = blurFieldArray(field.weight, grid.width, grid.height, smoothPasses);
  }

  field.meta = {
    threshold: prepared.threshold,
    boundaryFalloff: prepared.boundaryFalloff,
    smooth: prepared.smooth,
  };
  return field;
}
