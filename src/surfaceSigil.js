/**
 * Surface-native sigils: paint stroke curves ON a triangle mesh and grow the
 * chrome fill directly on that surface (option 3 of the surface-drawing plan).
 *
 *   target mesh + 3D strokes (points on the surface)
 *     → per-vertex distance to strokes           (local Euclidean ≈ geodesic)
 *     → marching TRIANGLES iso-clip              (fill region on the surface)
 *     → seam-safe scalar melt                    (surface positions stay exact)
 *     → tapered stroke field → liquid relief
 *     → heightSmooth → displace along surface normals
 *     → BufferGeometry (position, normal, aDepth)
 *
 * Distance approximation: thickness, falloff and carve range are all small
 * relative to surface curvature in practice, so distances are measured as
 * straight-line 3D distances to the stroke segments. The upgrade path to
 * exact geodesics (heat method / fast marching over the triangulation) slots in
 * at `strokeDistances` without touching the rest of the stages.
 *
 * The fill hugs the surface as an open shell; displacement is baked
 * into positions so any material works. TSL live-displacement variant later.
 */

import { BufferGeometry, BufferAttribute } from 'three';
import { createMeshIndex } from './meshIndex.js';

/** Fixed defaults for the surface-patch builder (edgeFalloff follows thickness). */
export const SURFACE_SIGIL_DEFAULTS = Object.freeze({
  thickness: 0.1,
  relief: 'carve',
  reliefRange: 6,
  peakHeight: 0.05,
  laplacian: 12,
  laplacianWeight: 0.75,
  heightSmooth: 2,
  heightSmoothWeight: 0.5,
  fieldResolution: 1,
  taper: 0,
  taperPower: 1,
  normalSmooth: 0,
  pointRadius: false,
  closed: false,
  conform: 0,
});

/**
 * @param {import('three').BufferGeometry} target - triangle geometry; normals are generated privately when absent
 * @param {Array<[number,number,number]|[number,number,number,number]>|Array<Array<[number,number,number]|[number,number,number,number]>>} strokes - one or more 3D polylines on the surface
 * @param {object} [opts]
 * @param {number} [opts.thickness=0.1]   - fat-stroke width (world units)
 * @param {number} [opts.edgeFalloff]     - rim distance reaching depth 1; default thickness*0.5
 * @param {'carve'|'plateau'|'round'} [opts.relief='carve']
 * @param {number} [opts.reliefRange=6]   - carve depth cap in falloff units
 * @param {number} [opts.peakHeight=0.05] - displacement along the surface normal at depth 1
 * @param {number} [opts.conform=0]         - pull into the mesh along −normal, as a fraction of peakHeight
 * @param {number} [opts.laplacian=12]     - scalar relief smoothing passes
 * @param {number} [opts.laplacianWeight=0.75]
 * @param {number} [opts.heightSmooth=2]  - depth blur passes (rim pinned)
 * @param {number} [opts.heightSmoothWeight=0.5]
 * @param {number} [opts.fieldResolution=1] - stroke-field precision multiplier
 * @param {number} [opts.taper=0] - open-end taper length in half-width units
 * @param {number} [opts.taperPower=1] - open-end taper profile exponent
 * @param {number} [opts.normalSmooth=0] - liquid shading-normal polish passes
 * @param {boolean} [opts.pointRadius=false] - interpret point[3] as a normalized local half-width
 * @param {boolean} [opts.closed=false] - close every input path without requiring a duplicate seam point
 * @param {ReturnType<createMeshIndex>} [opts.meshIndex] - reusable target index
 * @returns {BufferGeometry}
 */
