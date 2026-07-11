/**
 * End-to-end CPU geometry build.
 *
 *   strokes -> resample -> radial symmetry -> distance field
 *           -> filled marching squares -> solidify (top dome + walls + base)
 *           -> BufferGeometry
 *
 * The output geometry stays flat (the dome lives in z=0 and is pushed up later
 * by the TSL material). It carries the attributes the material needs:
 *   - position  (vec3)  base position; the top surface is at z=0, base at z=-base
 *   - aDepth    (float) 0 at the rim, 1 in the raised interior
 *   - aGrad     (vec2)  gradient of aDepth, for analytic normals
 *   - aNormal   (vec3)  flat normal for the non-domed parts (base + walls)
 *   - aDome     (float) 1 on the top surface, 0 on base/walls
 */

import { BufferGeometry, BufferAttribute } from 'three';
import { prepareStrokes } from './strokePipeline.js';
import { DistanceField } from './distanceField.js';
import { fillRegion } from './fillRegion.js';
import { buildGpuDistanceField } from './gpuDistanceField.js';
import { buildAdjacency as buildPackedAdjacency, gpuBlurRegionPositions } from './gpuLaplacian.js';
import { buildNeighborLists } from './internal/adjacency.js';

/**
 * @param {*} paths - one stroke or an array of strokes (see toPathSet)
 * @param {object} [opts]
 * @param {number}  [opts.symmetry=1]    - radial symmetry copies
 * @param {number}  [opts.phase=0]       - global rotation of copies (radians)
 * @param {boolean} [opts.mirror=false]  - add mirrored copies (dihedral)
 * @param {number}  [opts.thickness]     - fat-stroke width; default = 6% of size
 * @param {number}  [opts.resolution=240]- field grid cells across the largest dim
 * @param {number}  [opts.resample]      - stroke resample spacing; default = thickness*0.12
 * @param {number}  [opts.smooth]        - field blur passes; default 1 (de-noise, keeps corners)
 * @param {number}  [opts.taper=1]       - 0 = round caps, 1 = strokes taper to sharp points
 * @param {number}  [opts.taperPower=0.6]- taper profile exponent (lower = blunter tips)
 * @param {number}  [opts.laplacian=0]    - Laplacian position-smooth passes
 * @param {number}  [opts.laplacianWeight=1] - influence of each laplacian blur pass
 * @param {'boundary'|'centerline'} [opts.depthMode='boundary'] - height field source
 * @param {number}  [opts.edgeFalloff]   - boundary distance that reaches full height
 * @param {number}  [opts.base=0]        - solid base depth (0 = open shell, top only)
 * @param {number}  [opts.isoThreshold]  - iso cutoff on a 0..1 normalized field
 * @param {number}  [opts.fieldRangeMax] - world distance mapped to field 1.0
 * @param {number}  [opts.boundaryFalloffNorm] - rim falloff as a fraction of fieldRangeMax
 * @param {number}  [opts.gridBuffer]    - extra grid margin around the stroke bounds
 * @param {[number,number]} [opts.referencePoint] - optional cull reference
 * @param {number}  [opts.referenceCullMin] - keep points with dist > this value
 * @param {number}  [opts.fieldMergeBlendScale=8] - fieldSmooth divisor for fill implicit blend
 * @param {number}  [opts.fieldDepthBlendScale=6] - fieldSmooth divisor for boundary depth blend
 * @param {'plateau'|'carve'} [opts.relief='plateau'] - boundary depth profile. Plateau clamps
 *   depth at 1 once edgeFalloff is reached; carve keeps rising with rim distance so wide
 *   junctions become smooth peaks with sharp medial ridges (CNC V-carve style).
 * @param {number}  [opts.reliefRange=6] - carve depth cap, in multiples of edgeFalloff
 * @param {number}  [opts.heightSmoothWeight=0.5] - influence of each height blur pass
 * @param {'cpu'}    [opts.fieldBackend='cpu'] - sync builds always use CPU field rasterization
 * @returns {BufferGeometry}
 */
