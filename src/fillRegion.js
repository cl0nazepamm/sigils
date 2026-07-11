/**
 * Filled marching squares over the implicit field.
 *
 * Classic marching squares extracts a *contour*; here we extract the *filled
 * area* inside the iso-line, cell by cell. For each grid cell we clip the square
 * by the iso-line (interpolating exact crossings of the implicit value
 * g = dist - threshold*weight) and fan-triangulate the inside polygon. The
 * result is a dense triangulation that hugs the stroke with crisp corners, tips
 * and cusps — the boundary is read from the raw field, so sharpness is kept.
 *
 * Per vertex we bake:
 *   - `depth` in [0,1]: 0 on the boundary, 1 on the stroke spine.
 *   - `grad`  the 2D gradient of `depth` (slightly smoothed) for analytic normals.
 * and we return the open boundary edges (used to build side walls).
 */

/**
 * @param {DistanceField} field
 * @param {number} threshold - base region radius around the strokes (world units)
 * @param {number} [fieldSmooth=0] - blur passes; softens stroke merges in the fill
 * @param {number} [mergeBlendScale=8] - fieldSmooth divisor for raw/smoothed implicit blend
 * @param {boolean} [sampleDepth=true] - sample centerline depth/gradients for
 *   every emitted vertex. Boundary-profile callers overwrite both arrays and
 *   can skip this comparatively expensive work.
 * @returns {{
 *   positions: Float32Array, depth: Float32Array, grad: Float32Array,
 *   indices: Uint32Array, boundary: Array<[number, number]>, count: number
 * }}
 */