export function buildSurfaceSigilGeometry(target, strokes, opts = {}) {
  const defaults = SURFACE_SIGIL_DEFAULTS;
  const thickness = opts.thickness ?? defaults.thickness;
  const threshold = thickness * 0.5;
  const falloff = Math.max(1e-6, opts.edgeFalloff ?? threshold);
  const relief = opts.relief ?? defaults.relief;
  const carve = relief === 'carve';
  const round = relief === 'round';
  const cap = carve ? falloff * Math.max(1, opts.reliefRange ?? defaults.reliefRange) : falloff;
  const taperLength = threshold * Math.max(0, opts.taper ?? defaults.taper);
  const taperPower = Math.max(0.1, opts.taperPower ?? defaults.taperPower);
  const pointRadius = opts.pointRadius ?? defaults.pointRadius;
  const closePaths = opts.closed ?? defaults.closed;

  const srcPos = target.getAttribute('position');
  if (!srcPos) throw new Error('surfaceSigil: target must carry positions.');

  // Surface relief only needs positions, normals and triangle order. Generate
  // missing normals on a private clone so non-indexed / position-only imports
  // work without rewriting the visible target geometry.
  let normalSource = target;
  if (!target.getAttribute('normal')) {
    normalSource = target.clone();
    normalSource.computeVertexNormals();
  }
  const srcNrm = normalSource.getAttribute('normal');
  const srcIdx = target.getIndex();

  const fieldResolution = Math.max(0.1, opts.fieldResolution ?? defaults.fieldResolution);
  const segs = flattenStrokeSegments(
    strokes,
    threshold / (8 * fieldResolution),
    pointRadius === true,
    closePaths === true,
  );
  const sourceTriangleCount = ((srcIdx?.count ?? srcPos.count) / 3) | 0;
  const stats = {
    sourceTriangleCount,
    candidateTriangleCount: 0,
    fieldSegmentCount: segs.length,
    fieldResolution,
  };
  if (segs.length === 0) {
    if (normalSource !== target) normalSource.dispose();
    return emptyGeometry(stats);
  }

  // 1) Only triangles in the stroke's brush-width neighborhood can enter the
  //    iso patch. The mode supplies its already-built target index, turning a
  //    dense global O(vertices * segments) rebuild into local work.
  const surfaceIndex = opts.meshIndex ?? createMeshIndex(target);
  const triangleIds = typeof surfaceIndex.trianglesNearSegment === 'function'
    ? collectCandidateTriangles(surfaceIndex, segs, threshold, sourceTriangleCount)
    : null;
  stats.candidateTriangleCount = triangleIds?.length ?? sourceTriangleCount;

  // Extract the exact local source triangles, weld attribute-only duplicates,
  // then refine coarse faces BEFORE evaluating the field. Refining after the
  // iso cut merely split the same jagged boundary; pre-cut samples actually
  // re-evaluate the SDF and give the resolution dial geometric meaning.
  let localSurface = extractLocalSurface(srcPos, srcNrm, srcIdx, triangleIds);
  localSurface = weldCoincidentFill(localSurface);
  localSurface = subdivideFill(localSurface, threshold / (2 * fieldResolution), 2);
  const localPos = new BufferAttribute(localSurface.positions, 3);
  const localNrm = new BufferAttribute(localSurface.normals, 3);
  const localIdx = new BufferAttribute(localSurface.count > 65535
    ? Uint32Array.from(localSurface.indices)
    : Uint16Array.from(localSurface.indices), 1);
  const g = strokeDistances(localPos, localIdx, segs, threshold, null, taperLength, taperPower);
  const melt = Math.max(0, Math.floor(opts.laplacian ?? defaults.laplacian));
  if (melt > 0) {
    smoothSurfaceField(g, localSurface, Math.ceil(melt / 3),
      clamp01(opts.laplacianWeight ?? defaults.laplacianWeight) * 0.35);
  }

  // 2) marching triangles: clip each face by the iso, fan-triangulate the
  //    inside polygon. Crossing vertices interpolate position AND normal.
  const fill = weldCoincidentFill(clipTrianglesByIso(localPos, localNrm, localIdx, g));
  if (fill.count === 0) {
    if (normalSource !== target) normalSource.dispose();
    return emptyGeometry(stats);
  }

  // 3) Relief comes from the same continuous stroke field that cut the patch.
  //    The old rim-edge search mistook UV seams, split normals and primitive
  //    borders for the outer rim, pinning random internal vertices to zero and
  //    creating dents. At an iso crossing field=0; toward the stroke it becomes
  //    increasingly negative, so -field/falloff is exactly the wanted depth.
  const depth = new Float32Array(fill.count);
  const pinned = new Uint8Array(fill.count);
  const depthCap = cap / falloff;
  for (let i = 0; i < fill.count; i++) {
    if (round) {
      const u = Math.min(1, Math.max(0, -fill.field[i] / Math.max(1e-6, threshold)));
      const dome = Math.sqrt(Math.max(0, 2 * u - u * u));
      depth[i] = Math.pow(dome, Math.min(4, Math.max(0.25, threshold / falloff)));
    } else {
      depth[i] = Math.min(depthCap, Math.max(0, -fill.field[i] / falloff));
    }
    if (Math.abs(fill.field[i]) <= 1e-7) pinned[i] = 1;
  }

  // Smooth the scalar relief, never the underlying surface positions. The
  // weld-aware adjacency makes duplicate seam vertices behave as one while
  // keeping the visible mesh and its authored density untouched.
  const topology = buildWeldedAdjacency(fill);
  const passes = Math.max(0, Math.floor(opts.heightSmooth ?? defaults.heightSmooth));
  if (passes > 0) {
    smoothGroupedScalar(depth, topology, passes,
      clamp01(opts.heightSmoothWeight ?? defaults.heightSmoothWeight), pinned);
  }

  // 4) displace along the interpolated surface normal
  const peak = opts.peakHeight ?? defaults.peakHeight;
  const conform = Math.max(0, opts.conform ?? defaults.conform ?? 0) * peak;
  for (let i = 0; i < fill.count; i++) {
    const h = peak * depth[i] - conform;
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
  geo.computeVertexNormals();
  weldShadingNormals(geo, fill.normals, topology);
  smoothShadingNormals(geo, fill.normals, fill.indices,
    Math.max(0, Math.floor(opts.normalSmooth ?? defaults.normalSmooth)), 0.5);
  stats.patchVertexCount = fill.count;
  geo.computeBoundingSphere();
  geo.userData.surfaceSigil = stats;
  if (normalSource !== target) normalSource.dispose();
  return geo;
}

function flattenStrokeSegments(strokes, tolerance = 0, pointRadius = false, closePaths = false) {
  const set = Array.isArray(strokes?.[0]?.[0]) ? strokes : [strokes];
  const segs = [];
  for (let poly of set) {
    if (!poly || poly.length < 2) continue;
    // Position-only simplification can erase a radius bulge on an otherwise
    // straight curve. Preserve weighted samples; uniform profiles can still
    // take the exact legacy simplifier path.
    if (!closePaths && (!pointRadius || hasUniformPointRadius(poly))) {
      poly = simplifyPolyline3(poly, tolerance);
    }
    const lengths = [];
    let total = 0;
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      lengths.push(length);
      total += length;
    }
    const first = poly[0], last = poly[poly.length - 1];
    const hasExplicitSeam = Math.hypot(
      last[0] - first[0], last[1] - first[1], last[2] - first[2],
    ) <= Math.max(1e-6, tolerance);
    const closed = closePaths || hasExplicitSeam;
    const closingLength = closed && !hasExplicitSeam
      ? Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2])
      : 0;
    total += closingLength;
    let start = 0;
    for (let i = 1; i < poly.length; i++) {
      const length = lengths[i - 1];
      const a = poly[i - 1], b = poly[i];
      const ra = pointRadius ? pointRadiusScale(a) : 1;
      const rb = pointRadius ? pointRadiusScale(b) : 1;
      segs.push({ a, b, ra, rb, rMax: Math.max(ra, rb), start, length, total, closed });
      start += length;
    }
    if (closingLength > 0) {
      const a = poly[poly.length - 1], b = poly[0];
      const ra = pointRadius ? pointRadiusScale(a) : 1;
      const rb = pointRadius ? pointRadiusScale(b) : 1;
      segs.push({
        a,
        b,
        ra,
        rb,
        rMax: Math.max(ra, rb),
        start,
        length: closingLength,
        total,
        closed: true,
      });
    }
  }
  return segs;
}

