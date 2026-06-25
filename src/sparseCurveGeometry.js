import { BufferAttribute, BufferGeometry, Float32BufferAttribute } from 'three';
import { resampleByLength, toPathSet } from './internal/paths.js';

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
 * @returns {BufferGeometry}
 */
export function buildSparseCurveGeometry(paths, opts = {}) {
  const pathSet = toPathSet(paths);
  const positions = [];
  const uvs = [];
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
      appendCurve(path, k, false, positions, uvs, indices, opts);
      drawnSegments += segs;
      if (mirror) {
        appendCurve(path, k, true, positions, uvs, indices, opts);
        drawnSegments += segs;
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  const indexArray = positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  geometry.setIndex(new BufferAttribute(indexArray, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  geometry.userData.sparseCurveStats = {
    baseSegments,
    drawnSegments,
    vertices: positions.length / 3,
    profileSamples: profileSamples(opts).length,
  };
  return geometry;
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

function appendCurve(path, sectorIndex, mirrored, positions, uvs, indices, opts) {
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
      positions.push(
        row.p[0] + row.nx * row.half * cross,
        row.p[1] + row.ny * row.half * cross,
        heights[i * topStride + c],
      );
      uvs.push(row.along, cross * 0.5 + 0.5);
    }

    if (hasBase) {
      const leftTop = heights[i * topStride];
      const rightTop = heights[i * topStride + topStride - 1];
      const lx = row.p[0] - row.nx * row.half;
      const ly = row.p[1] - row.ny * row.half;
      const rx = row.p[0] + row.nx * row.half;
      const ry = row.p[1] + row.ny * row.half;
      positions.push(lx, ly, leftTop, lx, ly, -baseDepth, rx, ry, rightTop, rx, ry, -baseDepth);
      uvs.push(row.along, 0, row.along, 0, row.along, 1, row.along, 1);
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
