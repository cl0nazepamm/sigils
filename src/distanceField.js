/**
 * Scalar distance field sampled on a regular grid — the core of the
 * curve → mesh conversion.
 *
 * For every grid node we store:
 *   - `dist`   the Euclidean distance to the nearest point on any stroke.
 *   - `weight` a taper weight in [1-taper, 1] from where along its stroke the
 *              nearest point sits. This narrows the fat-stroke toward the ends so
 *              open strokes resolve to SHARP points instead of round caps.
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
   */
  constructor(paths, opts = {}) {
    const { resolution = 200, margin = 0, smooth = 0, taper = 0, taperPower = 0.6 } = opts;
    this.taper = taper;
    this.taperPower = taperPower;

    const set = toPathSet(paths);
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
    const closeEps = span * 1e-4;

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
        ax.push(poly[i - 1][0]); ay.push(poly[i - 1][1]);
        bx.push(poly[i][0]); by.push(poly[i][1]);
        a0.push(arc[i - 1]);
        len.push(arc[i] - arc[i - 1]);
        plen.push(total);
        closed.push(isClosed ? 1 : 0);
      }
    }
    this._seg = { ax, ay, bx, by, a0, len, plen, closed, count: ax.length };
  }

  _rasterize() {
    const { width, height, cell, minX, minY, dist, weight } = this;
    const s = this._seg;
    for (let j = 0; j < height; j++) {
      const py = minY + j * cell;
      for (let i = 0; i < width; i++) {
        const px = minX + i * cell;
        let best = Infinity, bestArc = 0, bestClosed = 1;
        for (let k = 0; k < s.count; k++) {
          const r = distToSeg(px, py, s.ax[k], s.ay[k], s.bx[k], s.by[k]);
          if (r.d2 < best) {
            best = r.d2;
            bestArc = (s.a0[k] + r.t * s.len[k]) / s.plen[k];
            bestClosed = s.closed[k];
          }
        }
        const idx = j * width + i;
        dist[idx] = Math.sqrt(best);
        weight[idx] = this._taperWeight(bestArc, bestClosed);
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
    const a = this._at(arr, i, j) + (this._at(arr, i + 1, j) - this._at(arr, i, j)) * tx;
    const b = this._at(arr, i, j + 1) + (this._at(arr, i + 1, j + 1) - this._at(arr, i, j + 1)) * tx;
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

/** Squared distance + parametric t from point to segment. */
function distToSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  return { d2: dx * dx + dy * dy, t };
}
