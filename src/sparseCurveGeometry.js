import { BufferAttribute, BufferGeometry, Float32BufferAttribute } from 'three';
import { resampleByLength, toPathSet } from './internal/paths.js';
import { buildGpuFieldMeshAsync } from './gpuFieldMesh.js';
import { buildAdjacency } from './gpuSigilize.js';

const TAU = Math.PI * 2;
const DEFAULT_PROFILE = [
  -1, -0.94, -0.80, -0.58, -0.34, -0.12, 0,
  0, 0.12, 0.34, 0.58, 0.80, 0.94, 1,
];

/**
 * Build sparse raised curve strips for realtime drawing or large imported
 * curve sets. This is intentionally curve-native: it emits triangles only near
 * strokes and never rasterizes empty space.
 *
 * @param {*} paths - one stroke or an array of strokes
 * @param {object} [opts]
 * @param {number} [opts.symmetry=1] - radial copies
 * @param {number} [opts.phase=0] - global rotation, radians
 * @param {boolean} [opts.mirror=false] - add mirrored copies
 * @param {[number, number]} [opts.center=[0,0]] - symmetry pivot
 * @param {number} [opts.thickness=0.07] - curve width
 * @param {number} [opts.spread=0] - extra curve width
 * @param {number} [opts.peakHeight=0.13] - raised profile height
 * @param {number} [opts.resample=0.03] - point spacing before meshing
 * @param {number} [opts.simplify=0.006] - polyline simplification tolerance
 * @param {number} [opts.taperLen=0.35] - open-end taper length
 * @param {number} [opts.taperPower=1.8] - open-end taper exponent
 * @param {number} [opts.tipRadius=0.004] - minimum half-width at open tips
 * @param {number} [opts.ridgePower=1] - height falloff from center to rim
 * @param {number} [opts.bevel=0.12] - rim rounding width in normalized profile units
 * @param {number} [opts.heightSmooth=0] - height blur iterations before normals
 * @param {number} [opts.heightSmoothWeight=1] - height blur influence per pass
 * @param {number} [opts.baseDepth=0.018] - flat underside depth, 0 disables sides
 * @param {number[]} [opts.profile] - normalized cross samples from -1 to 1
 * @param {number[]} [opts.profile] - normalized cross samples from -1 to 1
 * @returns {BufferGeometry}
 */