export function buildSigilGeometry(paths, opts = {}) {
  const prepared = prepareFieldInput(paths, opts);
  const field = new DistanceField(prepared.set, prepared.fieldOpts);
  const geo = finishSigilGeometry(field, prepared, opts);
  geo.userData.fieldBackend = 'cpu';
  return geo;
}

/**
 * Async geometry build that can move raw distance-field rasterization to WebGPU.
 * Marching squares and solidification stay CPU-side because they emit variable
 * topology.
 *
 * @param {*} paths - one stroke or an array of strokes (see toPathSet)
 * @param {object} [opts]
 * @param {'cpu'|'gpu'|'hybrid'} [opts.fieldBackend='cpu']
 * @param {import('three/webgpu').WebGPURenderer} [opts.renderer]
 * @param {(error: Error) => void} [opts.onGpuFallback]
 * @returns {Promise<BufferGeometry>}
 */
export async function buildSigilGeometryAsync(paths, opts = {}) {
  const prepared = prepareFieldInput(paths, opts);
  const wantsGpu = opts.fieldBackend === 'gpu' || opts.fieldBackend === 'hybrid';
  let field = null;
  let backend = 'cpu';
  let computeRenderer = opts.renderer;

  if (wantsGpu && computeRenderer) {
    try {
      field = await buildGpuDistanceField(computeRenderer, prepared.set, prepared.fieldOpts);
      backend = 'gpu';
    } catch (error) {
      // Do not immediately hit the same broken device again in the laplacian
      // stage. The CPU field/topology tail remains a complete fallback.
      computeRenderer = null;
      if (opts.onGpuFallback) opts.onGpuFallback(error);
      else console.warn('sigils: GPU distance field failed; falling back to CPU.', error);
    }
  }

  if (!field) field = new DistanceField(prepared.set, prepared.fieldOpts);
  const geo = await finishSigilGeometryAsync(field, prepared,
    computeRenderer === opts.renderer ? opts : { ...opts, renderer: computeRenderer });
  geo.userData.fieldBackend = backend;
  return geo;
}

/**
 * Turn a distance field (CPU or GPU-readback) into chrome-ready fill mesh.
 *
 * @param {import('./distanceField.js').DistanceField|object} field
 * @param {object} [opts]
 * @returns {BufferGeometry}
 */
export function finishSigilGeometryFromField(field, opts = {}) {
  const prepared = preparedFromFieldOptions(opts);
  return finishSigilGeometry(field, prepared, normalizedFieldOptions(opts));
}

/**
 * Async field-to-mesh tail. This is the path GPU field builders should use so
 * the many-pass laplacian blur also remains on WebGPU instead of silently
 * dropping back to the synchronous CPU implementation.
 */
export async function finishSigilGeometryFromFieldAsync(field, opts = {}) {
  const prepared = preparedFromFieldOptions(opts);
  return finishSigilGeometryAsync(field, prepared, normalizedFieldOptions(opts));
}

function preparedFromFieldOptions(opts) {
  const thickness = opts.thickness ?? opts.fieldRangeMax ?? 0.14;
  return {
    threshold: opts.threshold ?? thickness * 0.5,
    smooth: opts.smooth ?? opts.fieldSmooth ?? 3,
    boundaryFalloff: opts.edgeFalloff ?? opts.boundaryFalloff ?? thickness * 0.5,
  };
}

function normalizedFieldOptions(opts) {
  return {
    depthMode: 'boundary',
    heightSmooth: opts.heightSmooth ?? 2,
    laplacian: opts.laplacian ?? opts.fieldLaplacian ?? 36,
    laplacianWeight: opts.laplacianWeight ?? opts.fieldBlendStrength ?? 0.75,
    base: opts.base ?? opts.baseDepth ?? 0,
    ...opts,
  };
}

