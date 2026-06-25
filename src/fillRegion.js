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
 * @returns {{
 *   positions: Float32Array, depth: Float32Array, grad: Float32Array,
 *   indices: Uint32Array, boundary: Array<[number, number]>, count: number
 * }}
 */
export function fillRegion(field, threshold, fieldSmooth = 0, mergeBlendScale = 8) {
  const { width, height, cell, minX, minY } = field;
  const eps = cell * 1e-3;
  const gradStep = cell * 1.25; // wider than a cell -> de-noised shading normals
  const mergeBlend = fieldSmooth > 0 ? Math.min(1, fieldSmooth / mergeBlendScale) : 0;

  const implicit = (i, j) => {
    const raw = field.implicitAt(i, j, threshold);
    if (mergeBlend <= 0 || typeof field.implicitSmoothedAt !== 'function') return raw;
    const blurred = field.implicitSmoothedAt(i, j, threshold);
    return raw * (1 - mergeBlend) + blurred * mergeBlend;
  };

  const vx = [];
  const vy = [];
  const vdepth = [];
  const vgx = [];
  const vgy = [];
  const tris = [];
  const lookup = new Map();

  const vertId = (x, y) => {
    const key = `${Math.round(x / eps)}|${Math.round(y / eps)}`;
    let id = lookup.get(key);
    if (id !== undefined) return id;
    id = vx.length;
    lookup.set(key, id);
    vx.push(x);
    vy.push(y);
    vdepth.push(field.depth(x, y, threshold));
    const [dgx, dgy] = field.depthGradient(x, y, threshold, gradStep);
    vgx.push(dgx);
    vgy.push(dgy);
    return id;
  };

  // Corner offsets walked counter-clockwise so emitted triangles face +Z.
  const cxo = [0, 1, 1, 0];
  const cyo = [0, 0, 1, 1];

  for (let j = 0; j < height - 1; j++) {
    for (let i = 0; i < width - 1; i++) {
      // Implicit value at the four corners (< 0 is inside).
      const g = [
        implicit(i, j),
        implicit(i + 1, j),
        implicit(i + 1, j + 1),
        implicit(i, j + 1),
      ];
      let inCount = 0;
      for (let c = 0; c < 4; c++) if (g[c] < 0) inCount++;
      if (inCount === 0) continue;

      // Inside polygon by walking the 4 edges CCW (interpolating g = 0 crossings).
      const poly = [];
      for (let c = 0; c < 4; c++) {
        const a = c;
        const b = (c + 1) % 4;
        const ax = minX + (i + cxo[a]) * cell;
        const ay = minY + (j + cyo[a]) * cell;
        const ga = g[a];
        const gb = g[b];
        const aIn = ga < 0;
        const bIn = gb < 0;
        if (aIn) poly.push([ax, ay]);
        if (aIn !== bIn) {
          const bx = minX + (i + cxo[b]) * cell;
          const by = minY + (j + cyo[b]) * cell;
          const t = ga / (ga - gb); // where g crosses 0
          poly.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
        }
      }
      if (poly.length < 3) continue;

      const i0 = vertId(poly[0][0], poly[0][1]);
      for (let p = 1; p < poly.length - 1; p++) {
        const i1 = vertId(poly[p][0], poly[p][1]);
        const i2 = vertId(poly[p + 1][0], poly[p + 1][1]);
        if (triArea(vx, vy, i0, i1, i2) < eps * eps) continue;
        tris.push(i0, i1, i2);
      }
    }
  }

  const boundary = openBoundaryEdges(tris);

  const n = vx.length;
  const positions = new Float32Array(n * 3);
  const depth = new Float32Array(n);
  const grad = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) {
    positions[k * 3] = vx[k];
    positions[k * 3 + 1] = vy[k];
    positions[k * 3 + 2] = 0;
    depth[k] = vdepth[k];
    grad[k * 2] = vgx[k];
    grad[k * 2 + 1] = vgy[k];
  }

  return { positions, depth, grad, indices: Uint32Array.from(tris), boundary, count: n };
}

/** Directed edges used by exactly one triangle = open boundary of the surface. */
function openBoundaryEdges(tris) {
  const seen = new Map();
  const add = (a, b) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    const rec = seen.get(key);
    if (rec) rec.count++;
    else seen.set(key, { a, b, count: 1 });
  };
  for (let t = 0; t < tris.length; t += 3) {
    add(tris[t], tris[t + 1]);
    add(tris[t + 1], tris[t + 2]);
    add(tris[t + 2], tris[t]);
  }
  const edges = [];
  for (const { a, b, count } of seen.values()) if (count === 1) edges.push([a, b]);
  return edges;
}

function triArea(vx, vy, a, b, c) {
  return Math.abs((vx[b] - vx[a]) * (vy[c] - vy[a]) - (vx[c] - vx[a]) * (vy[b] - vy[a])) * 0.5;
}
