/**
 * Keep-on-GPU distance field for the meshless raymarch path.
 *
 * This mirrors {@link buildGpuBlurredField} (same prepareStrokes → FieldGrid →
 * rasterizeField → blurFieldPass pipeline, so the silhouette/threshold/symmetry
 * match the mesh path) but NEVER reads the field back to the CPU. The raw and
 * smoothed fields stay resident in StorageBufferAttributes that the raymarch
 * material reads READ-ONLY in the fragment stage.
 *
 * Standalone StorageBufferAttributes are not auto-freed by three's WebGPU
 * backend, so buffers live in a GROW-ONLY pool reused across rebuilds: GPU
 * memory is bounded by the requested field resolution, not by the number of
 * rebuilds.
 * three@0.180 has no BufferAttribute.dispose(), so dispose() nulls the backing
 * typed arrays to make the buffers GC-eligible promptly (see freeBuf below).
 *
 * LOOK-MATCH SCOPE: this reproduces the mesh path's field blur (`smooth` passes
 * on dist/weight) but NOT its two big shaping operators — the 36-pass laplacian
 * vertex-Laplacian melt and the heightSmooth depth passes. The meshless dome
 * SHADING matches; the melted silhouette/outline reads slightly sharper and
 * larger than the mesh. Emulating the melt would need extra field blur plus a
 * compensating iso offset and is intentionally left out of this additive path.
 */

import { StorageBufferAttribute } from 'three/webgpu';

/**
 * Null a pool record's backing typed arrays so the GPU + CPU buffers become
 * GC-eligible. three@0.180 exposes no explicit attribute disposal, so dropping
 * the array references (plus the attribute refs) is the deterministic release.
 * @param {object|null} b - pool record with seg/raw/smoothA/smoothB attributes
 */
function freeBuf(b) {
  if (!b) return;
  for (const key of ['segAttr', 'rawAttr', 'smoothA', 'smoothB']) {
    const attr = b[key];
    if (attr) attr.array = null;
    b[key] = null;
  }
  b.capacity = 0;
  b.segCapacity = 0;
}

function alignTo(value, step) {
  return Math.ceil(value / step) * step;
}

function growSegmentCapacity(required, current = 0) {
  let cap = Math.max(current, 64);
  while (cap < required) cap *= 2;
  return alignTo(cap, 8);
}

function fieldCapacityForGrid(grid, resolution, total) {
  // FieldGrid's largest dimension is resolution + padding cells. Allocating the
  // square envelope up front keeps the raw/smooth storage attributes stable as
  // bounds/aspect change while drawing at the same resolution.
  const maxCells = Math.max(grid.width, grid.height, Math.ceil(resolution) + 3);
  return Math.max(total, maxCells * maxCells);
}

import { prepareStrokes } from './strokePipeline.js';
import { FieldGrid, rasterizeFieldKernel, blurFieldKernel } from './internal/gpuFieldCore.js';

/**
 * @typedef {object} ResidentField
 * @property {{minX:number,minY:number,cell:number,width:number,height:number,segmentCount:number}} grid
 * @property {number} capacity            - cells the storage buffers can hold
 * @property {number} threshold           - iso threshold (g = dist - threshold*weight)
 * @property {number} boundaryFalloff     - rim ramp denominator
 * @property {number} smooth              - blur passes applied
 * @property {number} mergeBlend          - raw↔smoothed silhouette blend
 * @property {number} depthBlend          - field↔boundary depth blend
 * @property {StorageBufferAttribute} rawAttr    - sharp (dist, weight) per cell
 * @property {StorageBufferAttribute} smoothAttr - smoothed (dist, weight); === rawAttr when smooth=0
 * @property {boolean} reused             - true when the material-bound field buffers were reused in place
 * @property {object} _buf                - internal pool record (pass back as `pool`)
 * @property {() => void} dispose
 */

/**
 * Build (or refresh) the GPU-resident field for `strokes`.
 *
 * @param {import('three/webgpu').WebGPURenderer} renderer
 * @param {*} strokes
 * @param {object} [opts] - shapeOptionsFromState(state) shape
 * @param {ResidentField|null} [pool] - the previous result, for buffer reuse
 * @returns {Promise<ResidentField|null>} null when there are no segments to raster
 */