function prepareFieldInput(paths, opts) {
  const prepared = prepareStrokes(paths, opts);
  return {
    set: prepared.set,
    threshold: prepared.threshold,
    smooth: prepared.smooth,
    boundaryFalloff: prepared.boundaryFalloff,
    fieldOpts: prepared.fieldOpts,
  };
}

function finishSigilGeometry(field, prepared, opts) {
  const region = buildFillRegion(field, prepared, opts);
  if (!region) return new BufferGeometry();

  // Point-position blur gives the filled marching-squares result its melted,
  // logo-like sigil shape instead of a literal fattened stroke.
  const laplacian = Math.max(0, Math.floor(opts.laplacian ?? 0));
  let adjacency = null;
  if (laplacian > 0) {
    adjacency = blurRegionPositions(region, laplacian, opts.laplacianWeight ?? 1);
  }

  return regionToGeometry(region, field, prepared, opts, adjacency);
}

/**
 * Async twin of {@link finishSigilGeometry}: identical pipeline, but the laplacian
 * point-blur — the heaviest CPU loop, default 36 passes over every vertex — runs
 * on the GPU when `opts.renderer` is a WebGPURenderer, falling back to the CPU
 * blur on any failure. Marching squares, boundary depth and solidify stay on the
 * CPU because they emit variable topology.
 */
async function finishSigilGeometryAsync(field, prepared, opts) {
  const region = buildFillRegion(field, prepared, opts);
  if (!region) return new BufferGeometry();

  const laplacian = Math.max(0, Math.floor(opts.laplacian ?? 0));
  let laplacianBackend = 'none';
  let adjacency = null;
  if (laplacian > 0) {
    const weight = opts.laplacianWeight ?? 1;
    if (opts.renderer && typeof opts.renderer.computeAsync === 'function') {
      try {
        const packedAdjacency = buildPackedAdjacency(region.count, region.indices);
        adjacency = packedAdjacency.neighbors;
        await gpuBlurRegionPositions(opts.renderer, region, laplacian, weight, packedAdjacency);
        laplacianBackend = 'gpu';
      } catch (error) {
        if (opts.onGpuFallback) opts.onGpuFallback(error);
        else console.warn('sigils: GPU laplacian failed; using CPU.', error);
      }
    }
    if (laplacianBackend !== 'gpu') {
      adjacency = blurRegionPositions(region, laplacian, weight, adjacency);
      laplacianBackend = 'cpu';
    }
  }

  const geo = regionToGeometry(region, field, prepared, opts, adjacency);
  geo.userData.laplacianBackend = laplacianBackend;
  return geo;
}

/**
 * Marching-squares fill of the implicit field. Returns null when nothing crosses
 * the threshold so callers can emit an empty geometry rather than throw.
 */
function buildFillRegion(field, prepared, opts) {
  const { threshold, smooth } = prepared;
  const fieldSmooth = Math.max(0, Math.floor(smooth));
  const mergeScale = Math.max(1, opts.fieldMergeBlendScale ?? 8);
  const depthMode = opts.depthMode ?? 'boundary';
  const laplacian = Math.max(0, Math.floor(opts.laplacian ?? 0));
  // Boundary depth replaces every depth/gradient after topology extraction.
  // Centerline depth is also resampled after laplacian moves the vertices.
  const needsInitialDepth = depthMode !== 'boundary' && laplacian === 0;
  const region = fillRegion(field, threshold, fieldSmooth, mergeScale, needsInitialDepth);
  return region.count === 0 ? null : region;
}

/**
 * Shared tail of both finish paths: boundary (or centerline) depth, then
 * solidify into the domed shell. Runs after the CPU/GPU laplacian blur has
 * settled `region.positions`.
 */