export function buildSparseCurveGeometry(paths, opts = {}) {
  const pathSet = toPathSet(paths);
  const positions = [];
  const uvs = [];
  const depths = [];
  const domes = [];
  const normals = [];
  const indices = [];
  let baseSegments = 0;
  let drawnSegments = 0;

  const symmetry = Math.max(1, Math.floor(opts.symmetry ?? 1));
  const mirror = opts.mirror === true;

  for (const stroke of pathSet) {
    const path = processStroke(stroke, opts);
    if (!path) continue;

    const segs = path.closed ? path.points.length : path.points.length - 1;
    baseSegments += segs;

    for (let k = 0; k < symmetry; k++) {
      appendCurve(path, k, false, positions, uvs, depths, domes, normals, indices, opts);
      drawnSegments += segs;
      if (mirror) {
        appendCurve(path, k, true, positions, uvs, depths, domes, normals, indices, opts);
        drawnSegments += segs;
      }
    }
  }

  const geometry = new BufferGeometry();
  const vertCount = positions.length / 3;
  const topStride = profileSamples(opts).length;
  const hasBase = (opts.baseDepth ?? 0.018) > 0;
  const rowStride = topStride + (hasBase ? 4 : 0);
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aDepth', new Float32BufferAttribute(depths, 1));
  geometry.setAttribute('aDome', new Float32BufferAttribute(domes, 1));
  geometry.setAttribute('aNormal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('aGrad', new Float32BufferAttribute(new Float32Array(vertCount * 2), 2));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  const indexArray = vertCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  geometry.setIndex(new BufferAttribute(indexArray, 1));
  computeDepthGradient(geometry);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  geometry.userData.sparseCurveStats = {
    baseSegments,
    drawnSegments,
    vertices: vertCount,
    profileSamples: topStride,
  };
  geometry.userData.sparseCurveLayout = { topStride, rowStride, hasBase };
  return geometry;
}

/**
 * Realtime build: GPU SDF field + marching-squares fill (merged topology).
 * Falls back to sparse strips when `opts.fieldMesh === false`.
 */
export async function buildSparseCurveGeometryAsync(renderer, paths, opts = {}) {
  if (opts.fieldMesh !== false && renderer) {
    return buildGpuFieldMeshAsync(renderer, paths, {
      ...opts,
      taper: opts.taper ?? 1,
      taperPower: opts.taperPower ?? 0.6,
      sigilize: opts.fieldSigilize ?? opts.sigilize ?? 36,
      sigilizeWeight: opts.sigilizeWeight ?? opts.fieldBlendStrength ?? 0.75,
      base: opts.base ?? opts.baseDepth ?? 0.08,
      heightSmooth: opts.heightSmooth ?? 2,
    });
  }
  return buildSparseCurveGeometry(paths, opts);
}

function processStroke(stroke, opts) {
  if (!stroke || stroke.length < 2) return null;

  const resample = opts.resample ?? 0.03;
  const sampled = resampleByLength(stroke, resample);
  if (sampled.length < 2) return null;

  const rawClosed = Math.hypot(
    sampled[0][0] - sampled[sampled.length - 1][0],
    sampled[0][1] - sampled[sampled.length - 1][1],
  ) <= resample * 1.5;

  let points = rawClosed ? sampled.slice(0, -1) : sampled;
  if (!rawClosed) points = simplifyPolyline(points, opts.simplify ?? 0.006);
  if (points.length < 2) return null;

  const distance = [0];
  for (let i = 1; i < points.length; i++) {
    distance.push(distance[i - 1] + Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
    ));
  }

  const closing = rawClosed
    ? Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1])
    : 0;
  const total = distance[distance.length - 1] + closing;

  return { points, distance, total, closed: rawClosed };
}

