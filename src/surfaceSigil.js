/**
 * Surface-native sigils: paint stroke curves ON a triangle mesh and grow the
 * chrome fill directly on that surface (option 3 of the surface-drawing plan).
 *
 *   target mesh + 3D strokes (points on the surface)
 *     → per-vertex distance to strokes           (local Euclidean ≈ geodesic)
 *     → marching TRIANGLES iso-clip              (fill region on the surface)
 *     → tangential sigilize melt                 (same Laplacian as the flat path)
 *     → rim distance → carve/plateau depth       (same relief semantics)
 *     → heightSmooth → displace along surface normals
 *     → BufferGeometry (position, normal, aDepth)
 *
 * Distance approximation: thickness, falloff and carve range are all small
 * relative to surface curvature in practice, so distances are measured as
 * straight-line 3D distances to the stroke / rim segments. The upgrade path to
 * exact geodesics (heat method / fast marching over the triangulation) slots in
 * at `strokeDistances` and `rimDepth` without touching the rest of the stages.
 *
 * v1 scope: no taper weights (surface strokes are usually closed loops), no
 * walls/base (the fill hugs the surface as an open shell), displacement baked
 * into positions so any material works. TSL live-displacement variant later.
 */

import { BufferGeometry, BufferAttribute } from 'three';

/**
 * @param {import('three').BufferGeometry} target - indexed geometry with normals
 * @param {Array<Array<[number,number,number]>>} strokes - 3D polylines on the surface
 * @param {object} [opts]
 * @param {number} [opts.thickness=0.1]   - fat-stroke width (world units)
 * @param {number} [opts.edgeFalloff]     - rim distance reaching depth 1; default thickness*0.5
 * @param {'carve'|'plateau'} [opts.relief='carve']
 * @param {number} [opts.reliefRange=6]   - carve depth cap in falloff units
 * @param {number} [opts.peakHeight=0.05] - displacement along the surface normal at depth 1
 * @param {number} [opts.sigilize=12]     - tangential position-melt passes
 * @param {number} [opts.sigilizeWeight=0.75]
 * @param {number} [opts.heightSmooth=2]  - depth blur passes (rim pinned)
 * @param {number} [opts.heightSmoothWeight=0.5]
 * @returns {BufferGeometry}
 */
export function buildSurfaceSigilGeometry(target, strokes, opts = {}) {
  const thickness = opts.thickness ?? 0.1;
  const threshold = thickness * 0.5;
  const falloff = Math.max(1e-6, opts.edgeFalloff ?? threshold);
  const carve = (opts.relief ?? 'carve') === 'carve';
  const cap = carve ? falloff * Math.max(1, opts.reliefRange ?? 6) : falloff;

  const srcPos = target.getAttribute('position');
  const srcNrm = target.getAttribute('normal');
  const srcIdx = target.getIndex();
  if (!srcPos || !srcNrm || !srcIdx) {
    throw new Error('surfaceSigil: target must be indexed and carry normals.');
  }

  const segs = flattenStrokeSegments(strokes);
  if (segs.length === 0) return new BufferGeometry();

  // 1) implicit value per target vertex: dist-to-stroke - threshold (<0 inside)
  const g = strokeDistances(srcPos, segs, threshold + falloff);
  for (let i = 0; i < g.length; i++) g[i] -= threshold;

  // 2) marching triangles: clip each face by the iso, fan-triangulate the
  //    inside polygon. Crossing vertices interpolate position AND normal.
  const fill = clipTrianglesByIso(srcPos, srcNrm, srcIdx, g);
  if (fill.count === 0) return new BufferGeometry();

  const adjacency = buildAdjacency(fill.count, fill.indices);

  // 3) tangential sigilize melt — same Laplacian as the flat pipeline, but the
  //    smoothing offset is projected into the tangent plane so points slide
  //    along the surface instead of sinking into it.
  const melt = Math.max(0, Math.floor(opts.sigilize ?? 12));
  if (melt > 0) meltOnSurface(fill, adjacency, melt, clamp01(opts.sigilizeWeight ?? 0.75));

  // 4) rim depth with carve/plateau relief (same semantics as applyBoundaryDepth)
  const boundary = openBoundaryEdges(fill.indices);
  const depth = new Float32Array(fill.count);
  if (boundary.length === 0) {
    depth.fill(1);
  } else {
    rimDepth(fill, boundary, depth, falloff, cap);
    if (!carve) for (let i = 0; i < depth.length; i++) depth[i] = Math.min(1, depth[i]);
    const pinned = new Uint8Array(fill.count);
    for (const [a, b] of boundary) { pinned[a] = 1; pinned[b] = 1; }
    for (let i = 0; i < fill.count; i++) if (pinned[i]) depth[i] = 0;

    const passes = Math.max(0, Math.floor(opts.heightSmooth ?? 2));
    if (passes > 0) {
      smoothScalar(depth, adjacency, passes, clamp01(opts.heightSmoothWeight ?? 0.5), pinned);
    }
  }

  // 5) displace along the interpolated surface normal
  const peak = opts.peakHeight ?? 0.05;
  for (let i = 0; i < fill.count; i++) {
    const h = peak * depth[i];
    fill.positions[i * 3] += fill.normals[i * 3] * h;
    fill.positions[i * 3 + 1] += fill.normals[i * 3 + 1] * h;
    fill.positions[i * 3 + 2] += fill.normals[i * 3 + 2] * h;
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(fill.positions, 3));
  geo.setAttribute('normal', new BufferAttribute(fill.normals, 3));
  geo.setAttribute('aDepth', new BufferAttribute(depth, 1));
  geo.setIndex(fill.count > 65535
    ? new BufferAttribute(Uint32Array.from(fill.indices), 1)
    : new BufferAttribute(Uint16Array.from(fill.indices), 1));
  geo.computeVertexNormals(); // shading normals of the displaced shell
  geo.computeBoundingSphere();
  return geo;
}