function regionToGeometry(region, field, prepared, opts, adjacency = null) {
  const { threshold, smooth } = prepared;
  const fieldSmooth = Math.max(0, Math.floor(smooth));
  const laplacian = Math.max(0, Math.floor(opts.laplacian ?? 0));

  // The vertical profile is driven from distance to the finished boundary edge.
  // The older centerline field is still available, but boundary depth handles
  // crossings and interiors more like the final raised surface.
  const depthMode = opts.depthMode ?? 'boundary';
  if (depthMode === 'boundary') {
    const falloff = prepared.boundaryFalloff ?? opts.edgeFalloff ?? threshold;
    applyBoundaryDepth(region, falloff, field, threshold, {
      heightSmooth: Math.max(0, Math.floor(opts.heightSmooth ?? 0)),
      heightSmoothWeight: opts.heightSmoothWeight ?? 0.5,
      fieldSmooth,
      depthBlendScale: Math.max(1, opts.fieldDepthBlendScale ?? 6),
      relief: opts.relief ?? 'plateau',
      reliefRange: opts.reliefRange ?? 6,
    }, adjacency);
  } else if (laplacian > 0) {
    resampleCenterlineDepth(region, field, threshold);
  }

  // solidify into top dome (+ optional walls and base).
  const base = Math.max(0, opts.base ?? 0);
  return solidify(region, base);
}

/**
 * Returns the adjacency it built (or null when the blur is a no-op) so callers
 * can reuse it instead of rebuilding for the height smooth.
 */
function blurRegionPositions(region, iterations, weight, adjacency = null) {
  const w = clamp01(weight);
  if (iterations <= 0 || w <= 0) return null;

  const { positions, indices, count } = region;
  adjacency ??= buildAdjacency(count, indices);
  let x = new Float32Array(count);
  let y = new Float32Array(count);
  let nx = new Float32Array(count);
  let ny = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    x[i] = positions[i * 3];
    y[i] = positions[i * 3 + 1];
  }

  for (let pass = 0; pass < iterations; pass++) {
    for (let i = 0; i < count; i++) {
      const neighbors = adjacency[i];
      if (!neighbors || neighbors.length === 0) {
        nx[i] = x[i];
        ny[i] = y[i];
        continue;
      }
      let sx = 0, sy = 0;
      for (let k = 0; k < neighbors.length; k++) {
        const j = neighbors[k];
        sx += x[j];
        sy += y[j];
      }
      const inv = 1 / neighbors.length;
      nx[i] = x[i] + (sx * inv - x[i]) * w;
      ny[i] = y[i] + (sy * inv - y[i]) * w;
    }
    [x, nx] = [nx, x];
    [y, ny] = [ny, y];
  }

  for (let i = 0; i < count; i++) {
    positions[i * 3] = x[i];
    positions[i * 3 + 1] = y[i];
  }
  return adjacency;
}

function applyBoundaryDepth(region, falloff, field, threshold, opts, adjacency = null) {
  const { heightSmooth, heightSmoothWeight, fieldSmooth, depthBlendScale, relief, reliefRange } = opts;
  const { positions, depth, grad, boundary, count, indices } = region;
  if (!boundary || boundary.length === 0) {
    depth.fill(1);
    grad.fill(0);
    return;
  }

  const width = Math.max(1e-6, falloff);
  const carve = relief === 'carve';
  // Carve keeps depth rising past the falloff so wide junctions turn into peaks
  // (sharp ridges along the medial axis); plateau clamps at 1 like a flat mesa.
  const cap = carve ? width * Math.max(1, reliefRange ?? 6) : width;
  const bfield = makeBoundaryField(positions, boundary, width);
  const depthBlend = fieldSmooth > 0 ? Math.min(1, fieldSmooth / depthBlendScale) : 0;
  const pinned = boundaryVertexMask(boundary, count);

  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    let d = boundaryDistance(x, y, bfield, cap) / width;
    if (!carve) d = Math.min(1, d);
    if (depthBlend > 0 && field?.depth) {
      // The field blend softens merge seams near the rim. Its source is a 0..1
      // spine field, so above the rim band it would flatten carve peaks —
      // fade it out as depth passes 1.
      const blend = carve ? depthBlend * clamp01(2 - d) : depthBlend;
      if (blend > 0) {
        const fd = field.depth(x, y, threshold);
        d = Math.min(d, d * (1 - blend) + fd * blend);
      }
    }
    depth[i] = d;
  }
  pinBoundaryDepth(depth, pinned);

  if (heightSmooth > 0) {
    smoothVertexScalar(depth, adjacency ?? buildAdjacency(count, indices), heightSmooth, clamp01(heightSmoothWeight ?? 0.5), pinned);
  }

  computeScalarGradient(positions, indices, depth, grad, count);
}

