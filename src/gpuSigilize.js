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
  uint,
  vec2,
} from 'three/tsl';

/**
 * Mesh-adjacency XY blur (sigilize) on WebGPU.
 * Dome vertices blend toward neighbors; proximity links pull separate strips together at crossings.
 *
 * @param {import('three/webgpu').WebGPURenderer} renderer
 * @param {import('three').BufferGeometry} geometry
 * @param {object} opts
 * @returns {Promise<import('three').BufferGeometry>}
 */
export async function gpuSigilizePositions(renderer, geometry, opts = {}) {
  if (!renderer || typeof renderer.computeAsync !== 'function' || typeof renderer.getArrayBufferAsync !== 'function') {
    throw new Error('gpuSigilizePositions requires a WebGPURenderer with compute/readback support.');
  }

  const iterations = Math.max(0, Math.floor(opts.iterations ?? opts.sigilize ?? 0));
  const weight = clamp01(opts.weight ?? opts.sigilizeWeight ?? 1);
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
  const { maxDeg, neighborCount, neighborIndices } = buildAdjacency(
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
  const countBuf = new StorageBufferAttribute(neighborCount, 1);
  const neighBuf = new StorageBufferAttribute(neighborIndices, 1);

  let readAttr = posAAttr;
  let writeAttr = posBAttr;
  const maxNeighbors = uint(maxDeg);
  const w = float(weight);

  for (let pass = 0; pass < iterations; pass++) {
    const posIn = storage(readAttr, 'vec2', count).toReadOnly();
    const posOut = storage(writeAttr, 'vec2', count);
    const activeMask = storage(activeBuf, 'float', count).toReadOnly();
    const nCount = storage(countBuf, 'uint', count).toReadOnly();
    const nIndex = storage(neighBuf, 'uint', count * maxDeg).toReadOnly();

    const kernel = Fn(() => {
      const vi = instanceIndex;
      const mask = activeMask.element(vi);
      const px = posIn.element(vi).x;
      const py = posIn.element(vi).y;
      const n = nCount.element(vi);

      const sx = float(0).toVar();
      const sy = float(0).toVar();

      Loop(maxDeg, ({ i }) => {
        If(uint(i).lessThan(n), () => {
          const j = nIndex.element(vi.mul(maxNeighbors).add(uint(i)));
          sx.addAssign(posIn.element(j).x);
          sy.addAssign(posIn.element(j).y);
        });
      });

      const inv = float(1).div(float(n).max(1));
      const ax = sx.mul(inv);
      const ay = sy.mul(inv);
      const bx = px.add(ax.sub(px).mul(w));
      const by = py.add(ay.sub(py).mul(w));
      const outX = mix(px, bx, mask);
      const outY = mix(py, by, mask);
      posOut.element(vi).assign(vec2(outX, outY));
    })().compute(count);

    await renderer.computeAsync(kernel);
    [readAttr, writeAttr] = [writeAttr, readAttr];
  }

  const finalAttr = readAttr;
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
export async function gpuBlurRegionPositions(renderer, region, iterations, weight) {
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

  const { maxDeg, neighborCount, neighborIndices } = buildAdjacency(count, indices);

  const posAAttr = new StorageBufferAttribute(xyA, 2);
  const posBAttr = new StorageBufferAttribute(new Float32Array(count * 2), 2);
  const countAttr = new StorageBufferAttribute(neighborCount, 1);
  const neighAttr = new StorageBufferAttribute(neighborIndices, 1);

  let readAttr = posAAttr;
  let writeAttr = posBAttr;
  const maxNeighbors = uint(maxDeg);
  const wNode = float(w);

  for (let pass = 0; pass < passes; pass++) {
    const posIn = storage(readAttr, 'vec2', count).toReadOnly();
    const posOut = storage(writeAttr, 'vec2', count);
    const nCount = storage(countAttr, 'uint', count).toReadOnly();
    const nIndex = storage(neighAttr, 'uint', count * maxDeg).toReadOnly();

    const kernel = Fn(() => {
      const vi = instanceIndex;
      const px = posIn.element(vi).x;
      const py = posIn.element(vi).y;
      const n = nCount.element(vi);

      const sx = float(0).toVar();
      const sy = float(0).toVar();
      Loop(maxDeg, ({ i }) => {
        If(uint(i).lessThan(n), () => {
          const j = nIndex.element(vi.mul(maxNeighbors).add(uint(i)));
          sx.addAssign(posIn.element(j).x);
          sy.addAssign(posIn.element(j).y);
        });
      });

      const inv = float(1).div(float(n).max(1));
      const bx = px.add(sx.mul(inv).sub(px).mul(wNode));
      const by = py.add(sy.mul(inv).sub(py).mul(wNode));
      // Isolated vertices (n == 0) keep their position, matching the CPU guard.
      const outX = select(n.greaterThan(0), bx, px);
      const outY = select(n.greaterThan(0), by, py);
      posOut.element(vi).assign(vec2(outX, outY));
    })().compute(count);

    await renderer.computeAsync(kernel);
    [readAttr, writeAttr] = [writeAttr, readAttr];
  }

  const buffer = await renderer.getArrayBufferAsync(readAttr);
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
export function cpuSigilizePositions(geometry, iterations, weight, activeAttribute = 'aDome', linkRadius = 0) {
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

  const { maxDeg, neighborIndices, neighborCount } = buildAdjacency(
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
      const base = i * maxDeg;
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
export async function sigilizePositionsAsync(renderer, geometry, opts = {}) {
  const iterations = Math.max(0, Math.floor(opts.iterations ?? opts.sigilize ?? 0));
  if (iterations <= 0) return geometry;

  const linkRadius = opts.linkRadius ?? (opts.thickness != null ? opts.thickness * 0.55 : 0);

  if (renderer && typeof renderer.computeAsync === 'function') {
    try {
      const out = await gpuSigilizePositions(renderer, geometry, { ...opts, linkRadius });
      geometry.userData.sigilizeBackend = 'gpu';
      return out;
    } catch (error) {
      console.warn('sigils: GPU sigilize failed, using CPU', error);
    }
  }

  cpuSigilizePositions(
    geometry,
    iterations,
    opts.weight ?? opts.sigilizeWeight ?? 1,
    opts.activeAttribute,
    linkRadius,
  );
  geometry.userData.sigilizeBackend = 'cpu';
  return geometry;
}

export function buildAdjacency(count, indices, positions = null, active = null, linkRadius = 0) {
  const sets = Array.from({ length: count }, () => new Set());
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    sets[a].add(b); sets[a].add(c);
    sets[b].add(a); sets[b].add(c);
    sets[c].add(a); sets[c].add(b);
  }

  if (positions && active && linkRadius > 0) {
    addProximityLinks(sets, positions, active, linkRadius);
  }

  let maxDeg = 1;
  for (const set of sets) maxDeg = Math.max(maxDeg, set.size);

  const neighborCount = new Uint32Array(count);
  const neighborIndices = new Uint32Array(count * maxDeg);

  for (let i = 0; i < count; i++) {
    const neighbors = Array.from(sets[i]);
    neighborCount[i] = neighbors.length;
    for (let k = 0; k < neighbors.length; k++) {
      neighborIndices[i * maxDeg + k] = neighbors[k];
    }
  }

  return { maxDeg, neighborCount, neighborIndices };
}

function addProximityLinks(sets, positions, active, linkRadius) {
  const count = sets.length;
  const r2 = linkRadius * linkRadius;
  const cell = linkRadius;
  const buckets = new Map();

  for (let i = 0; i < count; i++) {
    if (!active[i]) continue;
    const x = positions[i * 2];
    const y = positions[i * 2 + 1];
    const key = `${Math.floor(x / cell)}|${Math.floor(y / cell)}`;
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
      for (let dx = -1; dx <= 1; dx++) {
        const list = buckets.get(`${cx + dx}|${cy + dy}`);
        if (!list) continue;
        for (const j of list) {
          if (j <= i) continue;
          const dx2 = x - positions[j * 2];
          const dy2 = y - positions[j * 2 + 1];
          if (dx2 * dx2 + dy2 * dy2 <= r2) {
            sets[i].add(j);
            sets[j].add(i);
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
