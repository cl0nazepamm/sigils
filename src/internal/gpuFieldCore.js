import { StorageBufferAttribute } from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  float,
  instanceIndex,
  pow,
  select,
  sin,
  sqrt,
  storage,
  vec2,
} from 'three/tsl';

import { boundsOf } from './paths.js';

export class FieldGrid {
  constructor(pathSet, opts) {
    const { resolution, margin, taper, taperPower } = opts;
    this.taper = taper;
    this.taperPower = taperPower;

    const b = boundsOf(pathSet);
    this.minX = b.minX - margin;
    this.minY = b.minY - margin;
    const spanX = b.width + margin * 2;
    const spanY = b.height + margin * 2;
    const span = Math.max(spanX, spanY, 1e-6);

    this.cell = span / Math.max(2, resolution);
    this.width = Math.max(2, Math.ceil(spanX / this.cell) + 1);
    this.height = Math.max(2, Math.ceil(spanY / this.cell) + 1);

    const packed = buildSegmentBuffer(pathSet, span);
    this.segmentData = packed.segmentData;
    this.segmentCount = packed.count;
  }
}

export class ReadbackField {
  constructor(grid, dist, weight) {
    this.width = grid.width;
    this.height = grid.height;
    this.cell = grid.cell;
    this.minX = grid.minX;
    this.minY = grid.minY;
    this.dist = dist;
    this.weight = weight;
    this.distS = dist;
    this.weightS = weight;
  }

  _at(arr, i, j) {
    const { width, height } = this;
    i = i < 0 ? 0 : i > width - 1 ? width - 1 : i;
    j = j < 0 ? 0 : j > height - 1 ? height - 1 : j;
    return arr[j * width + i];
  }

  _bilinear(arr, x, y) {
    const fx = (x - this.minX) / this.cell;
    const fy = (y - this.minY) / this.cell;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const a = this._at(arr, i, j) + (this._at(arr, i + 1, j) - this._at(arr, i, j)) * tx;
    const b = this._at(arr, i, j + 1) + (this._at(arr, i + 1, j + 1) - this._at(arr, i, j + 1)) * tx;
    return a + (b - a) * ty;
  }

  implicitAt(i, j, threshold) {
    return this._at(this.dist, i, j) - threshold * this._at(this.weight, i, j);
  }
  implicitSmoothedAt(i, j, threshold) {
    return this._at(this.distS, i, j) - threshold * this._at(this.weightS, i, j);
  }

  depth(x, y, threshold) {
    const w = this._bilinear(this.weightS, x, y);
    if (w <= 1e-4) return 0;
    const d = 1 - this._bilinear(this.distS, x, y) / (threshold * w);
    return d < 0 ? 0 : d > 1 ? 1 : d;
  }

  depthGradient(x, y, threshold, h) {
    const gxv = (this.depth(x + h, y, threshold) - this.depth(x - h, y, threshold)) / (2 * h);
    const gyv = (this.depth(x, y + h, threshold) - this.depth(x, y - h, threshold)) / (2 * h);
    return [gxv, gyv];
  }
}

export function buildSegmentBuffer(set, span) {
  const data = [];
  const closeEps = span * 1e-4;

  for (const poly of set) {
    if (poly.length < 2) continue;
    const isClosed =
      Math.hypot(poly[0][0] - poly.at(-1)[0], poly[0][1] - poly.at(-1)[1]) < closeEps;

    let total = 0;
    const arc = [0];
    for (let i = 1; i < poly.length; i++) {
      total += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
      arc.push(total);
    }
    if (total <= 0) continue;

    for (let i = 1; i < poly.length; i++) {
      data.push(
        poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1],
        arc[i - 1], arc[i] - arc[i - 1], total, isClosed ? 1 : 0,
      );
    }
  }

  return { segmentData: new Float32Array(data), count: data.length / 8 };
}

/**
 * Build the SDF rasterization compute node without dispatching it, so callers
 * can queue it together with the blur passes in a single compute pass.
 */
