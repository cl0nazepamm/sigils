/**
 * Scalar distance field sampled on a regular grid — the core of the
 * curve → mesh conversion.
 *
 * For every grid node we store:
 *   - `dist`   the Euclidean distance to the nearest point on any stroke.
 *   - `weight` a local half-width scale: cap taper multiplied by the optional
 *              point-radius profile. This narrows open ends and supports a
 *              non-uniform width along the centerline.
 *
 * The implicit region is `dist < threshold * weight`. Two derived quantities
 * drive the rest of the pipeline:
 *   - implicit value  g = dist - threshold*weight   (marching-squares iso = 0)
 *   - depth           clamp(1 - dist/(threshold*weight))  (0 at rim, 1 at spine)
 *
 * Sharpness vs. smoothness is split on purpose. We keep two copies of the field:
 *   - raw  `dist` / `weight`   → the SILHOUETTE (implicit iso): crisp corners,
 *                                tips and cusps.
 *   - blurred `distS`/`weightS`→ the HEIGHT and shading NORMALS: glossy metal,
 *                                no facets or washboard ripple.
 * So the outline stays razor-sharp while the surface shades smoothly.
 */

import { toPathSet, boundsOf } from './internal/paths.js';

export class DistanceField {
  /**
   * @param {*} paths - one path or an array of paths
   * @param {object} [opts]
   * @param {number} [opts.resolution=200] - grid cells across the largest dimension
   * @param {number} [opts.margin=0]       - world-unit padding around the bounds
   * @param {number} [opts.smooth=0]       - light blur passes on `dist` (de-noise only)
   * @param {number} [opts.taper=0]        - 0 = round caps, 1 = strokes taper to points
   * @param {number} [opts.taperPower=0.6] - taper profile exponent (lower = blunter)
   * @param {boolean} [opts.pointRadius=false] - interpret point[2] as a half-width scale
   */
  constructor(paths, opts = {}) {
    const {
      resolution = 200,
      margin = 0,
      smooth = 0,
      taper = 0,
      taperPower = 0.6,
      pointRadius = false,
    } = opts;
    this.taper = taper;
    this.taperPower = taperPower;
    this.pointRadius = pointRadius === true;

    const set = toPathSet(paths, { pointRadius: this.pointRadius });
    const b = boundsOf(set);
    this.minX = b.minX - margin;
    this.minY = b.minY - margin;
    const spanX = b.width + margin * 2;
    const spanY = b.height + margin * 2;
    const span = Math.max(spanX, spanY, 1e-6);

    this.cell = span / Math.max(2, resolution);
    this.width = Math.max(2, Math.ceil(spanX / this.cell) + 1);
    this.height = Math.max(2, Math.ceil(spanY / this.cell) + 1);
    this.dist = new Float32Array(this.width * this.height);
    this.weight = new Float32Array(this.width * this.height);

    this._buildSegments(set, span);
    this._rasterize();

    // Smoothed copies for height + normals; raw copies stay sharp for the outline.
    if (smooth > 0) {
      this.distS = blurArray(this.dist, this.width, this.height, smooth);
      this.weightS = blurArray(this.weight, this.width, this.height, smooth);
    } else {
      this.distS = this.dist;
      this.weightS = this.weight;
    }
  }

