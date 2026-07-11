import { StorageBufferAttribute } from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  float,
  instanceIndex,
  mix,
  select,
  storage,
  uniform,
  uint,
  vec2,
} from 'three/tsl';
import { addUnique, buildNeighborLists } from './internal/adjacency.js';

/**
 * Mesh-adjacency XY blur (laplacian) on WebGPU.
 * Dome vertices blend toward neighbors; proximity links pull separate strips together at crossings.
 *
 * @param {import('three/webgpu').WebGPURenderer} renderer
 * @param {import('three').BufferGeometry} geometry
 * @param {object} opts
 * @returns {Promise<import('three').BufferGeometry>}
 */
export async function gpuLaplacianPositions(renderer, geometry, opts = {}) {
  if (!renderer || typeof renderer.computeAsync !== 'function' || typeof renderer.getArrayBufferAsync !== 'function') {
    throw new Error('gpuLaplacianPositions requires a WebGPURenderer with compute/readback support.');
  }

  const iterations = Math.max(0, Math.floor(opts.iterations ?? opts.laplacian ?? 0));
  const weight = clamp01(opts.weight ?? opts.laplacianWeight ?? 1);
  if (iterations <= 0 || weight <= 0) return geometry;

  const posAttr = geometry.getAttribute('position');
  const index = geometry.index;
  const activeAttr = geometry.getAttribute(opts.activeAttribute ?? 'aDome');
  if (!posAttr || !index || !activeAttr) return geometry;

  const count = posAttr.count;
  if (count === 0) return geometry;

  const positions = new Float32Array(count * 2);
  const active = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 2] = posAttr.getX(i);
    positions[i * 2 + 1] = posAttr.getY(i);
    active[i] = activeAttr.getX(i) > 0.5 ? 1 : 0;
  }

  const linkRadius = opts.linkRadius ?? opts.thickness ?? 0;
  const { neighborOffsets, neighborIndices } = buildAdjacency(
    count,
    index.array,
    positions,
    active,
    linkRadius,
  );

  const posA = Float32Array.from(positions);
  const posB = new Float32Array(count * 2);

  const posAAttr = new StorageBufferAttribute(posA, 2);
  const posBAttr = new StorageBufferAttribute(posB, 2);
  const activeBuf = new StorageBufferAttribute(active, 1);
  const offsetBuf = new StorageBufferAttribute(neighborOffsets, 1);
  const neighBuf = new StorageBufferAttribute(neighborIndices, 1);
  const w = uniform(weight);

  // Two fixed ping-pong kernels (A→B, B→A) queued `iterations` times into ONE
  // compute pass: dispatches in a pass are ordered with storage writes visible
  // to the next dispatch, so a single computeAsync replaces one await (and one
  // fresh kernel/pipeline) per pass.
  const makeKernel = (fromAttr, toAttr) => {
    const posIn = storage(fromAttr, 'vec2', count).toReadOnly();
    const posOut = storage(toAttr, 'vec2', count);
    const activeMask = storage(activeBuf, 'float', count).toReadOnly();
    const nOffset = storage(offsetBuf, 'uint', count + 1).toReadOnly();
    const nIndex = storage(neighBuf, 'uint', neighborIndices.length).toReadOnly();

    return Fn(() => {
      const vi = instanceIndex;
      const mask = activeMask.element(vi);
      const px = posIn.element(vi).x;
      const py = posIn.element(vi).y;
      const start = nOffset.element(vi);
      const n = nOffset.element(vi.add(1)).sub(start);

      const sx = float(0).toVar();
      const sy = float(0).toVar();

      Loop({ start: uint(0), end: n, type: 'uint', condition: '<' }, ({ i }) => {
        const j = nIndex.element(start.add(i));
        sx.addAssign(posIn.element(j).x);
        sy.addAssign(posIn.element(j).y);
      });

      const inv = float(1).div(float(n).max(1));
      const ax = sx.mul(inv);
      const ay = sy.mul(inv);
      const bx = px.add(ax.sub(px).mul(w));
      const by = py.add(ay.sub(py).mul(w));
      // Keep isolated vertices fixed. Their accumulated average is (0, 0), so
      // mixing `bx/by` directly would pull an active singleton toward origin.
      const outX = select(n.greaterThan(0), mix(px, bx, mask), px);
      const outY = select(n.greaterThan(0), mix(py, by, mask), py);
      posOut.element(vi).assign(vec2(outX, outY));
    })().compute(count);
  };

  const kernelAB = makeKernel(posAAttr, posBAttr);
  const kernelBA = makeKernel(posBAttr, posAAttr);
  const batch = [];
  for (let pass = 0; pass < iterations; pass++) {
    batch.push(pass % 2 === 0 ? kernelAB : kernelBA);
  }
  await renderer.computeAsync(batch);

  const finalAttr = iterations % 2 === 1 ? posBAttr : posAAttr;
  const buffer = await renderer.getArrayBufferAsync(finalAttr);
  const packed = new Float32Array(buffer);

  for (let i = 0; i < count; i++) {
    if (active[i] > 0.5) {
      posAttr.setX(i, packed[i * 2]);
      posAttr.setY(i, packed[i * 2 + 1]);
    }
  }
  posAttr.needsUpdate = true;
  syncWallPositions(geometry);
  return geometry;
}