function hasUniformPointRadius(points) {
  const first = pointRadiusScale(points[0]);
  for (let i = 1; i < points.length; i++) {
    if (pointRadiusScale(points[i]) !== first) return false;
  }
  return true;
}

function pointRadiusScale(point) {
  const value = Number(point?.[3]);
  return Number.isFinite(value) ? Math.max(0, value) : 1;
}

function simplifyPolyline3(points, tolerance) {
  if (!(tolerance > 0) || points.length < 3) return points;
  const first = points[0], last = points[points.length - 1];
  // Closed paths need a cyclic simplifier; preserving them is safer than
  // introducing a resolution-dependent closure kink.
  if (distToSeg3(first[0], first[1], first[2], last, last) <= tolerance * tolerance) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [start, end] = stack.pop();
    const a = points[start], b = points[end];
    let best = tol2, split = -1;
    for (let i = start + 1; i < end; i++) {
      const p = points[i];
      const d2 = distToSeg3(p[0], p[1], p[2], a, b);
      if (d2 > best) { best = d2; split = i; }
    }
    if (split >= 0) {
      keep[split] = 1;
      stack.push([start, split], [split, end]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function collectCandidateTriangles(index, segs, radius, triangleCount) {
  const seen = new Uint8Array(triangleCount);
  const triangles = [];
  for (const seg of segs) {
    const { a, b } = seg;
    // The broad phase must cover the fattest point on this segment; querying
    // with only the global width clips large-radius CV regions before the SDF
    // ever sees them.
    const nearby = index.trianglesNearSegment(a, b, radius * seg.rMax);
    for (let i = 0; i < nearby.length; i++) {
      const triangle = nearby[i];
      if (triangle < 0 || triangle >= triangleCount || seen[triangle]) continue;
      seen[triangle] = 1;
      triangles.push(triangle);
    }
  }
  return triangles;
}

/** Min 3D distance on only the vertices belonging to candidate triangles. */
function strokeDistances(pos, idx, segs, threshold, triangleIds, taperLength = 0, taperPower = 1) {
  const out = new Float32Array(pos.count);
  const seen = new Uint8Array(pos.count);
  const vertexIds = [];
  const triangleCount = ((idx?.count ?? pos.count) / 3) | 0;
  const count = triangleIds?.length ?? triangleCount;
  for (let i = 0; i < count; i++) {
    const triangle = triangleIds ? triangleIds[i] : i;
    for (let corner = 0; corner < 3; corner++) {
      const offset = triangle * 3 + corner;
      const vertex = idx ? idx.getX(offset) : offset;
      if (!seen[vertex]) { seen[vertex] = 1; vertexIds.push(vertex); }
    }
  }

  for (const i of vertexIds) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    let best = Infinity;
    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s];
      const a = seg.a, b = seg.b;
      const vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
      const wx = px - a[0], wy = py - a[1], wz = pz - a[2];
      const len2 = vx * vx + vy * vy + vz * vz;
      let t = len2 > 0 ? (wx * vx + wy * vy + wz * vz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - (a[0] + vx * t);
      const dy = py - (a[1] + vy * t);
      const dz = pz - (a[2] + vz * t);
      const pointScale = seg.ra + (seg.rb - seg.ra) * t;
      let taperScale = 1;
      if (!seg.closed && taperLength > 0) {
        const arc = seg.start + seg.length * t;
        const endDistance = Math.min(arc, Math.max(0, seg.total - arc));
        const u = Math.min(1, Math.max(0, endDistance / taperLength));
        taperScale = Math.pow(u * u * (3 - 2 * u), taperPower);
      }
      const value = Math.hypot(dx, dy, dz) - threshold * pointScale * taperScale;
      if (value < best) best = value;
    }
    out[i] = best;
  }
  return out;
}

function extractLocalSurface(pos, nrm, idx, triangleIds) {
  const positions = [], normals = [], indices = [];
  const originalToLocal = new Map();
  const triangleCount = ((idx?.count ?? pos.count) / 3) | 0;
  const count = triangleIds?.length ?? triangleCount;
  const addVertex = (vertex) => {
    const cached = originalToLocal.get(vertex);
    if (cached !== undefined) return cached;
    const local = positions.length / 3;
    originalToLocal.set(vertex, local);
    positions.push(pos.getX(vertex), pos.getY(vertex), pos.getZ(vertex));
    normals.push(nrm.getX(vertex), nrm.getY(vertex), nrm.getZ(vertex));
    return local;
  };
  for (let i = 0; i < count; i++) {
    const triangle = triangleIds ? triangleIds[i] : i;
    const offset = triangle * 3;
    const a = idx ? idx.getX(offset) : offset;
    const b = idx ? idx.getX(offset + 1) : offset + 1;
    const c = idx ? idx.getX(offset + 2) : offset + 2;
    indices.push(addVertex(a), addVertex(b), addVertex(c));
  }
  const vertexCount = positions.length / 3;
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    field: new Float32Array(vertexCount),
    indices,
    count: vertexCount,
  };
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
function clipTrianglesByIso(pos, nrm, idx, g, triangleIds = null) {
  const px = [], py = [], pz = [], nx = [], ny = [], nz = [];
  const field = [];
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
    field.push(g[v]);
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
    field.push(0);
    return id;
  };

  const triangleCount = ((idx?.count ?? pos.count) / 3) | 0;
  const count = triangleIds?.length ?? triangleCount;
  for (let i = 0; i < count; i++) {
    const triangle = triangleIds ? triangleIds[i] : i;
    const offset = triangle * 3;
    const corners = idx
      ? [idx.getX(offset), idx.getX(offset + 1), idx.getX(offset + 2)]
      : [offset, offset + 1, offset + 2];
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
  return { positions, normals, field: Float32Array.from(field), indices: tris, count: n };
}

/**
 * Attribute seams and non-indexed triangle soup duplicate geometrically equal
 * vertices. Weld only coincident vertices whose authored normals agree, so UV
 * seams disappear from the working patch while intentional hard creases stay.
 * This removes redundancy without moving or decimating a single surface point.
 */
function weldCoincidentFill(fill) {
  if (fill.count === 0) return fill;
  const { positions, normals, field, indices, count } = fill;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    minX = Math.min(minX, positions[o]); maxX = Math.max(maxX, positions[o]);
    minY = Math.min(minY, positions[o + 1]); maxY = Math.max(maxY, positions[o + 1]);
    minZ = Math.min(minZ, positions[o + 2]); maxZ = Math.max(maxZ, positions[o + 2]);
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-4);
  const epsilon = Math.max(1e-7, extent * 1e-6);
  const buckets = new Map();
  const remap = new Int32Array(count);
  const outPos = [], outNrm = [], outField = [], samples = [];

  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const key = `${Math.round(positions[o] / epsilon)}_${Math.round(positions[o + 1] / epsilon)}_${Math.round(positions[o + 2] / epsilon)}`;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = []));
    let target = -1;
    for (const candidate of bucket) {
      const q = candidate * 3;
      const dot = normals[o] * outNrm[q]
        + normals[o + 1] * outNrm[q + 1]
        + normals[o + 2] * outNrm[q + 2];
      if (dot >= 0.999) { target = candidate; break; }
    }
    if (target < 0) {
      target = outField.length;
      bucket.push(target);
      outPos.push(positions[o], positions[o + 1], positions[o + 2]);
      outNrm.push(normals[o], normals[o + 1], normals[o + 2]);
      outField.push(field[i]);
      samples.push(1);
    } else {
      const q = target * 3;
      const n = samples[target]++;
      outNrm[q] = (outNrm[q] * n + normals[o]) / (n + 1);
      outNrm[q + 1] = (outNrm[q + 1] * n + normals[o + 1]) / (n + 1);
      outNrm[q + 2] = (outNrm[q + 2] * n + normals[o + 2]) / (n + 1);
      outField[target] = (outField[target] * n + field[i]) / (n + 1);
    }
    remap[i] = target;
  }

  const outIndices = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = remap[indices[i]], b = remap[indices[i + 1]], c = remap[indices[i + 2]];
    if (a !== b && b !== c && c !== a) outIndices.push(a, b, c);
  }
  const outCount = outField.length;
  for (let i = 0; i < outCount; i++) {
    const o = i * 3;
    const length = Math.hypot(outNrm[o], outNrm[o + 1], outNrm[o + 2]) || 1;
    outNrm[o] /= length; outNrm[o + 1] /= length; outNrm[o + 2] /= length;
  }
  return {
    positions: Float32Array.from(outPos),
    normals: Float32Array.from(outNrm),
    field: Float32Array.from(outField),
    indices: outIndices,
    count: outCount,
  };
}

