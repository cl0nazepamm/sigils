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
  vec4,
} from 'three/tsl';

import { toPathSet, boundsOf } from './internal/paths.js';

/**
 * Build the expensive raw distance/taper field on WebGPU, then read it back so
 * the existing CPU marching-squares topology stage can stay unchanged.
 *
 * @param {import('three/webgpu').WebGPURenderer} renderer
 * @param {*} paths
 * @param {object} opts
 * @returns {Promise<HybridDistanceField>}
 */
export async function buildGpuDistanceField(renderer, paths, opts = {}) {
  if (!renderer || typeof renderer.computeAsync !== 'function' || typeof renderer.getArrayBufferAsync !== 'function') {
    throw new Error('buildGpuDistanceField requires a WebGPURenderer with compute/readback support.');
  }

  const field = new HybridDistanceField(paths, opts);
  const { segmentData, count: segmentCount } = field._segments;
  const total = field.width * field.height;

  if (segmentCount === 0) {
    field.dist.fill(Infinity);
    field.weight.fill(0);
    field.finishSmoothing();
    return field;
  }

  const segmentsAttr = new StorageBufferAttribute(segmentData, 4);
  const resultAttr = new StorageBufferAttribute(total, 2);
  const segments = storage(segmentsAttr, 'vec4', segmentCount).toReadOnly();
  const result = storage(resultAttr, 'vec2', total);

  const computeField = Fn(() => {
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

  // Field smoothing (the distS/weightS height field) runs on the GPU when there
  // are passes to do, packed alongside the untouched raw field into one vec4
  // buffer. Rasterization, every blur pass and the pack all queue into ONE
  // compute pass (ordered dispatches), so the whole build costs a single
  // computeAsync + a single readback sync. Marching squares still consumes
  // both fields on the CPU, so the readback itself can't go away yet.
  const smoothPasses = Math.max(0, Math.floor(field.smooth));
  if (smoothPasses > 0) {
    try {
      const packed = await smoothFieldAndReadback(renderer, computeField, resultAttr, field.width, field.height, smoothPasses);
      field.distS = new Float32Array(total);
      field.weightS = new Float32Array(total);
      for (let i = 0; i < total; i++) {
        field.dist[i] = packed[i * 4];
        field.weight[i] = packed[i * 4 + 1];
        field.distS[i] = packed[i * 4 + 2];
        field.weightS[i] = packed[i * 4 + 3];
      }
      return field;
    } catch {
      // GPU smoothing unavailable: rasterize alone below and CPU-blur the
      // readback instead (re-dispatching the raster kernel is idempotent).
    }
  }

  await renderer.computeAsync(computeField);
  const buffer = await renderer.getArrayBufferAsync(resultAttr);
  const packed = new Float32Array(buffer);
  for (let i = 0; i < total; i++) {
    field.dist[i] = packed[i * 2];
    field.weight[i] = packed[i * 2 + 1];
  }
  field.finishSmoothing();
  return field;
}

/**
 * GPU separable 3-tap box blur of the raw vec2 (dist, weight) field. The blurred
 * field is packed together with the untouched raw field into a single vec4
 * buffer and read back in one sync. Matches the CPU {@link blurArray} exactly:
 * same edge-clamped kernel, same horizontal-then-vertical order per pass.
 *
 * The raster kernel, all blur passes and the pack are submitted as ONE
 * computeAsync batch — a single compute pass with ordered dispatches — so the
 * only remaining sync is the readback.
 *
 * @param {import('three/webgpu').WebGPURenderer} renderer
 * @param {object} rasterKernel - compute node writing the raw field into rawAttr
 * @param {import('three/webgpu').StorageBufferAttribute} rawAttr - raw vec2 field, left intact
 * @param {number} gw
 * @param {number} gh
 * @param {number} passes
 * @returns {Promise<Float32Array>} interleaved vec4 per cell: [rawDist, rawWeight, smDist, smWeight]
 */
async function smoothFieldAndReadback(renderer, rasterKernel, rawAttr, gw, gh, passes) {
  const total = gw * gh;
  const bufA = new StorageBufferAttribute(total, 2);
  const bufB = new StorageBufferAttribute(total, 2);

  // Pass 0 reads the raw field; later passes ping-pong B->A->B with the result
  // always landing in B. rawAttr is never written, so it survives for the pack.
  const batch = [rasterKernel];
  batch.push(blurKernel(rawAttr, bufA, gw, gh, total, true));
  batch.push(blurKernel(bufA, bufB, gw, gh, total, false));
  if (passes > 1) {
    const h = blurKernel(bufB, bufA, gw, gh, total, true);
    const v = blurKernel(bufA, bufB, gw, gh, total, false);
    for (let p = 1; p < passes; p++) batch.push(h, v);
  }

  const packAttr = new StorageBufferAttribute(total, 4);
  const raw = storage(rawAttr, 'vec2', total).toReadOnly();
  const sm = storage(bufB, 'vec2', total).toReadOnly();
  const out = storage(packAttr, 'vec4', total);
  const pack = Fn(() => {
    const r = raw.element(instanceIndex);
    const s = sm.element(instanceIndex);
    out.element(instanceIndex).assign(vec4(r.x, r.y, s.x, s.y));
  })().compute(total);
  batch.push(pack);

  await renderer.computeAsync(batch);
  const buffer = await renderer.getArrayBufferAsync(packAttr);
  return new Float32Array(buffer);
}

/**
 * One separable direction of the box blur. `horizontal` picks the kernel at
 * build time (no in-shader branch). Neighbor clamping uses select() so the uint
 * index math never underflows at the grid edges — equivalent to max(i-1,0) and
 * min(i+1,n-1) without leaving the unsigned domain the rest of the file uses.
 */
function blurKernel(srcAttr, dstAttr, gw, gh, total, horizontal) {
  const src = storage(srcAttr, 'vec2', total).toReadOnly();
  const dst = storage(dstAttr, 'vec2', total);
  return Fn(() => {
    const ix = instanceIndex.mod(gw);
    const iy = instanceIndex.div(gw);
    let idxM;
    let idxP;
    if (horizontal) {
      const i0 = select(ix.greaterThan(0), ix.sub(1), ix);
      const i1 = select(ix.lessThan(gw - 1), ix.add(1), ix);
      idxM = iy.mul(gw).add(i0);
      idxP = iy.mul(gw).add(i1);
    } else {
      const j0 = select(iy.greaterThan(0), iy.sub(1), iy);
      const j1 = select(iy.lessThan(gh - 1), iy.add(1), iy);
      idxM = j0.mul(gw).add(ix);
      idxP = j1.mul(gw).add(ix);
    }
    dst.element(instanceIndex).assign(
      src.element(idxM).add(src.element(instanceIndex)).add(src.element(idxP)).mul(1 / 3),
    );
  })().compute(total);
}

class HybridDistanceField {
  constructor(paths, opts = {}) {
    const { resolution = 200, margin = 0, smooth = 0, taper = 0, taperPower = 0.6 } = opts;
    this.smooth = smooth;
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
    this._segments = buildSegmentBuffer(set, span);
  }

  finishSmoothing() {
    if (this.smooth > 0) {
      this.distS = blurArray(this.dist, this.width, this.height, this.smooth);
      this.weightS = blurArray(this.weight, this.width, this.height, this.smooth);
    } else {
      this.distS = this.dist;
      this.weightS = this.weight;
    }
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

  distAt(i, j) { return this._at(this.dist, i, j); }
  implicitAt(i, j, threshold) {
    return this._at(this.dist, i, j) - threshold * this._at(this.weight, i, j);
  }
  implicitSmoothedAt(i, j, threshold) {
    return this._at(this.distS, i, j) - threshold * this._at(this.weightS, i, j);
  }
  sample(x, y) { return this._bilinear(this.dist, x, y); }
  sampleWeight(x, y) { return this._bilinear(this.weight, x, y); }

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

function buildSegmentBuffer(set, span) {
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
