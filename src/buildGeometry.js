/**
 * End-to-end CPU geometry build.
 *
 *   strokes -> resample -> radial symmetry -> distance field
 *           -> filled marching squares -> solidify (top dome + walls + base)
 *           -> BufferGeometry
 *
 * The output geometry stays flat (the dome lives in z=0 and is pushed up later
 * by the TSL material). It carries the attributes the material needs:
 *   - position  (vec3)  base position; the top surface is at z=0, base at z=-base
 *   - aDepth    (float) 0 at the rim, 1 in the raised interior
 *   - aGrad     (vec2)  gradient of aDepth, for analytic normals
 *   - aNormal   (vec3)  flat normal for the non-domed parts (base + walls)
 *   - aDome     (float) 1 on the top surface, 0 on base/walls
 */

import { BufferGeometry, BufferAttribute } from 'three';
import { toPathSet, resampleByLength, boundsOf } from './internal/paths.js';
import { radialSymmetry } from './symmetry.js';
import { DistanceField } from './distanceField.js';
import { fillRegion } from './fillRegion.js';

/**
 * @param {*} paths - one stroke or an array of strokes (see toPathSet)
 * @param {object} [opts]
 * @param {number}  [opts.symmetry=1]    - radial symmetry copies
 * @param {number}  [opts.phase=0]       - global rotation of copies (radians)
 * @param {boolean} [opts.mirror=false]  - add mirrored copies (dihedral)
 * @param {number}  [opts.thickness]     - fat-stroke width; default = 6% of size
 * @param {number}  [opts.resolution=240]- field grid cells across the largest dim
 * @param {number}  [opts.resample]      - stroke resample spacing; default = thickness*0.12
 * @param {number}  [opts.smooth]        - field blur passes; default 1 (de-noise, keeps corners)
 * @param {number}  [opts.taper=1]       - 0 = round caps, 1 = strokes taper to sharp points
 * @param {number}  [opts.taperPower=0.6]- taper profile exponent (lower = blunter tips)
 * @param {number}  [opts.sigilize=0]    - point-position point-position blur passes
 * @param {number}  [opts.sigilizeWeight=1] - influence of each sigilize blur pass
 * @param {'boundary'|'centerline'} [opts.depthMode='boundary'] - height field source
 * @param {number}  [opts.edgeFalloff]   - boundary distance that reaches full height
 * @param {number}  [opts.base=0]        - solid base depth (0 = open shell, top only)
 * @returns {BufferGeometry}
 */
export function buildSigilGeometry(paths, opts = {}) {
  const { symmetry = 1, phase = 0, mirror = false, resolution = 240 } = opts;

  // 1) symmetry. Resample fine enough that the curve itself never facets along
  //    its length (segments well below the stroke width).
  let set = toPathSet(paths);
  const size = Math.max(boundsOf(set).width, boundsOf(set).height, 1e-6);
  const thickness = opts.thickness ?? size * 0.06;
  const resample = opts.resample ?? thickness * 0.12;

  set = set.map((p) => resampleByLength(p, resample));
  if (symmetry > 1 || mirror) {
    set = radialSymmetry(set, { symmetry, phase, mirror, center: opts.center });
  }

  // 2) distance field + 3) filled marching squares.
  // Keep blur light so corners/tips/cusps stay sharp; taper resolves stroke ends
  // to points instead of round caps.
  const threshold = thickness * 0.5;
  const smooth = opts.smooth ?? 3; // only smooths height/normals; outline stays sharp
  const taper = opts.taper ?? 1;
  const taperPower = opts.taperPower ?? 0.6;
  const field = new DistanceField(set, {
    resolution,
    margin: threshold * 1.5,
    smooth,
    taper,
    taperPower,
  });
  const region = fillRegion(field, threshold);

  if (region.count === 0) {
    // Nothing crossed the threshold; return an empty geometry rather than throw.
    return new BufferGeometry();
  }

  // The sigilize pass blurs the point Position attribute and writes it
  // back to the mesh. This gives the filled marching-squares result its melted,
  // logo-like sigil shape instead of a literal fattened stroke.
  const sigilize = Math.max(0, Math.floor(opts.sigilize ?? 0));
  if (sigilize > 0) {
    blurRegionPositions(region, sigilize, opts.sigilizeWeight ?? 1);
  }

  // The shape profile graph drives the vertical profile from distance to the
  // finished boundary edge. The older centerline field is still available, but
  // boundary depth is the procedural-match path and handles crossings/interiors
  // much more like the the generated shape.
  const depthMode = opts.depthMode ?? 'boundary';
  if (depthMode === 'boundary') {
    applyBoundaryDepth(region, opts.edgeFalloff ?? threshold, Math.max(0, Math.floor(opts.heightSmooth ?? smooth)));
  } else if (sigilize > 0) {
    resampleCenterlineDepth(region, field, threshold);
  }

  // 4) solidify into top dome (+ optional walls and base).
  const base = Math.max(0, opts.base ?? 0);
  return solidify(region, base);
}