function subdivideFill(fill, maxEdge, maxPasses) {
  if (!(maxEdge > 0)) return fill;
  let current = fill;
  const edgeLength2 = (positions, a, b) => {
    const ao = a * 3, bo = b * 3;
    const dx = positions[ao] - positions[bo];
    const dy = positions[ao + 1] - positions[bo + 1];
    const dz = positions[ao + 2] - positions[bo + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  const limit2 = maxEdge * maxEdge;

  for (let pass = 0; pass < maxPasses; pass++) {
    const { positions, normals, field, indices } = current;
    const outPos = Array.from(positions);
    const outNrm = Array.from(normals);
    const outField = Array.from(field);
    const outIndices = [];
    const midpoints = new Map();
    let splitCount = 0;

    const midpoint = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const cached = midpoints.get(key);
      if (cached !== undefined) return cached;
      const ao = a * 3, bo = b * 3;
      let nx = normals[ao] + normals[bo];
      let ny = normals[ao + 1] + normals[bo + 1];
      let nz = normals[ao + 2] + normals[bo + 2];
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length; ny /= length; nz /= length;
      const id = outField.length;
      outPos.push(
        (positions[ao] + positions[bo]) * 0.5,
        (positions[ao + 1] + positions[bo + 1]) * 0.5,
        (positions[ao + 2] + positions[bo + 2]) * 0.5,
      );
      outNrm.push(nx, ny, nz);
      outField.push((field[a] + field[b]) * 0.5);
      midpoints.set(key, id);
      return id;
    };

    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      if (Math.max(
        edgeLength2(positions, a, b),
        edgeLength2(positions, b, c),
        edgeLength2(positions, c, a),
      ) <= limit2) {
        outIndices.push(a, b, c);
        continue;
      }
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      outIndices.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
      splitCount++;
    }
    if (splitCount === 0) break;
    current = {
      positions: Float32Array.from(outPos),
      normals: Float32Array.from(outNrm),
      field: Float32Array.from(outField),
      indices: outIndices,
      count: outField.length,
    };
  }
  return current;
}