export function rasterizeFieldKernel(field, segmentsAttr, outAttr) {
  const total = field.width * field.height;
  const segmentCount = field.segmentCount;
  const segments = storage(segmentsAttr, 'vec4', segmentCount).toReadOnly();
  const result = storage(outAttr, 'vec2', total);

  return Fn(() => {
    const ix = instanceIndex.mod(field.width);
    const iy = instanceIndex.div(field.width);
    const px = float(ix).mul(field.cell).add(field.minX);
    const py = float(iy).mul(field.cell).add(field.minY);

    const best = float(1e20).toVar();
    const bestArc = float(0).toVar();
    const bestClosed = float(1).toVar();

    Loop(segmentCount, ({ i }) => {
      const a = segments.element(i.mul(2));
      const b = segments.element(i.mul(2).add(1));
      const vx = a.z.sub(a.x);
      const vy = a.w.sub(a.y);
      const wx = px.sub(a.x);
      const wy = py.sub(a.y);
      const len2 = vx.mul(vx).add(vy.mul(vy));
      const t = wx.mul(vx).add(wy.mul(vy)).div(len2).clamp(0, 1);
      const dx = px.sub(a.x.add(vx.mul(t)));
      const dy = py.sub(a.y.add(vy.mul(t)));
      const d2 = dx.mul(dx).add(dy.mul(dy));

      If(d2.lessThan(best), () => {
        best.assign(d2);
        bestArc.assign(b.x.add(t.mul(b.y)).div(b.z));
        bestClosed.assign(b.w);
      });
    });

    const profile = pow(sin(float(Math.PI).mul(bestArc)).max(0), field.taperPower);
    const tapered = float(1).sub(float(field.taper).mul(float(1).sub(profile)));
    const w = select(bestClosed.greaterThan(0.5).or(float(field.taper).lessThanEqual(0)), 1, tapered);
    result.element(instanceIndex).assign(vec2(sqrt(best), w));
  })().compute(total);
}

export async function rasterizeField(renderer, field, segmentsAttr, outAttr) {
  await renderer.computeAsync(rasterizeFieldKernel(field, segmentsAttr, outAttr));
}

/** Build one separable blur direction as a compute node (no dispatch). */
export function blurFieldKernel(field, readAttr, writeAttr, horizontal) {
  const total = field.width * field.height;
  const gw = field.width;
  const gh = field.height;
  const src = storage(readAttr, 'vec2', total).toReadOnly();
  const dst = storage(writeAttr, 'vec2', total);

  return Fn(() => {
    const ix = instanceIndex.mod(gw);
    const iy = instanceIndex.div(gw);

    If(horizontal, () => {
      const i0 = ix.sub(1).max(0);
      const i1 = ix.add(1).min(gw - 1);
      const idxM = iy.mul(gw).add(i0);
      const idxC = iy.mul(gw).add(ix);
      const idxP = iy.mul(gw).add(i1);
      dst.element(instanceIndex).assign(
        src.element(idxM).add(src.element(idxC)).add(src.element(idxP)).mul(1 / 3),
      );
    }).Else(() => {
      const j0 = iy.sub(1).max(0);
      const j1 = iy.add(1).min(gh - 1);
      const idxM = j0.mul(gw).add(ix);
      const idxC = iy.mul(gw).add(ix);
      const idxP = j1.mul(gw).add(ix);
      dst.element(instanceIndex).assign(
        src.element(idxM).add(src.element(idxC)).add(src.element(idxP)).mul(1 / 3),
      );
    });
  })().compute(total);
}

export async function blurFieldPass(renderer, field, readAttr, writeAttr, horizontal) {
  await renderer.computeAsync(blurFieldKernel(field, readAttr, writeAttr, horizontal));
}

export async function readbackBlurredField(renderer, grid, fieldAttr) {
  const total = grid.width * grid.height;
  const buffer = await renderer.getArrayBufferAsync(fieldAttr);
  const packed = new Float32Array(buffer);
  const dist = new Float32Array(total);
  const weight = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    dist[i] = packed[i * 2];
    weight[i] = packed[i * 2 + 1];
  }
  return new ReadbackField(grid, dist, weight);
}

/** Separable 3-tap box blur — matches CPU DistanceField / HybridDistanceField. */
export function blurFieldArray(src, w, h, passes) {
  let cur = Float32Array.from(src);
  const tmp = new Float32Array(cur.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const i0 = i > 0 ? i - 1 : 0;
        const i1 = i < w - 1 ? i + 1 : w - 1;
        tmp[j * w + i] = (cur[j * w + i0] + cur[j * w + i] + cur[j * w + i1]) / 3;
      }
    }
    for (let j = 0; j < h; j++) {
      const j0 = j > 0 ? j - 1 : 0;
      const j1 = j < h - 1 ? j + 1 : h - 1;
      for (let i = 0; i < w; i++) {
        cur[j * w + i] = (tmp[j0 * w + i] + tmp[j * w + i] + tmp[j1 * w + i]) / 3;
      }
    }
  }
  return cur;
}