export async function buildResidentField(renderer, strokes, opts = {}, pool = null) {
  if (!renderer?.computeAsync) {
    throw new Error('buildResidentField requires a WebGPURenderer with compute support.');
  }

  // Same stroke preprocessing as the mesh path so the field matches exactly.
  const prepared = prepareStrokes(strokes, {
    ...opts,
    // Spread opts FIRST so this fieldResolution preference is not clobbered by
    // a plain opts.resolution when the two differ.
    resolution: opts.fieldResolution ?? opts.resolution,
  });

  const { resolution, margin, taper, taperPower } = prepared.fieldOpts;
  const grid = new FieldGrid(prepared.set, { resolution, margin, taper, taperPower });
  if (grid.segmentCount === 0) return null;

  const total = grid.width * grid.height;
  const segFloats = grid.segmentData.length;
  const prev = pool?._buf ?? null;
  const reuse = !!(prev && prev.capacity >= total);

  let b;
  if (reuse) {
    b = prev;
    // Segment data is compute-only (never bound to the raymarch material), so
    // it can grow independently without forcing raw/smooth field storage or the
    // material node graph to be recreated.
    if (!b.segAttr || b.segCapacity < segFloats) {
      const oldSeg = b.segAttr;
      if (oldSeg) oldSeg.array = null;
      b.segCapacity = growSegmentCapacity(segFloats, b.segCapacity);
      b.segAttr = new StorageBufferAttribute(new Float32Array(b.segCapacity), 4);
    }
    b.segAttr.array.set(grid.segmentData);
    b.segAttr.needsUpdate = true;
  } else {
    const capacity = fieldCapacityForGrid(grid, resolution, total);
    const segCapacity = growSegmentCapacity(segFloats);
    b = {
      capacity,
      segCapacity,
      segAttr: new StorageBufferAttribute(new Float32Array(segCapacity), 4),
      rawAttr: new StorageBufferAttribute(new Float32Array(capacity * 2), 2),
      smoothA: new StorageBufferAttribute(new Float32Array(capacity * 2), 2),
      smoothB: new StorageBufferAttribute(new Float32Array(capacity * 2), 2),
    };
    b.segAttr.array.set(grid.segmentData);
    b.segAttr.needsUpdate = true;
  }

  // Rasterize the sharp field into rawAttr (kept for the silhouette merge),
  // then separable box blur into smoothA, ping-ponging through smoothB.
  // rawAttr is read, never overwritten, so the sharp field survives for the
  // merge term. Everything queues into ONE compute pass — dispatches in a pass
  // are ordered with storage writes visible to the next dispatch, so this
  // costs a single computeAsync instead of one await per blur direction.
  const passes = Math.max(0, Math.floor(prepared.smooth));
  const batch = [rasterizeFieldKernel(grid, b.segAttr, b.rawAttr)];
  let smoothAttr = b.rawAttr;
  if (passes > 0) {
    batch.push(blurFieldKernel(grid, b.rawAttr, b.smoothB, true));
    batch.push(blurFieldKernel(grid, b.smoothB, b.smoothA, false));
    if (passes > 1) {
      const h = blurFieldKernel(grid, b.smoothA, b.smoothB, true);
      const v = blurFieldKernel(grid, b.smoothB, b.smoothA, false);
      for (let p = 1; p < passes; p++) batch.push(h, v);
    }
    smoothAttr = b.smoothA;
  }
  await renderer.computeAsync(batch);

  const mergeScale = opts.fieldMergeBlendScale ?? 8;
  const depthScale = opts.fieldDepthBlendScale ?? 6;

  return {
    grid: {
      minX: grid.minX,
      minY: grid.minY,
      cell: grid.cell,
      width: grid.width,
      height: grid.height,
      segmentCount: grid.segmentCount,
    },
    capacity: b.capacity,
    threshold: prepared.threshold,
    boundaryFalloff: prepared.boundaryFalloff,
    smooth: passes,
    mergeBlend: Math.min(1, passes / mergeScale),
    depthBlend: Math.min(1, passes / depthScale),
    rawAttr: b.rawAttr,
    smoothAttr,
    reused: reuse,
    _buf: b,
    /**
     * Release this field's buffers.
     *
     * A REUSED field shares `b` with the still-current pool, so a routine
     * dispose() (e.g. discarding a superseded build) must NOT free it — that
     * would null the buffers the live material is sampling. It frees only when
     * this field owns a fresh allocation (`!reuse`). Pass `force=true` on
     * unmount, when nothing else references `b`, to release unconditionally.
     * @param {boolean} [force=false]
     */
    dispose(force = false) {
      if (force || !reuse) freeBuf(b);
    },
  };
}