/** Edge-length-weighted diffusion of the implicit field before the iso cut. */
function smoothSurfaceField(values, surface, iterations, strength) {
  if (!(iterations > 0) || !(strength > 0)) return;
  const { positions, indices, count } = surface;
  const neighbors = Array.from({ length: count }, () => new Map());
  const add = (a, b) => {
    if (a === b || neighbors[a].has(b)) return;
    const ao = a * 3, bo = b * 3;
    const length = Math.hypot(
      positions[ao] - positions[bo],
      positions[ao + 1] - positions[bo + 1],
      positions[ao + 2] - positions[bo + 2],
    );
    neighbors[a].set(b, 1 / Math.max(1e-8, length));
  };
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    add(a, b); add(b, a); add(b, c); add(c, b); add(c, a); add(a, c);
  }

  let current = Float32Array.from(values);
  let next = new Float32Array(values.length);
  for (let pass = 0; pass < iterations; pass++) {
    for (let i = 0; i < count; i++) {
      let sum = 0, total = 0;
      for (const [neighbor, weight] of neighbors[i]) {
        sum += current[neighbor] * weight;
        total += weight;
      }
      const average = total > 0 ? sum / total : current[i];
      next[i] = current[i] + (average - current[i]) * strength;
    }
    const swap = current; current = next; next = swap;
  }
  values.set(current);
}