function flattenStrokeSegments(strokes) {
  const set = Array.isArray(strokes?.[0]?.[0]) ? strokes : [strokes];
  const segs = [];
  for (const poly of set) {
    if (!poly || poly.length < 2) continue;
    for (let i = 1; i < poly.length; i++) segs.push([poly[i - 1], poly[i]]);
  }
  return segs;
}

/** Min 3D distance from every target vertex to the stroke segments (capped). */
function strokeDistances(pos, segs, capHint) {
  const n = pos.count;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    let best = Infinity;
    for (let s = 0; s < segs.length; s++) {
      const d2 = distToSeg3(px, py, pz, segs[s][0], segs[s][1]);
      if (d2 < best) best = d2;
    }
    out[i] = Math.sqrt(best);
  }
  return out;
}

function distToSeg3(px, py, pz, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
  const wx = px - a[0], wy = py - a[1], wz = pz - a[2];
  const len2 = vx * vx + vy * vy + vz * vz;
  let t = len2 > 0 ? (wx * vx + wy * vy + wz * vz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (a[0] + vx * t), dy = py - (a[1] + vy * t), dz = pz - (a[2] + vz * t);
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Marching triangles: keep the sub-polygon of each face where g < 0.
 * Vertices are deduped: original ids as-is, edge crossings keyed by the edge.
 */
function clipTrianglesByIso(pos, nrm, idx, g) {
  const px = [], py = [], pz = [], nx = [], ny = [], nz = [];
  const tris = [];
  const origMap = new Map();
  const edgeMap = new Map();

  const addOrig = (v) => {
    let id = origMap.get(v);
    if (id !== undefined) return id;
    id = px.length;
    origMap.set(v, id);
    px.push(pos.getX(v)); py.push(pos.getY(v)); pz.push(pos.getZ(v));
    nx.push(nrm.getX(v)); ny.push(nrm.getY(v)); nz.push(nrm.getZ(v));
    return id;
  };
  const addCross = (a, b) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    let id = edgeMap.get(key);
    if (id !== undefined) return id;
    const t = g[a] / (g[a] - g[b]);
    id = px.length;
    edgeMap.set(key, id);
    px.push(pos.getX(a) + (pos.getX(b) - pos.getX(a)) * t);
    py.push(pos.getY(a) + (pos.getY(b) - pos.getY(a)) * t);
    pz.push(pos.getZ(a) + (pos.getZ(b) - pos.getZ(a)) * t);
    let vx = nrm.getX(a) + (nrm.getX(b) - nrm.getX(a)) * t;
    let vy = nrm.getY(a) + (nrm.getY(b) - nrm.getY(a)) * t;
    let vz = nrm.getZ(a) + (nrm.getZ(b) - nrm.getZ(a)) * t;
    const len = Math.hypot(vx, vy, vz) || 1;
    nx.push(vx / len); ny.push(vy / len); nz.push(vz / len);
    return id;
  };

  const count = idx.count;
  for (let t = 0; t < count; t += 3) {
    const corners = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
    const poly = [];
    for (let c = 0; c < 3; c++) {
      const a = corners[c];
      const b = corners[(c + 1) % 3];
      if (g[a] < 0) poly.push(addOrig(a));
      if ((g[a] < 0) !== (g[b] < 0)) poly.push(addCross(a, b));
    }
    for (let p = 1; p < poly.length - 1; p++) {
      tris.push(poly[0], poly[p], poly[p + 1]);
    }
  }

  const n = px.length;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = px[i]; positions[i * 3 + 1] = py[i]; positions[i * 3 + 2] = pz[i];
    normals[i * 3] = nx[i]; normals[i * 3 + 1] = ny[i]; normals[i * 3 + 2] = nz[i];
  }
  return { positions, normals, indices: tris, count: n };
}