  /** Flatten strokes into segments carrying arc-length + closed metadata. */
  _buildSegments(set, span) {
    const ax = [], ay = [], bx = [], by = [];
    const a0 = [], len = [], plen = [], closed = [];
    const ra = [], rb = [];
    const closeEps = span * 1e-4;
    let nonUnitRadius = false;
    let maxRadius = 1;

    for (const poly of set) {
      if (poly.length < 2) continue;
      const isClosed =
        Math.hypot(poly[0][0] - poly.at(-1)[0], poly[0][1] - poly.at(-1)[1]) < closeEps;
      // arc length of this polyline
      let total = 0;
      const arc = [0];
      for (let i = 1; i < poly.length; i++) {
        total += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
        arc.push(total);
      }
      if (total <= 0) continue;
      for (let i = 1; i < poly.length; i++) {
        const radiusA = this.pointRadius ? radiusScale(poly[i - 1][2]) : 1;
        const radiusB = this.pointRadius ? radiusScale(poly[i][2]) : 1;
        ax.push(poly[i - 1][0]); ay.push(poly[i - 1][1]);
        bx.push(poly[i][0]); by.push(poly[i][1]);
        a0.push(arc[i - 1]);
        len.push(arc[i] - arc[i - 1]);
        plen.push(total);
        closed.push(isClosed ? 1 : 0);
        ra.push(radiusA); rb.push(radiusB);
        if (Math.abs(radiusA - 1) > 1e-12 || Math.abs(radiusB - 1) > 1e-12) {
          nonUnitRadius = true;
        }
        maxRadius = Math.max(maxRadius, radiusA, radiusB);
      }
    }

    // Typed storage with the segment direction and inverse squared length
    // precomputed: the rasterize loop below runs cells × segments times and
    // must not allocate or redo per-segment math per grid node.
    const count = ax.length;
    const vx = new Float64Array(count), vy = new Float64Array(count);
    const invLen2 = new Float64Array(count);
    const arc0 = new Float64Array(count), arcStep = new Float64Array(count);
    const radiusDelta = new Float64Array(count), radiusMax = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      vx[k] = bx[k] - ax[k];
      vy[k] = by[k] - ay[k];
      const l2 = vx[k] * vx[k] + vy[k] * vy[k];
      invLen2[k] = l2 > 0 ? 1 / l2 : 0;
      arc0[k] = a0[k] / plen[k];
      arcStep[k] = len[k] / plen[k];
      radiusDelta[k] = rb[k] - ra[k];
      radiusMax[k] = Math.max(ra[k], rb[k]);
    }
    this._seg = {
      ax: Float64Array.from(ax), ay: Float64Array.from(ay),
      vx, vy, invLen2,
      a0: Float64Array.from(a0), len: Float64Array.from(len),
      plen: Float64Array.from(plen), closed: Uint8Array.from(closed),
      ra: Float64Array.from(ra), rb: Float64Array.from(rb),
      arc0, arcStep, radiusDelta, radiusMax,
      nonUnitRadius, maxRadius,
      count,
    };
  }

  _rasterize() {
    const { width, height, cell, minX, minY, dist, weight } = this;
    const s = this._seg;
    const { a0, len, plen, closed, count } = s;
    const weighted = s.nonUnitRadius;
    // Under ~64 segments the brute scan beats the bucket overhead.
    const buckets = count >= 64 ? buildSegmentBuckets(this) : null;
    let bestK = -1, bestT = 0;
    for (let j = 0; j < height; j++) {
      const py = minY + j * cell;
      for (let i = 0; i < width; i++) {
        const px = minX + i * cell;
        const idx = j * width + i;
        if (weighted) {
          if (buckets) {
            nearestSegmentWeightedBucketed(px, py, s, buckets, bestK, this.taper, this.taperPower);
          } else {
            nearestSegmentWeightedBrute(px, py, s, this.taper, this.taperPower);
          }
          bestK = _nearK; bestT = _nearT;
          dist[idx] = bestK < 0 ? Infinity : Math.sqrt(_nearD2);
          weight[idx] = bestK < 0 ? 0 : _nearWeight;
        } else {
          const best = buckets
            ? nearestSegmentBucketed(px, py, s, buckets, bestK)
            : nearestSegmentBrute(px, py, s);
          bestK = _nearK; bestT = _nearT;
          dist[idx] = Math.sqrt(best);
          weight[idx] = bestK < 0
            ? 1
            : this._taperWeight((a0[bestK] + bestT * len[bestK]) / plen[bestK], closed[bestK]);
        }
      }
    }
  }

  /** Taper weight along a stroke: 1 in the middle, falling toward the ends. */
  _taperWeight(s, closed) {
    if (closed || this.taper <= 0) return 1;
    const t = s < 0 ? 0 : s > 1 ? 1 : s;
    const profile = Math.pow(Math.sin(Math.PI * t), this.taperPower);
    return 1 - this.taper * (1 - profile);
  }

  gx(x) { return (x - this.minX) / this.cell; }
  gy(y) { return (y - this.minY) / this.cell; }

  _at(arr, i, j) {
    const { width, height } = this;
    i = i < 0 ? 0 : i > width - 1 ? width - 1 : i;
    j = j < 0 ? 0 : j > height - 1 ? height - 1 : j;
    return arr[j * width + i];
  }

  _bilinear(arr, x, y) {
    const fx = this.gx(x), fy = this.gy(y);
    const i = Math.floor(fx), j = Math.floor(fy);
    const tx = fx - i, ty = fy - j;
    const v00 = this._at(arr, i, j);
    const v10 = this._at(arr, i + 1, j);
    const v01 = this._at(arr, i, j + 1);
    const v11 = this._at(arr, i + 1, j + 1);
    const a = v00 + (v10 - v00) * tx;
    const b = v01 + (v11 - v01) * tx;
    return a + (b - a) * ty;
  }

  /** Distance at integer grid coords (clamped). */
  distAt(i, j) { return this._at(this.dist, i, j); }
  /** Implicit value at grid coords; iso 0 is the region boundary. */
  implicitAt(i, j, threshold) {
    return this._at(this.dist, i, j) - threshold * this._at(this.weight, i, j);
  }

  /** Blurred-field implicit — used for merge softening when field blur > 0. */
  implicitSmoothedAt(i, j, threshold) {
    return this._at(this.distS, i, j) - threshold * this._at(this.weightS, i, j);
  }

  /** Interpolated raw distance at world (x, y). */
  sample(x, y) { return this._bilinear(this.dist, x, y); }
  /** Interpolated raw taper weight at world (x, y). */
  sampleWeight(x, y) { return this._bilinear(this.weight, x, y); }

  /** Depth at world (x, y): 0 at the rim, 1 at the spine. Uses smoothed fields. */
  depth(x, y, threshold) {
    const w = this._bilinear(this.weightS, x, y);
    if (w <= 1e-4) return 0;
    const d = 1 - this._bilinear(this.distS, x, y) / (threshold * w);
    return d < 0 ? 0 : d > 1 ? 1 : d;
  }

  /** Gradient of `depth`, central differences over `h` world units. */
  depthGradient(x, y, threshold, h) {
    const gxv = (this.depth(x + h, y, threshold) - this.depth(x - h, y, threshold)) / (2 * h);
    const gyv = (this.depth(x, y + h, threshold) - this.depth(x, y - h, threshold)) / (2 * h);
    return [gxv, gyv];
  }
}