function buildWeldedAdjacency(fill) {
  const { positions, indices, count } = fill;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    minX = Math.min(minX, positions[o]); maxX = Math.max(maxX, positions[o]);
    minY = Math.min(minY, positions[o + 1]); maxY = Math.max(maxY, positions[o + 1]);
    minZ = Math.min(minZ, positions[o + 2]); maxZ = Math.max(maxZ, positions[o + 2]);
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-4);
  const epsilon = Math.max(1e-7, extent * 1e-6);
  const groups = [];
  const groupOf = new Int32Array(count);
  const byPosition = new Map();
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const key = `${Math.round(positions[o] / epsilon)}_${Math.round(positions[o + 1] / epsilon)}_${Math.round(positions[o + 2] / epsilon)}`;
    let group = byPosition.get(key);
    if (group === undefined) {
      group = groups.length;
      byPosition.set(key, group);
      groups.push([]);
    }
    groupOf[i] = group;
    groups[group].push(i);
  }

  const sets = Array.from({ length: groups.length }, () => new Set());
  for (let i = 0; i < indices.length; i += 3) {
    const a = groupOf[indices[i]], b = groupOf[indices[i + 1]], c = groupOf[indices[i + 2]];
    if (a !== b) { sets[a].add(b); sets[b].add(a); }
    if (b !== c) { sets[b].add(c); sets[c].add(b); }
    if (c !== a) { sets[c].add(a); sets[a].add(c); }
  }
  return { groupOf, groups, adjacency: sets.map((set) => Array.from(set)) };
}