function blurRegionPositions(region, iterations, weight) {
  const w = clamp01(weight);
  if (iterations <= 0 || w <= 0) return;

  const { positions, indices, count } = region;
  const adjacency = buildAdjacency(count, indices);
  let x = new Float32Array(count);
  let y = new Float32Array(count);
  let nx = new Float32Array(count);
  let ny = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    x[i] = positions[i * 3];
    y[i] = positions[i * 3 + 1];
  }

  for (let pass = 0; pass < iterations; pass++) {
    for (let i = 0; i < count; i++) {
      const neighbors = adjacency[i];
      if (!neighbors || neighbors.length === 0) {
        nx[i] = x[i];
        ny[i] = y[i];
        continue;
      }
      let sx = 0, sy = 0;
      for (let k = 0; k < neighbors.length; k++) {
        const j = neighbors[k];
        sx += x[j];
        sy += y[j];
      }
      const inv = 1 / neighbors.length;
      nx[i] = x[i] + (sx * inv - x[i]) * w;
      ny[i] = y[i] + (sy * inv - y[i]) * w;
    }
    [x, nx] = [nx, x];
    [y, ny] = [ny, y];
  }

  for (let i = 0; i < count; i++) {
    positions[i * 3] = x[i];
    positions[i * 3 + 1] = y[i];
  }
}

function applyBoundaryDepth(region, falloff, smoothPasses) {
  const { positions, depth, grad, boundary, count, indices } = region;
  if (!boundary || boundary.length === 0) {
    depth.fill(1);
    grad.fill(0);
    return;
  }

  const width = Math.max(1e-6, falloff);
  const field = makeBoundaryField(positions, boundary, width);

  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    depth[i] = Math.min(1, boundaryDistance(x, y, field, width) / width);
  }

  if (smoothPasses > 0) {
    smoothVertexScalar(depth, buildAdjacency(count, indices), smoothPasses, 0.5);
  }

  computeScalarGradient(positions, indices, depth, grad, count);
}

function resampleCenterlineDepth(region, field, threshold) {
  const { positions, depth, grad, count } = region;
  const gradStep = field.cell * 1.25;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    depth[i] = field.depth(x, y, threshold);
    const [gx, gy] = field.depthGradient(x, y, threshold, gradStep);
    grad[i * 2] = gx;
    grad[i * 2 + 1] = gy;
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

function smoothVertexScalar(values, adjacency, iterations, weight) {
  const w = clamp01(weight);
  const tmp = new Float32Array(values.length);
  for (let pass = 0; pass < iterations; pass++) {
    for (let i = 0; i < values.length; i++) {
      const neighbors = adjacency[i];
      if (!neighbors || neighbors.length === 0) {
        tmp[i] = values[i];
        continue;
      }
      let sum = 0;
      for (let k = 0; k < neighbors.length; k++) sum += values[neighbors[k]];
      const avg = sum / neighbors.length;
      tmp[i] = values[i] + (avg - values[i]) * w;
    }
    values.set(tmp);
  }
}

function makeBoundaryField(positions, boundary, falloff) {
  const segments = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [a, b] of boundary) {
    const ax = positions[a * 3], ay = positions[a * 3 + 1];
    const bx = positions[b * 3], by = positions[b * 3 + 1];
    segments.push([ax, ay, bx, by]);
    minX = Math.min(minX, ax, bx);
    minY = Math.min(minY, ay, by);
    maxX = Math.max(maxX, ax, bx);
    maxY = Math.max(maxY, ay, by);
  }

  const cell = Math.max(falloff, 1e-6);
  const buckets = new Map();
  const key = (i, j) => `${i}|${j}`;
  const ix = (x) => Math.floor((x - minX) / cell);
  const iy = (y) => Math.floor((y - minY) / cell);

  for (let s = 0; s < segments.length; s++) {
    const [ax, ay, bx, by] = segments[s];
    const x0 = ix(Math.min(ax, bx) - falloff);
    const x1 = ix(Math.max(ax, bx) + falloff);
    const y0 = iy(Math.min(ay, by) - falloff);
    const y1 = iy(Math.max(ay, by) + falloff);
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const k = key(i, j);
        let list = buckets.get(k);
        if (!list) buckets.set(k, list = []);
        list.push(s);
      }
    }
  }

  return { segments, buckets, minX, minY, cell, key, ix, iy };
}