/** Separable 3-tap box blur, `passes` times, returning a new array. */
function blurArray(src, w, h, passes) {
  let cur = Float32Array.from(src);
  const tmp = new Float32Array(cur.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const i0 = i > 0 ? i - 1 : 0, i1 = i < w - 1 ? i + 1 : w - 1;
        tmp[j * w + i] = (cur[j * w + i0] + cur[j * w + i] + cur[j * w + i1]) / 3;
      }
    for (let j = 0; j < h; j++) {
      const j0 = j > 0 ? j - 1 : 0, j1 = j < h - 1 ? j + 1 : h - 1;
      for (let i = 0; i < w; i++)
        cur[j * w + i] = (tmp[j0 * w + i] + tmp[j * w + i] + tmp[j1 * w + i]) / 3;
    }
  }
  return cur;
}

// Winning segment index / param of the last nearestSegment* call. Module
// scratch instead of a returned object keeps the cells × segments hot loop
// allocation-free.
let _nearK = -1;
let _nearT = 0;
let _nearD2 = Infinity;
let _nearWeight = 0;

let _candidateT = 0;
let _candidateD2 = Infinity;
let _candidateWeight = 0;

function nearestSegmentBrute(px, py, s) {
  const { ax, ay, vx, vy, invLen2, count } = s;
  let best = Infinity, bestK = -1, bestT = 0;
  for (let k = 0; k < count; k++) {
    const wx = px - ax[k], wy = py - ay[k];
    let t = (wx * vx[k] + wy * vy[k]) * invLen2[k];
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = wx - vx[k] * t;
    const dy = wy - vy[k] * t;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) { best = d2; bestK = k; bestT = t; }
  }
  _nearK = bestK;
  _nearT = bestT;
  return best;
}

function nearestSegmentWeightedBrute(px, py, s, taper, taperPower) {
  let bestMetric = Infinity;
  let bestK = -1, bestT = 0, bestD2 = Infinity, bestWeight = 0;
  const boundedTaper = taper <= 0 || taperPower >= 0;
  for (let k = 0; k < s.count; k++) {
    const metric = weightedSegmentMetric(px, py, s, k, taper, taperPower, bestMetric, boundedTaper);
    if (metric < bestMetric) {
      bestMetric = metric;
      bestK = k;
      bestT = _candidateT;
      bestD2 = _candidateD2;
      bestWeight = _candidateWeight;
    }
  }
  _nearK = bestK;
  _nearT = bestT;
  _nearD2 = bestD2;
  _nearWeight = bestWeight;
}

/**
 * Coarse uniform grid over the segments (CSR layout: offsets + entries), so
 * each grid node only tests nearby segments instead of all of them. Each
 * segment lands in every bucket its AABB overlaps.
 */