function resampleCenterlineDepth(region, field, threshold) {
  const { positions, depth, grad, count } = region;
  const gradStep = field.cell * 1.25;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    depth[i] = field.depth(x, y, threshold);
    const [gx, gy] = field.depthGradient(x, y, threshold, gradStep);
    grad[i * 2] = gx;
    grad[i * 2 + 1] = gy;
  }
}

function buildAdjacency(count, indices) {
  return buildNeighborLists(count, indices);
}

function smoothVertexScalar(values, adjacency, iterations, weight, pinned = null) {
  const w = clamp01(weight);
  const tmp = new Float32Array(values.length);
  for (let pass = 0; pass < iterations; pass++) {
    for (let i = 0; i < values.length; i++) {
      if (pinned?.[i]) {
        tmp[i] = 0;
        continue;
      }
      const neighbors = adjacency[i];
      if (!neighbors || neighbors.length === 0) {
        tmp[i] = values[i];
        continue;
      }
      let sum = 0;
      for (let k = 0; k < neighbors.length; k++) sum += values[neighbors[k]];
      const avg = sum / neighbors.length;
      tmp[i] = values[i] + (avg - values[i]) * w;
    }
    values.set(tmp);
  }
}

function boundaryVertexMask(boundary, count) {
  const mask = new Uint8Array(count);
  for (const [a, b] of boundary) {
    mask[a] = 1;
    mask[b] = 1;
  }
  return mask;
}

function pinBoundaryDepth(depth, pinned) {
  for (let i = 0; i < pinned.length; i++) {
    if (pinned[i]) depth[i] = 0;
  }
}

function makeBoundaryField(positions, boundary, falloff) {
  const segments = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [a, b] of boundary) {
    const ax = positions[a * 3], ay = positions[a * 3 + 1];
    const bx = positions[b * 3], by = positions[b * 3 + 1];
    const vx = bx - ax, vy = by - ay;
    segments.push([ax, ay, vx, vy, vx * vx + vy * vy]);
    minX = Math.min(minX, ax, bx);
    minY = Math.min(minY, ay, by);
    maxX = Math.max(maxX, ax, bx);
    maxY = Math.max(maxY, ay, by);
  }

  // A finer lookup grid keeps each query's candidate list short. Expanding
  // rings still make the result exact, while quarter-falloff cells were the
  // best balance across plateau and six-falloff carve searches.
  const cell = Math.max(falloff * 0.25, 1e-6);
  const buckets = new Map();
  const ix = (x) => Math.floor((x - minX) / cell);
  const iy = (y) => Math.floor((y - minY) / cell);
  const nx = ix(maxX) + 1;
  const ny = iy(maxY) + 1;

  for (let s = 0; s < segments.length; s++) {
    const [ax, ay, vx, vy] = segments[s];
    const bx = ax + vx, by = ay + vy;
    const x0 = ix(Math.min(ax, bx));
    const x1 = ix(Math.max(ax, bx));
    const y0 = iy(Math.min(ay, by));
    const y1 = iy(Math.max(ay, by));
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const key = i * ny + j;
        let list = buckets.get(key);
        if (!list) buckets.set(key, list = []);
        list.push(s);
      }
    }
  }

  // stamp array instead of a per-query Set: segments span multiple cells
  const stamps = new Uint32Array(segments.length);
  return { segments, buckets, minX, minY, cell, nx, ny, ix, iy, stamps, stamp: 0 };
}

