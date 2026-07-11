/**
 * Spatial index over a triangle mesh for fast closest-point queries.
 *
 * A uniform grid of triangle references (each triangle inserted into every
 * cell its AABB overlaps), built once in O(tris). `closestPoint` then only
 * tests triangles in the cells a query sphere touches — this is what makes
 * welding painted strokes back onto a dense sculpted GLB interactive, where
 * hundreds of full-mesh raycasts per stroke would freeze the main thread.
 *
 * Everything is in the geometry's local space; callers handle transforms.
 */

/**
 * @param {import('three').BufferGeometry} geometry - triangle mesh (indexed or not)
 * @param {object} [opts]
 * @param {number} [opts.cellsPerAxis=64] - grid resolution along the longest axis
 * @returns {{
 *   closestPoint: (x: number, y: number, z: number, maxDist: number, opts?: {
 *     normal?: [number,number,number], minNormalDot?: number
 *   }) =>
 *     { point: [number,number,number], normal: [number,number,number], distance: number } | null,
 *   trianglesNearSegment: (a: [number,number,number], b: [number,number,number], radius: number) => number[],
 *   triangleCount: number,
 * }}
 */
export function createMeshIndex(geometry, opts = {}) {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const triCount = ((index ? index.count : pos.count) / 3) | 0;

  // flatten to a triangle soup once — grid queries then never touch the
  // BufferAttribute accessors
  const tris = new Float32Array(triCount * 9);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const v = index ? index.getX(t * 3 + c) : t * 3 + c;
      const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      const o = t * 9 + c * 3;
      tris[o] = x; tris[o + 1] = y; tris[o + 2] = z;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }

  const sizeX = maxX - minX, sizeY = maxY - minY, sizeZ = maxZ - minZ;
  const longest = Math.max(sizeX, sizeY, sizeZ) || 1;
  const cell = longest / Math.max(4, opts.cellsPerAxis ?? 64);
  const nx = Math.max(1, Math.ceil(sizeX / cell) + 1);
  const ny = Math.max(1, Math.ceil(sizeY / cell) + 1);
  const nz = Math.max(1, Math.ceil(sizeZ / cell) + 1);

  const cells = new Map(); // packed cell -> number[] triangle ids
  const cellOf = (v, min, n) => {
    const i = Math.floor((v - min) / cell);
    return i < 0 ? 0 : i >= n ? n - 1 : i;
  };
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const x0 = cellOf(Math.min(tris[o], tris[o + 3], tris[o + 6]), minX, nx);
    const x1 = cellOf(Math.max(tris[o], tris[o + 3], tris[o + 6]), minX, nx);
    const y0 = cellOf(Math.min(tris[o + 1], tris[o + 4], tris[o + 7]), minY, ny);
    const y1 = cellOf(Math.max(tris[o + 1], tris[o + 4], tris[o + 7]), minY, ny);
    const z0 = cellOf(Math.min(tris[o + 2], tris[o + 5], tris[o + 8]), minZ, nz);
    const z1 = cellOf(Math.max(tris[o + 2], tris[o + 5], tris[o + 8]), minZ, nz);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const key = (ix * ny + iy) * nz + iz;
          let list = cells.get(key);
          if (!list) cells.set(key, (list = []));
          list.push(t);
        }
      }
    }
  }

  // stamp array instead of a per-query Set: triangles span multiple cells
  const stamps = new Uint32Array(triCount);
  let stamp = 0;
  const out = { point: [0, 0, 0], bary: [0, 0, 0] };

  const nextStamp = () => {
    stamp = (stamp + 1) >>> 0;
    if (stamp === 0) {
      stamps.fill(0);
      stamp = 1;
    }
    return stamp;
  };

  function closestPoint(x, y, z, maxDist, queryOpts = {}) {
    const requestedNormal = Array.isArray(queryOpts?.normal) && queryOpts.normal.length === 3
      && queryOpts.normal.every(Number.isFinite)
      ? queryOpts.normal
      : null;
    const requestedLength = requestedNormal ? Math.hypot(...requestedNormal) : 0;
    const filterNormal = requestedLength > 1e-12
      ? requestedNormal.map((value) => value / requestedLength)
      : null;
    const minNormalDot = Math.min(1, Math.max(
      -1,
      Number.isFinite(queryOpts?.minNormalDot) ? queryOpts.minNormalDot : 0,
    ));
    const queryStamp = nextStamp();
    const x0 = cellOf(x - maxDist, minX, nx), x1 = cellOf(x + maxDist, minX, nx);
    const y0 = cellOf(y - maxDist, minY, ny), y1 = cellOf(y + maxDist, minY, ny);
    const z0 = cellOf(z - maxDist, minZ, nz), z1 = cellOf(z + maxDist, minZ, nz);
    let bestD2 = maxDist * maxDist;
    let bestTri = -1;
    const best = [0, 0, 0];
    const bestNormal = [0, 0, 0];
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const list = cells.get((ix * ny + iy) * nz + iz);
          if (!list) continue;
          for (let k = 0; k < list.length; k++) {
            const t = list[k];
            if (stamps[t] === queryStamp) continue;
            stamps[t] = queryStamp;
            const o = t * 9;
            let nxv = 0, nyv = 0, nzv = 0;
            if (filterNormal) {
              const e1x = tris[o + 3] - tris[o];
              const e1y = tris[o + 4] - tris[o + 1];
              const e1z = tris[o + 5] - tris[o + 2];
              const e2x = tris[o + 6] - tris[o];
              const e2y = tris[o + 7] - tris[o + 1];
              const e2z = tris[o + 8] - tris[o + 2];
              nxv = e1y * e2z - e1z * e2y;
              nyv = e1z * e2x - e1x * e2z;
              nzv = e1x * e2y - e1y * e2x;
              const length = Math.hypot(nxv, nyv, nzv) || 1;
              nxv /= length; nyv /= length; nzv /= length;
              const dot = nxv * filterNormal[0] + nyv * filterNormal[1] + nzv * filterNormal[2];
              if (dot < minNormalDot) continue;
            }
            const d2 = closestPointOnTriangle(x, y, z, tris, t * 9, out.point);
            if (d2 < bestD2) {
              bestD2 = d2;
              bestTri = t;
              best[0] = out.point[0]; best[1] = out.point[1]; best[2] = out.point[2];
              if (filterNormal) {
                bestNormal[0] = nxv; bestNormal[1] = nyv; bestNormal[2] = nzv;
              }
            }
          }
        }
      }
    }
    if (bestTri < 0) return null;
    let nxv = bestNormal[0], nyv = bestNormal[1], nzv = bestNormal[2];
    if (!filterNormal) {
      const o = bestTri * 9;
      const e1x = tris[o + 3] - tris[o], e1y = tris[o + 4] - tris[o + 1], e1z = tris[o + 5] - tris[o + 2];
      const e2x = tris[o + 6] - tris[o], e2y = tris[o + 7] - tris[o + 1], e2z = tris[o + 8] - tris[o + 2];
      nxv = e1y * e2z - e1z * e2y;
      nyv = e1z * e2x - e1x * e2z;
      nzv = e1x * e2y - e1y * e2x;
      const length = Math.hypot(nxv, nyv, nzv) || 1;
      nxv /= length; nyv /= length; nzv /= length;
    }
    return {
      point: [best[0], best[1], best[2]],
      normal: [nxv, nyv, nzv],
      distance: Math.sqrt(bestD2),
    };
  }

  /**
   * Candidate triangles in a capsule around a segment. Walking the grid along
   * the segment avoids the enormous diagonal AABB queries that made long,
   * simplified stroke segments touch most of a dense mesh. The caller still
   * performs its exact distance test; this is deliberately a conservative
   * broad phase.
   */
  function trianglesNearSegment(a, b, radius) {
    const queryStamp = nextStamp();
    const found = [];
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / Math.max(1e-9, cell * 0.5)));
    const reach = Math.max(1, Math.ceil(Math.max(0, radius) / cell) + 1);

    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const cx = cellOf(a[0] + dx * t, minX, nx);
      const cy = cellOf(a[1] + dy * t, minY, ny);
      const cz = cellOf(a[2] + dz * t, minZ, nz);
      const ix0 = Math.max(0, cx - reach), ix1 = Math.min(nx - 1, cx + reach);
      const iy0 = Math.max(0, cy - reach), iy1 = Math.min(ny - 1, cy + reach);
      const iz0 = Math.max(0, cz - reach), iz1 = Math.min(nz - 1, cz + reach);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iy = iy0; iy <= iy1; iy++) {
          for (let iz = iz0; iz <= iz1; iz++) {
            const list = cells.get((ix * ny + iy) * nz + iz);
            if (!list) continue;
            for (let k = 0; k < list.length; k++) {
              const triangle = list[k];
              if (stamps[triangle] === queryStamp) continue;
              stamps[triangle] = queryStamp;
              found.push(triangle);
            }
          }
        }
      }
    }
    return found;
  }

  return { closestPoint, trianglesNearSegment, triangleCount: triCount };
}

/**
 * Ericson, Real-Time Collision Detection 5.1.5. Writes the closest point on
 * triangle (tris[o..o+8]) to `out` and returns the squared distance.
 */
function closestPointOnTriangle(px, py, pz, tris, o, out) {
  const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
  const bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
  const cx = tris[o + 6], cy = tris[o + 7], cz = tris[o + 8];

  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return write(out, ax, ay, az, px, py, pz);

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return write(out, bx, by, bz, px, py, pz);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return write(out, ax + abx * v, ay + aby * v, az + abz * v, px, py, pz);
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return write(out, cx, cy, cz, px, py, pz);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return write(out, ax + acx * w, ay + acy * w, az + acz * w, px, py, pz);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return write(out, bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w, px, py, pz);
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return write(out, ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w, px, py, pz);
}

function write(out, x, y, z, px, py, pz) {
  out[0] = x; out[1] = y; out[2] = z;
  const dx = px - x, dy = py - y, dz = pz - z;
  return dx * dx + dy * dy + dz * dz;
}