function buildSegmentBuckets(field) {
  const s = field._seg;
  const legacyNegativeTaper = s.nonUnitRadius && field.taper > 0 && field.taperPower < 0;
  // Larger buckets avoid expensive ring-walk bookkeeping on the dense output
  // grid. Weighted-radius queries need a slightly wider search horizon because
  // a farther, wider segment can beat the geometrically nearest one. Retain the
  // legacy factor for negative taper exponents, whose >1 endpoint caps make the
  // historical search bound part of the public output.
  const cs = field.cell * (legacyNegativeTaper ? 8 : s.nonUnitRadius ? 24 : 16);
  const nx = Math.max(1, Math.ceil((field.width * field.cell) / cs) + 1);
  const ny = Math.max(1, Math.ceil((field.height * field.cell) / cs) + 1);
  const { ax, ay, vx, vy, count } = s;
  const { minX, minY } = field;

  const clampI = (v, n) => (v < 0 ? 0 : v >= n ? n - 1 : v);
  const offsets = new Int32Array(nx * ny + 1);
  for (let k = 0; k < count; k++) {
    const x0 = clampI(Math.floor((Math.min(ax[k], ax[k] + vx[k]) - minX) / cs), nx);
    const x1 = clampI(Math.floor((Math.max(ax[k], ax[k] + vx[k]) - minX) / cs), nx);
    const y0 = clampI(Math.floor((Math.min(ay[k], ay[k] + vy[k]) - minY) / cs), ny);
    const y1 = clampI(Math.floor((Math.max(ay[k], ay[k] + vy[k]) - minY) / cs), ny);
    for (let j = y0; j <= y1; j++)
      for (let i = x0; i <= x1; i++) offsets[j * nx + i + 1]++;
  }
  for (let c = 0; c < nx * ny; c++) offsets[c + 1] += offsets[c];
  const entries = new Int32Array(offsets[nx * ny]);
  const cursor = offsets.slice(0, nx * ny);
  for (let k = 0; k < count; k++) {
    const x0 = clampI(Math.floor((Math.min(ax[k], ax[k] + vx[k]) - minX) / cs), nx);
    const x1 = clampI(Math.floor((Math.max(ax[k], ax[k] + vx[k]) - minX) / cs), nx);
    const y0 = clampI(Math.floor((Math.min(ay[k], ay[k] + vy[k]) - minY) / cs), ny);
    const y1 = clampI(Math.floor((Math.max(ay[k], ay[k] + vy[k]) - minY) / cs), ny);
    for (let j = y0; j <= y1; j++)
      for (let i = x0; i <= x1; i++) entries[cursor[j * nx + i]++] = k;
  }
  return { cs, nx, ny, offsets, entries, minX, minY };
}

/**
 * Exact nearest segment via expanding bucket rings. `seedK` (the previous
 * node's winner — neighbours share nearest segments) tightens the initial
 * bound so the ring search usually stops at r ≤ 1.
 */
function nearestSegmentBucketed(px, py, s, b, seedK) {
  const { ax, ay, vx, vy, invLen2 } = s;
  const { cs, nx, ny, offsets, entries } = b;
  let best = Infinity, bestK = -1, bestT = 0;

  if (seedK >= 0) {
    const wx = px - ax[seedK], wy = py - ay[seedK];
    let t = (wx * vx[seedK] + wy * vy[seedK]) * invLen2[seedK];
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = wx - vx[seedK] * t;
    const dy = wy - vy[seedK] * t;
    best = dx * dx + dy * dy;
    bestK = seedK;
    bestT = t;
  }

  let bi = Math.floor((px - b.minX) / cs);
  let bj = Math.floor((py - b.minY) / cs);
  bi = bi < 0 ? 0 : bi >= nx ? nx - 1 : bi;
  bj = bj < 0 ? 0 : bj >= ny ? ny - 1 : bj;

  const maxR = Math.max(nx, ny);
  for (let r = 0; r <= maxR; r++) {
    // Cells in ring r sit at least (r-1) whole buckets away from the query
    // point; once even that lower bound loses to `best`, no farther ring can
    // hold the winner.
    if (r >= 2) {
      const rm = (r - 1) * cs;
      if (rm * rm > best) break;
    }
    const iLo = bi - r, iHi = bi + r, jLo = bj - r, jHi = bj + r;
    for (let jj = jLo; jj <= jHi; jj++) {
      if (jj < 0 || jj >= ny) continue;
      // Middle rows only contribute their two edge cells to the ring.
      const step = jj === jLo || jj === jHi || r === 0 ? 1 : 2 * r;
      for (let ii = iLo; ii <= iHi; ii += step) {
        if (ii < 0 || ii >= nx) continue;
          const c = jj * nx + ii;
          for (let e = offsets[c]; e < offsets[c + 1]; e++) {
            const k = entries[e];
            const wx = px - ax[k], wy = py - ay[k];
          let t = (wx * vx[k] + wy * vy[k]) * invLen2[k];
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = wx - vx[k] * t;
          const dy = wy - vy[k] * t;
          const d2 = dx * dx + dy * dy;
          if (d2 < best) { best = d2; bestK = k; bestT = t; }
        }
      }
    }
  }
  _nearK = bestK;
  _nearT = bestT;
  return best;
}