/**
 * Nearest-boundary distance, capped at `cap`. Cells are scanned in expanding
 * Chebyshev rings; after ring r every unscanned segment is at least r*cell
 * away, so the search stops as soon as the current best is within that bound.
 */
function boundaryDistance(x, y, field, cap) {
  const { cell } = field;
  const cx = field.ix(x);
  const cy = field.iy(y);
  const maxRing = Math.ceil(cap / cell) + 1;
  let best = cap * cap;
  const stamp = ++field.stamp;

  for (let ring = 0; ring <= maxRing; ring++) {
    if (ring === 0) {
      best = scanBoundaryBucket(field, cx, cy, x, y, best, stamp);
    } else {
      for (let i = cx - ring; i <= cx + ring; i++) {
        best = scanBoundaryBucket(field, i, cy - ring, x, y, best, stamp);
        best = scanBoundaryBucket(field, i, cy + ring, x, y, best, stamp);
      }
      for (let j = cy - ring + 1; j <= cy + ring - 1; j++) {
        best = scanBoundaryBucket(field, cx - ring, j, x, y, best, stamp);
        best = scanBoundaryBucket(field, cx + ring, j, x, y, best, stamp);
      }
    }
    const guard = ring * cell;
    if (best <= guard * guard) break;
  }

  return Math.sqrt(best);
}

function scanBoundaryBucket(field, i, j, x, y, best, stamp) {
  if (i < 0 || j < 0 || i >= field.nx || j >= field.ny) return best;
  const list = field.buckets.get(i * field.ny + j);
  if (!list) return best;
  const { segments, stamps } = field;
  for (let k = 0; k < list.length; k++) {
    const si = list[k];
    if (stamps[si] === stamp) continue;
    stamps[si] = stamp;
    const d2 = distToPreparedSegment2(x, y, segments[si]);
    if (d2 < best) best = d2;
  }
  return best;
}

function distToPreparedSegment2(px, py, segment) {
  const ax = segment[0], ay = segment[1];
  const vx = segment[2], vy = segment[3];
  const wx = px - ax, wy = py - ay;
  const len2 = segment[4];
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  return dx * dx + dy * dy;
}