/**
 * GPU port of buildGeometry.blurRegionPositions: triangle-adjacency XY Laplacian
 * smoothing of a flat marching-squares region, mutated in place. No proximity
 * links and no active mask (every region vertex is blurred), and the neighbour
 * order comes from the same Set-insertion adjacency the CPU uses — so the result
 * matches the CPU path to float32 (verified divergence < 2e-6 over 36 passes).
 *
 * @param {import('three/webgpu').WebGPURenderer} renderer
 * @param {{positions: Float32Array, indices: ArrayLike<number>, count: number}} region
 * @param {number} iterations
 * @param {number} weight
 * @returns {Promise<typeof region>}
 */
export async function gpuBlurRegionPositions(renderer, region, iterations, weight, adjacency = null) {
  if (!renderer || typeof renderer.computeAsync !== 'function' || typeof renderer.getArrayBufferAsync !== 'function') {
    throw new Error('gpuBlurRegionPositions requires a WebGPURenderer with compute/readback support.');
  }

  const passes = Math.max(0, Math.floor(iterations));
  const w = clamp01(weight);
  if (passes <= 0 || w <= 0) return region;

  const { positions, indices, count } = region;
  if (!positions || !indices || !count) return region;

  // XY only; z is 0 across the flat region and is restored untouched on write-back.
  const xyA = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    xyA[i * 2] = positions[i * 3];
    xyA[i * 2 + 1] = positions[i * 3 + 1];
  }

  const { neighborOffsets, neighborIndices } = adjacency ?? buildAdjacency(count, indices);

  const posAAttr = new StorageBufferAttribute(xyA, 2);
  const posBAttr = new StorageBufferAttribute(new Float32Array(count * 2), 2);
  const offsetAttr = new StorageBufferAttribute(neighborOffsets, 1);
  const neighAttr = new StorageBufferAttribute(neighborIndices, 1);
  const wNode = uniform(w);

  // Same single-pass ping-pong batching as gpuLaplacianPositions: all passes
  // queue into one computeAsync instead of a GPU round trip per pass.
  const makeKernel = (fromAttr, toAttr) => {
    const posIn = storage(fromAttr, 'vec2', count).toReadOnly();
    const posOut = storage(toAttr, 'vec2', count);
    const nOffset = storage(offsetAttr, 'uint', count + 1).toReadOnly();
    const nIndex = storage(neighAttr, 'uint', neighborIndices.length).toReadOnly();

    return Fn(() => {
      const vi = instanceIndex;
      const px = posIn.element(vi).x;
      const py = posIn.element(vi).y;
      const start = nOffset.element(vi);
      const n = nOffset.element(vi.add(1)).sub(start);

      const sx = float(0).toVar();
      const sy = float(0).toVar();
      Loop({ start: uint(0), end: n, type: 'uint', condition: '<' }, ({ i }) => {
        const j = nIndex.element(start.add(i));
        sx.addAssign(posIn.element(j).x);
        sy.addAssign(posIn.element(j).y);
      });

      const inv = float(1).div(float(n).max(1));
      const bx = px.add(sx.mul(inv).sub(px).mul(wNode));
      const by = py.add(sy.mul(inv).sub(py).mul(wNode));
      // Isolated vertices (n == 0) keep their position, matching the CPU guard.
      const outX = select(n.greaterThan(0), bx, px);
      const outY = select(n.greaterThan(0), by, py);
      posOut.element(vi).assign(vec2(outX, outY));
    })().compute(count);
  };

  const kernelAB = makeKernel(posAAttr, posBAttr);
  const kernelBA = makeKernel(posBAttr, posAAttr);
  const batch = [];
  for (let pass = 0; pass < passes; pass++) {
    batch.push(pass % 2 === 0 ? kernelAB : kernelBA);
  }
  await renderer.computeAsync(batch);

  const finalAttr = passes % 2 === 1 ? posBAttr : posAAttr;
  const buffer = await renderer.getArrayBufferAsync(finalAttr);
  const packed = new Float32Array(buffer);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = packed[i * 2];
    positions[i * 3 + 1] = packed[i * 2 + 1];
  }
  return region;
}