/** Depth = capped 3D distance to the rim segments, in falloff units. */
function rimDepth(fill, boundary, depth, falloff, cap) {
  const { positions, count } = fill;
  const segs = boundary.map(([a, b]) => [
    [positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]],
    [positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]],
  ]);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    let best = cap * cap;
    for (let s = 0; s < segs.length; s++) {
      const d2 = distToSeg3(x, y, z, segs[s][0], segs[s][1]);
      if (d2 < best) best = d2;
    }
    depth[i] = Math.sqrt(best) / falloff;
  }
}

function meltOnSurface(fill, adjacency, iterations, weight) {
  const { positions, normals, count } = fill;
  const next = new Float32Array(count * 3);
  for (let pass = 0; pass < iterations; pass++) {
    for (let i = 0; i < count; i++) {
      const neighbors = adjacency[i];
      const o = i * 3;
      if (!neighbors || neighbors.length === 0) {
        next[o] = positions[o]; next[o + 1] = positions[o + 1]; next[o + 2] = positions[o + 2];
        continue;
      }
      let sx = 0, sy = 0, sz = 0;
      for (let k = 0; k < neighbors.length; k++) {
        const j = neighbors[k] * 3;
        sx += positions[j]; sy += positions[j + 1]; sz += positions[j + 2];
      }
      const inv = 1 / neighbors.length;
      let dx = sx * inv - positions[o];
      let dy = sy * inv - positions[o + 1];
      let dz = sz * inv - positions[o + 2];
      // project the offset into the tangent plane so the melt slides along
      // the surface instead of shrinking into it
      const dot = dx * normals[o] + dy * normals[o + 1] + dz * normals[o + 2];
      dx -= dot * normals[o]; dy -= dot * normals[o + 1]; dz -= dot * normals[o + 2];
      next[o] = positions[o] + dx * weight;
      next[o + 1] = positions[o + 1] + dy * weight;
      next[o + 2] = positions[o + 2] + dz * weight;
    }
    positions.set(next);
  }
}

function buildAdjacency(count, indices) {
  const sets = Array.from({ length: count }, () => new Set());
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    sets[a].add(b); sets[a].add(c);
    sets[b].add(a); sets[b].add(c);
    sets[c].add(a); sets[c].add(b);
  }
  return sets.map((s) => Array.from(s));
}

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

function smoothScalar(values, adjacency, iterations, weight, pinned) {
  const tmp = new Float32Array(values.length);
  for (let pass = 0; pass < iterations; pass++) {
    for (let i = 0; i < values.length; i++) {
      if (pinned?.[i]) { tmp[i] = 0; continue; }
      const neighbors = adjacency[i];
      if (!neighbors || neighbors.length === 0) { tmp[i] = values[i]; continue; }
      let sum = 0;
      for (let k = 0; k < neighbors.length; k++) sum += values[neighbors[k]];
      tmp[i] = values[i] + (sum / neighbors.length - values[i]) * weight;
    }
    values.set(tmp);
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