function smoothGroupedScalar(values, topology, iterations, weight, pinned) {
  if (!(iterations > 0) || !(weight > 0)) return;
  const { groups, adjacency } = topology;
  let current = new Float32Array(groups.length);
  const groupPinned = new Uint8Array(groups.length);
  for (let group = 0; group < groups.length; group++) {
    const members = groups[group];
    let sum = 0;
    for (const vertex of members) {
      sum += values[vertex];
      if (pinned?.[vertex]) groupPinned[group] = 1;
    }
    current[group] = groupPinned[group] ? 0 : sum / members.length;
  }

  let next = new Float32Array(groups.length);
  for (let pass = 0; pass < iterations; pass++) {
    for (let group = 0; group < groups.length; group++) {
      if (groupPinned[group]) { next[group] = 0; continue; }
      const neighbors = adjacency[group];
      if (!neighbors.length) { next[group] = current[group]; continue; }
      let sum = 0;
      for (const neighbor of neighbors) sum += current[neighbor];
      next[group] = current[group] + (sum / neighbors.length - current[group]) * weight;
    }
    const swap = current; current = next; next = swap;
  }
  for (let group = 0; group < groups.length; group++) {
    for (const vertex of groups[group]) values[vertex] = current[group];
  }
}

/** Average computed shading normals across attribute seams, not hard creases. */
function weldShadingNormals(geometry, baseNormals, topology) {
  const normals = geometry.getAttribute('normal');
  const original = Float32Array.from(normals.array);
  const creaseDot = 0.7;
  for (const members of topology.groups) {
    if (members.length < 2) continue;
    for (const vertex of members) {
      const o = vertex * 3;
      let sx = 0, sy = 0, sz = 0;
      for (const other of members) {
        const q = other * 3;
        const dot = baseNormals[o] * baseNormals[q]
          + baseNormals[o + 1] * baseNormals[q + 1]
          + baseNormals[o + 2] * baseNormals[q + 2];
        if (dot < creaseDot) continue;
        sx += original[q]; sy += original[q + 1]; sz += original[q + 2];
      }
      const length = Math.hypot(sx, sy, sz) || 1;
      normals.setXYZ(vertex, sx / length, sy / length, sz / length);
    }
  }
  normals.needsUpdate = true;
}

/**
 * Diffuse only the shading normal field, never the displaced positions. This
 * removes triangle-scale reflection chatter while retaining the broad relief
 * and silhouette. Base-surface normal agreement gates the diffusion so a real
 * crease on the imported mesh is not polished away.
 */
function smoothShadingNormals(geometry, baseNormals, indices, iterations, weight) {
  if (!(iterations > 0) || !(weight > 0)) return;
  const normal = geometry.getAttribute('normal');
  const count = normal.count;
  const sets = Array.from({ length: count }, () => new Set());
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    sets[a].add(b); sets[a].add(c);
    sets[b].add(a); sets[b].add(c);
    sets[c].add(a); sets[c].add(b);
  }

  let current = Float32Array.from(normal.array);
  let next = new Float32Array(current.length);
  for (let pass = 0; pass < iterations; pass++) {
    for (let i = 0; i < count; i++) {
      const o = i * 3;
      let sx = current[o] * 2, sy = current[o + 1] * 2, sz = current[o + 2] * 2;
      let total = 2;
      for (const neighbor of sets[i]) {
        const q = neighbor * 3;
        const baseDot = baseNormals[o] * baseNormals[q]
          + baseNormals[o + 1] * baseNormals[q + 1]
          + baseNormals[o + 2] * baseNormals[q + 2];
        if (baseDot < 0.65) continue;
        sx += current[q]; sy += current[q + 1]; sz += current[q + 2];
        total++;
      }
      sx /= total; sy /= total; sz /= total;
      sx = current[o] + (sx - current[o]) * weight;
      sy = current[o + 1] + (sy - current[o + 1]) * weight;
      sz = current[o + 2] + (sz - current[o + 2]) * weight;
      const length = Math.hypot(sx, sy, sz) || 1;
      next[o] = sx / length; next[o + 1] = sy / length; next[o + 2] = sz / length;
    }
    const swap = current; current = next; next = swap;
  }
  normal.array.set(current);
  normal.needsUpdate = true;
}

function emptyGeometry(stats) {
  const geometry = new BufferGeometry();
  geometry.userData.surfaceSigil = stats;
  return geometry;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