/**
 * CPU fallback matching buildGeometry blurRegionPositions.
 */
export function cpuLaplacianPositions(geometry, iterations, weight, activeAttribute = 'aDome', linkRadius = 0) {
  const w = clamp01(weight);
  const passes = Math.max(0, Math.floor(iterations));
  if (passes <= 0 || w <= 0) return geometry;

  const posAttr = geometry.getAttribute('position');
  const activeAttr = geometry.getAttribute(activeAttribute);
  const index = geometry.index;
  if (!posAttr || !index || !activeAttr) return geometry;

  const count = posAttr.count;
  const positions = new Float32Array(count * 2);
  const active = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 2] = posAttr.getX(i);
    positions[i * 2 + 1] = posAttr.getY(i);
    active[i] = activeAttr.getX(i) > 0.5 ? 1 : 0;
  }

  const { neighborOffsets, neighborIndices, neighborCount } = buildAdjacency(
    count,
    index.array,
    positions,
    active,
    linkRadius,
  );

  let x = new Float32Array(count);
  let y = new Float32Array(count);
  let nx = new Float32Array(count);
  let ny = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    x[i] = positions[i * 2];
    y[i] = positions[i * 2 + 1];
  }

  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < count; i++) {
      if (!active[i]) {
        nx[i] = x[i];
        ny[i] = y[i];
        continue;
      }
      const n = neighborCount[i];
      if (n === 0) {
        nx[i] = x[i];
        ny[i] = y[i];
        continue;
      }
      let sx = 0;
      let sy = 0;
      const base = neighborOffsets[i];
      for (let k = 0; k < n; k++) {
        const j = neighborIndices[base + k];
        sx += x[j];
        sy += y[j];
      }
      const inv = 1 / n;
      nx[i] = x[i] + (sx * inv - x[i]) * w;
      ny[i] = y[i] + (sy * inv - y[i]) * w;
    }
    [x, nx] = [nx, x];
    [y, ny] = [ny, y];
  }

  for (let i = 0; i < count; i++) {
    if (active[i]) {
      posAttr.setX(i, x[i]);
      posAttr.setY(i, y[i]);
    }
  }
  posAttr.needsUpdate = true;
  syncWallPositions(geometry);
  return geometry;
}

/**
 * @param {import('three/webgpu').WebGPURenderer} renderer
 * @param {import('three').BufferGeometry} geometry
 * @param {object} opts
 */
export async function laplacianPositionsAsync(renderer, geometry, opts = {}) {
  const iterations = Math.max(0, Math.floor(opts.iterations ?? opts.laplacian ?? 0));
  if (iterations <= 0) return geometry;

  const linkRadius = opts.linkRadius ?? (opts.thickness != null ? opts.thickness * 0.55 : 0);

  if (renderer && typeof renderer.computeAsync === 'function') {
    try {
      const out = await gpuLaplacianPositions(renderer, geometry, { ...opts, linkRadius });
      geometry.userData.laplacianBackend = 'gpu';
      return out;
    } catch (error) {
      console.warn('sigils: GPU laplacian failed, using CPU', error);
    }
  }

  cpuLaplacianPositions(
    geometry,
    iterations,
    opts.weight ?? opts.laplacianWeight ?? 1,
    opts.activeAttribute,
    linkRadius,
  );
  geometry.userData.laplacianBackend = 'cpu';
  return geometry;
}