function boundaryDistance(x, y, field, cap) {
  const cx = field.ix(x);
  const cy = field.iy(y);
  let best = cap * cap;
  const seen = new Set();

  for (let j = cy - 1; j <= cy + 1; j++) {
    for (let i = cx - 1; i <= cx + 1; i++) {
      const list = field.buckets.get(field.key(i, j));
      if (!list) continue;
      for (let k = 0; k < list.length; k++) {
        const si = list[k];
        if (seen.has(si)) continue;
        seen.add(si);
        const s = field.segments[si];
        const d2 = distToSegment2(x, y, s[0], s[1], s[2], s[3]);
        if (d2 < best) best = d2;
      }
    }
  }

  return Math.sqrt(best);
}

function distToSegment2(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  return dx * dx + dy * dy;
}

function computeScalarGradient(positions, indices, values, grad, count) {
  grad.fill(0);
  const weight = new Float32Array(count);

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const ax = positions[a * 3], ay = positions[a * 3 + 1];
    const bx = positions[b * 3], by = positions[b * 3 + 1];
    const cx = positions[c * 3], cy = positions[c * 3 + 1];
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(det) < 1e-12) continue;

    const db = values[b] - values[a];
    const dc = values[c] - values[a];
    const gx = (db * (cy - ay) - dc * (by - ay)) / det;
    const gy = ((bx - ax) * dc - (cx - ax) * db) / det;
    const area = Math.abs(det) * 0.5;

    grad[a * 2] += gx * area; grad[a * 2 + 1] += gy * area; weight[a] += area;
    grad[b * 2] += gx * area; grad[b * 2 + 1] += gy * area; weight[b] += area;
    grad[c * 2] += gx * area; grad[c * 2 + 1] += gy * area; weight[c] += area;
  }

  for (let i = 0; i < count; i++) {
    if (weight[i] <= 0) continue;
    grad[i * 2] /= weight[i];
    grad[i * 2 + 1] /= weight[i];
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Turn the flat fill into geometry attributes. With base > 0 we add a flat
 * bottom and extruded side walls so the result is a closed solid.
 */
function solidify(region, base) {
  const { positions, depth, grad, indices, boundary, count } = region;

  // Output arrays (top surface first, then base + walls if base > 0).
  const pos = [];
  const dep = [];
  const gra = [];
  const nrm = [];
  const dome = [];
  const idx = [];

  // -- top surface: domed, normals computed in the shader --
  for (let k = 0; k < count; k++) {
    pos.push(positions[k * 3], positions[k * 3 + 1], 0);
    dep.push(depth[k]);
    gra.push(grad[k * 2], grad[k * 2 + 1]);
    nrm.push(0, 0, 1);
    dome.push(1);
  }
  for (let t = 0; t < indices.length; t++) idx.push(indices[t]);

  if (base > 0) {
    // -- flat base: copy of the top XY at z = -base, reversed winding --
    const baseOffset = pos.length / 3;
    for (let k = 0; k < count; k++) {
      pos.push(positions[k * 3], positions[k * 3 + 1], -base);
      dep.push(0);
      gra.push(0, 0);
      nrm.push(0, 0, -1);
      dome.push(0);
    }
    for (let t = 0; t < indices.length; t += 3) {
      idx.push(baseOffset + indices[t], baseOffset + indices[t + 2], baseOffset + indices[t + 1]);
    }

    addSideWalls(pos, dep, gra, nrm, dome, idx, positions, boundary, base);
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('aDepth', new BufferAttribute(new Float32Array(dep), 1));
  geo.setAttribute('aGrad', new BufferAttribute(new Float32Array(gra), 2));
  geo.setAttribute('aNormal', new BufferAttribute(new Float32Array(nrm), 3));
  geo.setAttribute('aDome', new BufferAttribute(new Float32Array(dome), 1));
  // A plausible static normal so non-node renderers / pickers still work.
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  const vertCount = pos.length / 3;
  geo.setIndex(vertCount > 65535 ? new BufferAttribute(new Uint32Array(idx), 1)
                                 : new BufferAttribute(new Uint16Array(idx), 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function addSideWalls(pos, dep, gra, nrm, dome, idx, positions, boundary, base) {
  for (const loop of boundaryLoops(boundary)) {
    if (loop.length < 2) continue;

    const closed = loop.length > 2 && loop[0] === loop[loop.length - 1];
    const verts = closed ? loop.slice(0, -1) : loop;
    if (verts.length < 2) continue;

    const normals = sideLoopNormals(verts, positions, closed);
    const topOffset = pos.length / 3;

    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      const nx = normals[i * 2];
      const ny = normals[i * 2 + 1];
      pos.push(positions[v * 3], positions[v * 3 + 1], 0);
      dep.push(0);
      gra.push(0, 0);
      nrm.push(nx, ny, 0);
      dome.push(0);
    }

    const bottomOffset = pos.length / 3;
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      const nx = normals[i * 2];
      const ny = normals[i * 2 + 1];
      pos.push(positions[v * 3], positions[v * 3 + 1], -base);
      dep.push(0);
      gra.push(0, 0);
      nrm.push(nx, ny, 0);
      dome.push(0);
    }

    const limit = closed ? verts.length : verts.length - 1;
    for (let i = 0; i < limit; i++) {
      const j = (i + 1) % verts.length;
      const topA = topOffset + i;
      const topB = topOffset + j;
      const botA = bottomOffset + i;
      const botB = bottomOffset + j;
      idx.push(topA, topB, botB, topA, botB, botA);
    }
  }
}

function boundaryLoops(boundary) {
  const outgoing = new Map();
  const adjacency = new Map();
  const unused = new Set();

  const addOutgoing = (a, b) => {
    let list = outgoing.get(a);
    if (!list) outgoing.set(a, list = []);
    list.push(b);
  };
  const addAdjacent = (a, b) => {
    let list = adjacency.get(a);
    if (!list) adjacency.set(a, list = []);
    list.push(b);
  };

  const edgeKey = (a, b) => `${a}|${b}`;
  for (const [a, b] of boundary) {
    addOutgoing(a, b);
    addAdjacent(a, b);
    addAdjacent(b, a);
    unused.add(edgeKey(a, b));
  }

  const loops = [];
  while (unused.size) {
    const first = unused.values().next().value;
    const [a0, b0] = first.split('|').map(Number);
    unused.delete(first);

    const loop = [a0, b0];
    let curr = b0;

    while (true) {
      const next = (outgoing.get(curr) || []).find((candidate) => unused.has(edgeKey(curr, candidate)));

      if (next === undefined) break;
      unused.delete(edgeKey(curr, next));
      loop.push(next);
      curr = next;
      if (curr === loop[0]) break;
    }

    if (loop[loop.length - 1] !== loop[0]) {
      curr = a0;
      while (true) {
        const next = (adjacency.get(curr) || []).find((candidate) => {
          return unused.has(edgeKey(candidate, curr)) || unused.has(edgeKey(curr, candidate));
        });

        if (next === undefined) break;
        unused.delete(edgeKey(next, curr));
        unused.delete(edgeKey(curr, next));
        loop.unshift(next);
        curr = next;
      }
    }

    loops.push(loop);
  }

  return loops;
}

function sideLoopNormals(verts, positions, closed) {
  const normals = new Float32Array(verts.length * 2);
  const segmentCount = closed ? verts.length : verts.length - 1;

  for (let i = 0; i < segmentCount; i++) {
    const j = (i + 1) % verts.length;
    const a = verts[i];
    const b = verts[j];
    const ax = positions[a * 3], ay = positions[a * 3 + 1];
    const bx = positions[b * 3], by = positions[b * 3 + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len <= 1e-8) continue;

    const nx = dy / len;
    const ny = -dx / len;
    normals[i * 2] += nx;
    normals[i * 2 + 1] += ny;
    normals[j * 2] += nx;
    normals[j * 2 + 1] += ny;
  }

  for (let i = 0; i < verts.length; i++) {
    let nx = normals[i * 2];
    let ny = normals[i * 2 + 1];
    const len = Math.hypot(nx, ny);
    if (len > 1e-8) {
      nx /= len;
      ny /= len;
    } else {
      nx = 1;
      ny = 0;
    }
    normals[i * 2] = nx;
    normals[i * 2 + 1] = ny;
  }

  return normals;
}