function appendCurve(path, sectorIndex, mirrored, positions, uvs, depths, domes, normals, indices, opts) {
  const profile = profileSamples(opts);
  const topStride = profile.length;
  const hasBase = (opts.baseDepth ?? 0.018) > 0;
  const rowStride = topStride + (hasBase ? 4 : 0);
  const start = positions.length / 3;
  const count = path.points.length;
  const peak = opts.peakHeight ?? opts.peak ?? 0.13;
  const baseDepth = Math.max(0, opts.baseDepth ?? 0.018);
  const rows = [];
  const heights = new Float32Array(count * topStride);

  for (let i = 0; i < count; i++) {
    const p = transformPoint(path.points[i], sectorIndex, mirrored, opts);
    const prevIndex = path.closed ? (i - 1 + count) % count : Math.max(0, i - 1);
    const nextIndex = path.closed ? (i + 1) % count : Math.min(count - 1, i + 1);
    const pPrev = transformPoint(path.points[prevIndex], sectorIndex, mirrored, opts);
    const pNext = transformPoint(path.points[nextIndex], sectorIndex, mirrored, opts);
    let tx = pNext[0] - pPrev[0];
    let ty = pNext[1] - pPrev[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;

    const nx = -ty;
    const ny = tx;
    const half = pointHalfWidth(path, i, opts);
    const along = path.total > 0 ? path.distance[i] / path.total : 0;
    rows.push({ p, nx, ny, half, along });

    for (let c = 0; c < topStride; c++) {
      heights[i * topStride + c] = peak * profileDepth(profile[c], opts);
    }
  }

  smoothHeights(heights, profile, count, topStride, path.closed, opts);

  for (let i = 0; i < count; i++) {
    const row = rows[i];

    for (let c = 0; c < topStride; c++) {
      const cross = profile[c];
      const depth = peak > 0 ? heights[i * topStride + c] / peak : 0;
      positions.push(
        row.p[0] + row.nx * row.half * cross,
        row.p[1] + row.ny * row.half * cross,
        0,
      );
      uvs.push(row.along, cross * 0.5 + 0.5);
      depths.push(depth);
      domes.push(1);
      normals.push(0, 0, 1);
    }

    if (hasBase) {
      const lx = row.p[0] - row.nx * row.half;
      const ly = row.p[1] - row.ny * row.half;
      const rx = row.p[0] + row.nx * row.half;
      const ry = row.p[1] + row.ny * row.half;
      positions.push(lx, ly, 0, lx, ly, -baseDepth, rx, ry, 0, rx, ry, -baseDepth);
      uvs.push(row.along, 0, row.along, 0, row.along, 1, row.along, 1);
      for (let k = 0; k < 4; k++) {
        depths.push(0);
        domes.push(0);
      }
      normals.push(-row.nx, -row.ny, 0, -row.nx, -row.ny, 0, row.nx, row.ny, 0, row.nx, row.ny, 0);
    }
  }

  const flip = mirrored;
  const segCount = path.closed ? count : count - 1;
  for (let i = 0; i < segCount; i++) {
    const j = (i + 1) % count;
    const a = start + i * rowStride;
    const b = start + j * rowStride;

    for (let c = 0; c + 1 < topStride; c++) {
      if (profile[c] === profile[c + 1]) continue;
      pushTri(indices, flip, a + c, b + c, a + c + 1);
      pushTri(indices, flip, a + c + 1, b + c, b + c + 1);
    }

    if (!hasBase) continue;

    const sideA = a + topStride;
    const sideB = b + topStride;
    const lt = sideA;
    const lb = sideA + 1;
    const rt = sideA + 2;
    const rb = sideA + 3;
    const ltNext = sideB;
    const lbNext = sideB + 1;
    const rtNext = sideB + 2;
    const rbNext = sideB + 3;

    pushTri(indices, flip, lt, lb, ltNext);
    pushTri(indices, flip, lb, lbNext, ltNext);
    pushTri(indices, flip, rt, rtNext, rb);
    pushTri(indices, flip, rb, rtNext, rbNext);
    pushTri(indices, flip, lb, rb, lbNext);
    pushTri(indices, flip, rb, rbNext, lbNext);
  }
}

function smoothHeights(values, profile, count, stride, closed, opts) {
  const iterations = Math.max(0, Math.floor(opts.heightSmooth ?? opts.smoothHeight ?? 0));
  const weight = clamp01(opts.heightSmoothWeight ?? 1);
  if (iterations <= 0 || weight <= 0 || count <= 1 || stride <= 1) return;

  let source = values;
  let target = new Float32Array(values.length);

  for (let pass = 0; pass < iterations; pass++) {
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < stride; c++) {
        const index = i * stride + c;
        let sum = 0;
        let n = 0;

        const prev = i - 1;
        const next = i + 1;
        if (prev >= 0) {
          sum += source[prev * stride + c];
          n++;
        } else if (closed) {
          sum += source[(count - 1) * stride + c];
          n++;
        }

        if (next < count) {
          sum += source[next * stride + c];
          n++;
        } else if (closed) {
          sum += source[c];
          n++;
        }

        if (c > 0 && profile[c - 1] !== profile[c]) {
          sum += source[index - 1];
          n++;
        }
        if (c + 1 < stride && profile[c + 1] !== profile[c]) {
          sum += source[index + 1];
          n++;
        }

        target[index] = n > 0 ? source[index] + ((sum / n) - source[index]) * weight : source[index];
      }
    }
    [source, target] = [target, source];
  }

  if (source !== values) values.set(source);
}

function pointHalfWidth(path, i, opts) {
  const baseHalf = (opts.thickness ?? 0.07) * 0.5 + (opts.spread ?? 0) * 0.08;
  if (path.closed) return baseHalf;
  const terminalDistance = Math.min(path.distance[i], path.total - path.distance[i]);
  const taperLen = Math.max(opts.taperLen ?? 0.35, 1e-4);
  const t = clamp01(terminalDistance / taperLen);
  return Math.max(opts.tipRadius ?? 0.004, baseHalf * Math.pow(t, opts.taperPower ?? 1.8));
}