function computeScalarGradient(positions, indices, values, grad, count) {
  grad.fill(0);
  const weight = new Float32Array(count);

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const ax = positions[a * 3], ay = positions[a * 3 + 1];
    const bx = positions[b * 3], by = positions[b * 3 + 1];
    const cx = positions[c * 3], cy = positions[c * 3 + 1];
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(det) < 1e-12) continue;

    const db = values[b] - values[a];
    const dc = values[c] - values[a];
    const gx = (db * (cy - ay) - dc * (by - ay)) / det;
    const gy = ((bx - ax) * dc - (cx - ax) * db) / det;
    const area = Math.abs(det) * 0.5;

    grad[a * 2] += gx * area; grad[a * 2 + 1] += gy * area; weight[a] += area;
    grad[b * 2] += gx * area; grad[b * 2 + 1] += gy * area; weight[b] += area;
    grad[c * 2] += gx * area; grad[c * 2 + 1] += gy * area; weight[c] += area;
  }

  for (let i = 0; i < count; i++) {
    if (weight[i] <= 0) continue;
    grad[i * 2] /= weight[i];
    grad[i * 2 + 1] /= weight[i];
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Turn the flat fill into geometry attributes. With base > 0 we add a flat
 * bottom and extruded side walls so the result is a closed solid.
 */
function solidify(region, base) {
  const { positions, depth, grad, indices, boundary, count } = region;
  const walls = [];
  let wallVertices = 0;
  let wallIndices = 0;

  if (base > 0) {
    for (const loop of boundaryLoops(boundary)) {
      if (loop.length < 2) continue;
      const closed = loop.length > 2 && loop[0] === loop[loop.length - 1];
      const verts = closed ? loop.slice(0, -1) : loop;
      if (verts.length < 2) continue;
      walls.push({ verts, closed });
      wallVertices += verts.length * 2;
      wallIndices += (closed ? verts.length : verts.length - 1) * 6;
    }
  }

  // Exact-size typed output avoids building six large boxed-number arrays and
  // copying each of them again at the end of every rebuild.
  const vertexCount = count + (base > 0 ? count + wallVertices : 0);
  const indexCount = indices.length + (base > 0 ? indices.length + wallIndices : 0);
  const pos = new Float32Array(vertexCount * 3);
  const dep = new Float32Array(vertexCount);
  const gra = new Float32Array(vertexCount * 2);
  const nrm = new Float32Array(vertexCount * 3);
  const dome = new Float32Array(vertexCount);
  const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
  const idx = new IndexArray(indexCount);

  // -- top surface: domed, normals computed in the shader --
  for (let k = 0; k < count; k++) {
    const k2 = k * 2;
    const k3 = k * 3;
    pos[k3] = positions[k3];
    pos[k3 + 1] = positions[k3 + 1];
    dep[k] = depth[k];
    gra[k2] = grad[k2];
    gra[k2 + 1] = grad[k2 + 1];
    nrm[k3 + 2] = 1;
    dome[k] = 1;
  }
  idx.set(indices);

  if (base > 0) {
    // -- flat base: copy of the top XY at z = -base, reversed winding --
    const baseOffset = count;
    for (let k = 0; k < count; k++) {
      const src = k * 3;
      const dst = (baseOffset + k) * 3;
      pos[dst] = positions[src];
      pos[dst + 1] = positions[src + 1];
      pos[dst + 2] = -base;
      nrm[dst + 2] = -1;
    }
    let indexOffset = indices.length;
    for (let t = 0; t < indices.length; t += 3) {
      idx[indexOffset++] = baseOffset + indices[t];
      idx[indexOffset++] = baseOffset + indices[t + 2];
      idx[indexOffset++] = baseOffset + indices[t + 1];
    }

    let vertexOffset = count * 2;
    for (const { verts, closed } of walls) {
      const normals = sideLoopNormals(verts, positions, closed);
      const topOffset = vertexOffset;
      for (let i = 0; i < verts.length; i++) {
        const source = verts[i] * 3;
        const target = vertexOffset++ * 3;
        pos[target] = positions[source];
        pos[target + 1] = positions[source + 1];
        nrm[target] = normals[i * 2];
        nrm[target + 1] = normals[i * 2 + 1];
      }

      const bottomOffset = vertexOffset;
      for (let i = 0; i < verts.length; i++) {
        const source = verts[i] * 3;
        const target = vertexOffset++ * 3;
        pos[target] = positions[source];
        pos[target + 1] = positions[source + 1];
        pos[target + 2] = -base;
        nrm[target] = normals[i * 2];
        nrm[target + 1] = normals[i * 2 + 1];
      }

      const limit = closed ? verts.length : verts.length - 1;
      for (let i = 0; i < limit; i++) {
        const j = (i + 1) % verts.length;
        const topA = topOffset + i;
        const topB = topOffset + j;
        const botA = bottomOffset + i;
        const botB = bottomOffset + j;
        idx[indexOffset++] = topA;
        idx[indexOffset++] = botB;
        idx[indexOffset++] = topB;
        idx[indexOffset++] = topA;
        idx[indexOffset++] = botA;
        idx[indexOffset++] = botB;
      }
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('aDepth', new BufferAttribute(dep, 1));
  geo.setAttribute('aGrad', new BufferAttribute(gra, 2));
  geo.setAttribute('aNormal', new BufferAttribute(nrm, 3));
  geo.setAttribute('aDome', new BufferAttribute(dome, 1));
  // A plausible static normal so non-node renderers / pickers still work.
  geo.setAttribute('normal', new BufferAttribute(nrm.slice(), 3));
  geo.setIndex(new BufferAttribute(idx, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function boundaryLoops(boundary) {
  const outgoing = new Map();
  const adjacency = new Map();
  const unused = new Set();

  const addOutgoing = (a, b) => {
    let list = outgoing.get(a);
    if (!list) outgoing.set(a, list = []);
    list.push(b);
  };
  const addAdjacent = (a, b) => {
    let list = adjacency.get(a);
    if (!list) adjacency.set(a, list = []);
    list.push(b);
  };

  // Numeric edge ids: a * stride + b. Vertex counts stay well under 1e6, so
  // stride^2 fits comfortably inside Number.MAX_SAFE_INTEGER.
  let stride = 1;
  for (const [a, b] of boundary) stride = Math.max(stride, a + 1, b + 1);
  const edgeKey = (a, b) => a * stride + b;

  for (const [a, b] of boundary) {
    addOutgoing(a, b);
    addAdjacent(a, b);
    addAdjacent(b, a);
    unused.add(edgeKey(a, b));
  }

  // Consume the first still-unused outgoing edge, removing it from the list so
  // later walks stop re-scanning used edges.
  const takeOutgoing = (from) => {
    const list = outgoing.get(from);
    if (!list) return undefined;
    for (let k = 0; k < list.length; k++) {
      const candidate = list[k];
      if (unused.has(edgeKey(from, candidate))) {
        list.splice(k, 1);
        return candidate;
      }
    }
    return undefined;
  };

  const loops = [];
  while (unused.size) {
    const first = unused.values().next().value;
    const a0 = Math.floor(first / stride);
    const b0 = first % stride;
    unused.delete(first);

    const loop = [a0, b0];
    let curr = b0;

    while (true) {
      const next = takeOutgoing(curr);

      if (next === undefined) break;
      unused.delete(edgeKey(curr, next));
      loop.push(next);
      curr = next;
      if (curr === loop[0]) break;
    }

    if (loop[loop.length - 1] !== loop[0]) {
      curr = a0;
      while (true) {
        const next = (adjacency.get(curr) || []).find((candidate) => {
          return unused.has(edgeKey(candidate, curr)) || unused.has(edgeKey(curr, candidate));
        });

        if (next === undefined) break;
        unused.delete(edgeKey(next, curr));
        unused.delete(edgeKey(curr, next));
        loop.unshift(next);
        curr = next;
      }
    }

    loops.push(loop);
  }

  return loops;
}

function sideLoopNormals(verts, positions, closed) {
  const normals = new Float32Array(verts.length * 2);
  const segmentCount = closed ? verts.length : verts.length - 1;

  for (let i = 0; i < segmentCount; i++) {
    const j = (i + 1) % verts.length;
    const a = verts[i];
    const b = verts[j];
    const ax = positions[a * 3], ay = positions[a * 3 + 1];
    const bx = positions[b * 3], by = positions[b * 3 + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len <= 1e-8) continue;

    const nx = dy / len;
    const ny = -dx / len;
    normals[i * 2] += nx;
    normals[i * 2 + 1] += ny;
    normals[j * 2] += nx;
    normals[j * 2 + 1] += ny;
  }

  for (let i = 0; i < verts.length; i++) {
    let nx = normals[i * 2];
    let ny = normals[i * 2 + 1];
    const len = Math.hypot(nx, ny);
    if (len > 1e-8) {
      nx /= len;
      ny /= len;
    } else {
      nx = 1;
      ny = 0;
    }
    normals[i * 2] = nx;
    normals[i * 2 + 1] = ny;
  }

  return normals;
}