export function buildAdjacency(count, indices, positions = null, active = null, linkRadius = 0) {
  const neighbors = buildNeighborLists(count, indices);

  if (positions && active && linkRadius > 0) {
    addProximityLinks(neighbors, positions, active, linkRadius);
  }

  let maxDeg = 1;
  for (const list of neighbors) maxDeg = Math.max(maxDeg, list.length);

  const neighborCount = new Uint32Array(count);
  const neighborOffsets = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) {
    const list = neighbors[i];
    neighborCount[i] = list.length;
    neighborOffsets[i + 1] = neighborOffsets[i] + list.length;
  }
  // Keep one inert element for the fully isolated case; WebGPU does not allow
  // a zero-byte storage binding, and every offset remains zero so it is unread.
  const neighborIndices = new Uint32Array(Math.max(1, neighborOffsets[count]));
  for (let i = 0; i < count; i++) {
    const list = neighbors[i];
    for (let k = 0; k < list.length; k++) {
      neighborIndices[neighborOffsets[i] + k] = list[k];
    }
  }

  return { neighbors, maxDeg, neighborOffsets, neighborCount, neighborIndices };
}

function addProximityLinks(neighbors, positions, active, linkRadius) {
  const count = neighbors.length;
  const r2 = linkRadius * linkRadius;
  const cell = linkRadius;

  // Numeric packed keys (like surfaceVine's packCell). Cell coordinates can be
  // negative, so pack them offset from the min cell to keep keys non-negative.
  let minCx = Infinity;
  let minCy = Infinity;
  let maxCy = -Infinity;
  for (let i = 0; i < count; i++) {
    if (!active[i]) continue;
    const cx = Math.floor(positions[i * 2] / cell);
    const cy = Math.floor(positions[i * 2 + 1] / cell);
    if (cx < minCx) minCx = cx;
    if (cy < minCy) minCy = cy;
    if (cy > maxCy) maxCy = cy;
  }
  if (minCx === Infinity) return;

  const ny = maxCy - minCy + 1;
  const packCell = (cx, cy) => (cx - minCx) * ny + (cy - minCy);
  const buckets = new Map();

  for (let i = 0; i < count; i++) {
    if (!active[i]) continue;
    const cx = Math.floor(positions[i * 2] / cell);
    const cy = Math.floor(positions[i * 2 + 1] / cell);
    const key = packCell(cx, cy);
    let list = buckets.get(key);
    if (!list) buckets.set(key, list = []);
    list.push(i);
  }

  for (let i = 0; i < count; i++) {
    if (!active[i]) continue;
    const x = positions[i * 2];
    const y = positions[i * 2 + 1];
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);

    for (let dy = -1; dy <= 1; dy++) {
      const yj = cy + dy;
      if (yj < minCy || yj > maxCy) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xj = cx + dx;
        if (xj < minCx) continue;
        const list = buckets.get(packCell(xj, yj));
        if (!list) continue;
        for (const j of list) {
          if (j <= i) continue;
          const dx2 = x - positions[j * 2];
          const dy2 = y - positions[j * 2 + 1];
          if (dx2 * dx2 + dy2 * dy2 <= r2) {
            addUnique(neighbors[i], j);
            addUnique(neighbors[j], i);
          }
        }
      }
    }
  }
}

/** Keep side-wall verts glued to the blurred top rim. */
function syncWallPositions(geometry) {
  const layout = geometry.userData.sparseCurveLayout;
  if (!layout) return;

  const pos = geometry.getAttribute('position');
  const dome = geometry.getAttribute('aDome');
  const { topStride, rowStride, hasBase } = layout;
  if (!hasBase || !topStride || !rowStride) return;

  const count = pos.count;
  const rows = Math.floor(count / rowStride);
  for (let r = 0; r < rows; r++) {
    const base = r * rowStride;
    const leftTop = base;
    const rightTop = base + topStride - 1;
    const side = base + topStride;
    if (side + 3 >= count) break;
    if (dome.getX(leftTop) < 0.5 || dome.getX(rightTop) < 0.5) continue;

    const lx = pos.getX(leftTop);
    const ly = pos.getY(leftTop);
    const rx = pos.getX(rightTop);
    const ry = pos.getY(rightTop);

    pos.setXYZ(side, lx, ly, pos.getZ(side));
    pos.setXYZ(side + 1, lx, ly, pos.getZ(side + 1));
    pos.setXYZ(side + 2, rx, ry, pos.getZ(side + 2));
    pos.setXYZ(side + 3, rx, ry, pos.getZ(side + 3));
  }
  pos.needsUpdate = true;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