function nearestSegmentWeightedBucketed(px, py, s, b, seedK, taper, taperPower) {
  const { cs, nx, ny, offsets, entries } = b;
  let bestMetric = Infinity;
  let bestK = -1, bestT = 0, bestD2 = Infinity, bestWeight = 0;
  const boundedTaper = taper <= 0 || taperPower >= 0;

  if (seedK >= 0) {
    bestMetric = weightedSegmentMetric(px, py, s, seedK, taper, taperPower, bestMetric, boundedTaper);
    if (Number.isFinite(bestMetric)) {
      bestK = seedK;
      bestT = _candidateT;
      bestD2 = _candidateD2;
      bestWeight = _candidateWeight;
    }
  }

  let bi = Math.floor((px - b.minX) / cs);
  let bj = Math.floor((py - b.minY) / cs);
  bi = bi < 0 ? 0 : bi >= nx ? nx - 1 : bi;
  bj = bj < 0 ? 0 : bj >= ny ? ny - 1 : bj;

  const maxR = Math.max(nx, ny);
  const maxWeight = Math.max(s.maxRadius, 1e-8);
  for (let r = 0; r <= maxR; r++) {
    if (r >= 2 && Number.isFinite(bestMetric)) {
      const rm = (r - 1) * cs;
      if ((rm * rm) / (maxWeight * maxWeight) > bestMetric) break;
    }
    const iLo = bi - r, iHi = bi + r, jLo = bj - r, jHi = bj + r;
    for (let jj = jLo; jj <= jHi; jj++) {
      if (jj < 0 || jj >= ny) continue;
      const step = jj === jLo || jj === jHi || r === 0 ? 1 : 2 * r;
      for (let ii = iLo; ii <= iHi; ii += step) {
        if (ii < 0 || ii >= nx) continue;
          const c = jj * nx + ii;
          for (let e = offsets[c]; e < offsets[c + 1]; e++) {
            const k = entries[e];
            const metric = weightedSegmentMetric(px, py, s, k, taper, taperPower, bestMetric, boundedTaper);
          if (metric < bestMetric) {
            bestMetric = metric;
            bestK = k;
            bestT = _candidateT;
            bestD2 = _candidateD2;
            bestWeight = _candidateWeight;
          }
        }
      }
    }
  }

  _nearK = bestK;
  _nearT = bestT;
  _nearD2 = bestD2;
  _nearWeight = bestWeight;
}

function weightedSegmentMetric(px, py, s, k, taper, taperPower, bestMetric = Infinity, boundedTaper = true) {
  const wx = px - s.ax[k], wy = py - s.ay[k];
  let t = (wx * s.vx[k] + wy * s.vy[k]) * s.invLen2[k];
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = wx - s.vx[k] * t;
  const dy = wy - s.vy[k] * t;
  const d2 = dx * dx + dy * dy;

  // The actual point radius is linear between the endpoints and taper can only
  // reduce it. If even the segment's maximum possible radius cannot beat the
  // current weighted-distance winner, skip the costly sin/pow profile exactly.
  const maxWeight = s.radiusMax[k];
  // A negative taper exponent can make the authored cap exceed 1 near the
  // endpoints. Preserve that public (if unusual) behavior by disabling this
  // radius bound for that case.
  if (boundedTaper && Number.isFinite(bestMetric) && d2 > 1e-20
      && (maxWeight <= 1e-8 || d2 >= bestMetric * maxWeight * maxWeight)) {
    return Infinity;
  }

  let cap = 1;
  if (!s.closed[k] && taper > 0) {
    const arc = s.arc0[k] + t * s.arcStep[k];
    const profile = Math.pow(Math.max(0, Math.sin(Math.PI * arc)), taperPower);
    cap = 1 - taper * (1 - profile);
  }
  const scale = s.ra[k] + s.radiusDelta[k] * t;
  const localWeight = Math.max(0, scale) * Math.max(0, cap);

  _candidateT = t;
  _candidateD2 = d2;
  _candidateWeight = localWeight;
  if (localWeight > 1e-8) return d2 / (localWeight * localWeight);
  // A fully tapered/zero-pressure point is still the zero-area boundary at
  // its exact centerline; retaining that equality avoids a one-cell tip hole.
  return d2 <= 1e-20 ? 0 : Infinity;
}

function radiusScale(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 1;
}