function profileDepth(cross, opts) {
  const edgeDistance = clamp01(1 - Math.abs(cross));
  const ridgePower = Math.max(0.25, opts.ridgePower ?? opts.ridge ?? 1);
  let depth = Math.pow(edgeDistance, ridgePower);
  const bevel = Math.max(0, opts.bevel ?? 0.12);
  if (bevel > 0) depth *= smoothstep(0, Math.min(0.45, bevel), edgeDistance);
  return depth;
}

function profileSamples(opts) {
  return opts.profile && opts.profile.length >= 3 ? opts.profile : DEFAULT_PROFILE;
}

function transformPoint(p, sectorIndex, mirrored, opts) {
  const center = opts.center ?? [0, 0];
  let x = p[0] - center[0];
  let y = p[1] - center[1];
  if (mirrored) y = -y;
  const a = (opts.phase ?? 0) + (TAU / Math.max(1, Math.floor(opts.symmetry ?? 1))) * sectorIndex;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    center[0] + x * c - y * s,
    center[1] + x * s + y * c,
  ];
}

function simplifyPolyline(points, tolerance) {
  if (points.length <= 2 || tolerance <= 0) return points;

  const keep = new Uint8Array(points.length);
  const stack = [0, points.length - 1];
  const tolSq = tolerance * tolerance;
  keep[0] = 1;
  keep[points.length - 1] = 1;

  while (stack.length) {
    const end = stack.pop();
    const start = stack.pop();
    let maxDist = -1;
    let split = -1;

    for (let i = start + 1; i < end; i++) {
      const dist = distanceToLineSq(points[i], points[start], points[end]);
      if (dist > maxDist) {
        maxDist = dist;
        split = i;
      }
    }

    if (maxDist > tolSq && split > start) {
      keep[split] = 1;
      stack.push(start, split, split, end);
    }
  }

  const simplified = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) simplified.push(points[i]);
  return simplified;
}

function distanceToLineSq(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const lenSq = abx * abx + aby * aby;
  if (lenSq <= 1e-12) return apx * apx + apy * apy;
  const t = clamp01((apx * abx + apy * aby) / lenSq);
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  return dx * dx + dy * dy;
}

function pushTri(indices, flip, a, b, c) {
  if (flip) indices.push(a, c, b);
  else indices.push(a, b, c);
}

function smoothstep(a, b, x) {
  const t = clamp01((x - a) / Math.max(1e-6, b - a));
  return t * t * (3 - 2 * t);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function computeDepthGradient(geometry) {
  const positions = geometry.getAttribute('position');
  const depth = geometry.getAttribute('aDepth');
  const grad = geometry.getAttribute('aGrad');
  const dome = geometry.getAttribute('aDome');
  const index = geometry.index;
  if (!positions || !depth || !grad || !index) return;

  const count = positions.count;
  const gra = grad.array;
  gra.fill(0);

  const { maxDeg, neighborCount, neighborIndices } = buildAdjacency(count, index.array);
  const maxLen = 8;

  for (let i = 0; i < count; i++) {
    if (dome && dome.getX(i) < 0.5) continue;

    const n = neighborCount[i];
    if (n === 0) continue;

    let gxx = 0;
    let gxy = 0;
    let gyy = 0;
    let gxd = 0;
    let gyd = 0;
    const di = depth.getX(i);
    const px = positions.getX(i);
    const py = positions.getY(i);
    const base = i * maxDeg;

    for (let k = 0; k < n; k++) {
      const j = neighborIndices[base + k];
      if (dome && dome.getX(j) < 0.5) continue;
      const dx = positions.getX(j) - px;
      const dy = positions.getY(j) - py;
      const dd = depth.getX(j) - di;
      gxx += dx * dx;
      gxy += dx * dy;
      gyy += dy * dy;
      gxd += dx * dd;
      gyd += dy * dd;
    }

    const det = gxx * gyy - gxy * gxy;
    if (Math.abs(det) < 1e-12) continue;

    let gx = (gyy * gxd - gxy * gyd) / det;
    let gy = (gxx * gyd - gxy * gxd) / det;
    const len = Math.hypot(gx, gy);
    if (len > maxLen) {
      const s = maxLen / len;
      gx *= s;
      gy *= s;
    }
    gra[i * 2] = gx;
    gra[i * 2 + 1] = gy;
  }

  grad.needsUpdate = true;
}