export function fillRegion(field, threshold, fieldSmooth = 0, mergeBlendScale = 8, sampleDepth = true) {
  const { width, height, cell, minX, minY } = field;
  const eps = cell * 1e-3;
  const gradStep = cell * 1.25; // wider than a cell -> de-noised shading normals
  const mergeBlend = fieldSmooth > 0 ? Math.min(1, fieldSmooth / mergeBlendScale) : 0;

  // Each grid corner belongs to as many as four cells. Cache its exact double
  // implicit value once rather than repeating field method calls and blends in
  // every neighboring cell. Float64 preserves the previous arithmetic bit for
  // bit; using Float32 here can move very close iso crossings.
  const implicitGrid = new Float64Array(width * height);
  const hasSmoothed = mergeBlend > 0 && typeof field.implicitSmoothedAt === 'function';
  for (let j = 0; j < height; j++) {
    const row = j * width;
    for (let i = 0; i < width; i++) {
      const raw = field.implicitAt(i, j, threshold);
      implicitGrid[row + i] = hasSmoothed
        ? raw * (1 - mergeBlend) + field.implicitSmoothedAt(i, j, threshold) * mergeBlend
        : raw;
    }
  }

  const vx = [];
  const vy = [];
  const vdepth = sampleDepth ? [] : null;
  const vgx = sampleDepth ? [] : null;
  const vgy = sampleDepth ? [] : null;
  const tris = [];
  const lookup = new Map();

  // Numeric weld key: quantized coords stay far below KEY_OFFSET (|q| tops out
  // near resolution * 1e3), so the packed key fits in a safe integer (< 2^52).
  const KEY_OFFSET = 2 ** 25;
  const KEY_STRIDE = 2 ** 26;

  const vertId = (x, y) => {
    const key = (Math.round(x / eps) + KEY_OFFSET) * KEY_STRIDE + (Math.round(y / eps) + KEY_OFFSET);
    let id = lookup.get(key);
    if (id !== undefined) return id;
    id = vx.length;
    lookup.set(key, id);
    vx.push(x);
    vy.push(y);
    if (sampleDepth) {
      vdepth.push(field.depth(x, y, threshold));
      const [dgx, dgy] = field.depthGradient(x, y, threshold, gradStep);
      vgx.push(dgx);
      vgy.push(dgy);
    }
    return id;
  };

  // Corner offsets walked counter-clockwise so emitted triangles face +Z.
  const cxo = [0, 1, 1, 0];
  const cyo = [0, 0, 1, 1];

  // Reuse the tiny cell scratch buffers. At production grids this loop visits
  // 150k+ cells; allocating a `g`, polygon and coordinate pair arrays per cell
  // created enough garbage to make topology extraction visibly stutter.
  const g = new Float64Array(4);
  const polyX = new Float64Array(8);
  const polyY = new Float64Array(8);

  for (let j = 0; j < height - 1; j++) {
    const row = j * width;
    const nextRow = row + width;
    for (let i = 0; i < width - 1; i++) {
      // Implicit value at the four corners (< 0 is inside).
      g[0] = implicitGrid[row + i];
      g[1] = implicitGrid[row + i + 1];
      g[2] = implicitGrid[nextRow + i + 1];
      g[3] = implicitGrid[nextRow + i];
      let inCount = 0;
      for (let c = 0; c < 4; c++) if (g[c] < 0) inCount++;
      if (inCount === 0) continue;

      // Inside polygon by walking the 4 edges CCW (interpolating g = 0 crossings).
      let polyCount = 0;
      const cellX = minX + i * cell;
      const cellY = minY + j * cell;
      for (let c = 0; c < 4; c++) {
        const a = c;
        const b = (c + 1) % 4;
        const ax = cellX + cxo[a] * cell;
        const ay = cellY + cyo[a] * cell;
        const ga = g[a];
        const gb = g[b];
        const aIn = ga < 0;
        const bIn = gb < 0;
        if (aIn) {
          polyX[polyCount] = ax;
          polyY[polyCount] = ay;
          polyCount++;
        }
        if (aIn !== bIn) {
          const bx = cellX + cxo[b] * cell;
          const by = cellY + cyo[b] * cell;
          const t = ga / (ga - gb); // where g crosses 0
          polyX[polyCount] = ax + (bx - ax) * t;
          polyY[polyCount] = ay + (by - ay) * t;
          polyCount++;
        }
      }
      if (polyCount < 3) continue;

      const i0 = vertId(polyX[0], polyY[0]);
      for (let p = 1; p < polyCount - 1; p++) {
        const i1 = vertId(polyX[p], polyY[p]);
        const i2 = vertId(polyX[p + 1], polyY[p + 1]);
        if (triArea(vx, vy, i0, i1, i2) < eps * eps) continue;
        tris.push(i0, i1, i2);
      }
    }
  }

  const n = vx.length;
  const boundary = openBoundaryEdges(tris, n);
  const positions = new Float32Array(n * 3);
  const depth = new Float32Array(n);
  const grad = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) {
    positions[k * 3] = vx[k];
    positions[k * 3 + 1] = vy[k];
    positions[k * 3 + 2] = 0;
    if (sampleDepth) {
      depth[k] = vdepth[k];
      grad[k * 2] = vgx[k];
      grad[k * 2 + 1] = vgy[k];
    }
  }

  return { positions, depth, grad, indices: Uint32Array.from(tris), boundary, count: n };
}

/** Directed edges used by exactly one triangle = open boundary of the surface. */
function openBoundaryEdges(tris, vertexCount) {
  const seen = new Map();
  const add = (a, b) => {
    const key = a < b ? a * vertexCount + b : b * vertexCount + a;
    const directed = seen.get(key);
    // Store the first directed edge as one packed integer. A zero marks any
    // edge seen more than once; only single-use edges form the open boundary.
    if (directed === undefined) seen.set(key, a * vertexCount + b + 1);
    else if (directed !== 0) seen.set(key, 0);
  };
  for (let t = 0; t < tris.length; t += 3) {
    add(tris[t], tris[t + 1]);
    add(tris[t + 1], tris[t + 2]);
    add(tris[t + 2], tris[t]);
  }
  const edges = [];
  for (const directed of seen.values()) {
    if (directed === 0) continue;
    const edge = directed - 1;
    edges.push([Math.floor(edge / vertexCount), edge % vertexCount]);
  }
  return edges;
}

function triArea(vx, vy, a, b, c) {
  return Math.abs((vx[b] - vx[a]) * (vy[c] - vy[a]) - (vx[c] - vx[a]) * (vy[b] - vy[a])) * 0.5;
}
