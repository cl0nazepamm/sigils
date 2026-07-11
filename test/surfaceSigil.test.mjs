import assert from 'node:assert/strict';
import { PlaneGeometry, SphereGeometry } from 'three';
import { bspline } from '../src/bspline.js';
import { createMeshIndex } from '../src/meshIndex.js';
import { buildSurfaceSigilGeometry, SURFACE_SIGIL_DEFAULTS } from '../src/surfaceSigil.js';

assert.equal(SURFACE_SIGIL_DEFAULTS.relief, 'carve', 'public surface defaults match the builder');
assert.equal(SURFACE_SIGIL_DEFAULTS.fieldResolution, 1, 'field resolution has a stable public default');
assert.equal(SURFACE_SIGIL_DEFAULTS.pointRadius, false, 'point radius is explicitly opt-in');
assert.equal(SURFACE_SIGIL_DEFAULTS.closed, false, 'surface paths stay open unless explicitly closed');

// Paint a ring around a sphere's equator and grow the fill on the surface.
const RADIUS = 1;
const sphere = new SphereGeometry(RADIUS, 96, 64);

const ring = [];
for (let i = 0; i <= 128; i++) {
  const a = (i / 128) * Math.PI * 2;
  ring.push([Math.cos(a) * RADIUS, 0, Math.sin(a) * RADIUS]);
}

const PEAK = 0.04;
const geo = buildSurfaceSigilGeometry(sphere, [ring], {
  thickness: 0.3,
  relief: 'carve',
  edgeFalloff: 0.06,
  peakHeight: PEAK,
  laplacian: 4,
  heightSmooth: 2,
});

const pos = geo.getAttribute('position');
const depth = geo.getAttribute('aDepth').array;
assert.ok(pos && pos.count > 500, `fill has real coverage (${pos?.count} verts)`);

let maxDepth = -Infinity;
let maxR = -Infinity, minR = Infinity;
let finite = true;
for (let i = 0; i < pos.count; i++) {
  const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
  if (!Number.isFinite(r) || !Number.isFinite(depth[i])) finite = false;
  maxR = Math.max(maxR, r);
  minR = Math.min(minR, r);
  maxDepth = Math.max(maxDepth, depth[i]);
}
assert.ok(finite, 'no NaN/Infinity in output');

// carve: the band is wider than the falloff, so depth must exceed 1
assert.ok(maxDepth > 1, `carve depth ${maxDepth} rises past 1`);

// displaced outward along the sphere normal, never inward
assert.ok(minR > RADIUS - 1e-3, `rim stays on the surface (minR ${minR})`);
assert.ok(maxR > RADIUS + PEAK * 0.5, `spine is raised off the surface (maxR ${maxR})`);
assert.ok(maxR <= RADIUS + PEAK * maxDepth + 1e-3, 'raise bounded by peak*depth');

// the fill hugs the equator band only — nothing near the poles
let maxAbsY = 0;
for (let i = 0; i < pos.count; i++) maxAbsY = Math.max(maxAbsY, Math.abs(pos.getY(i)));
assert.ok(maxAbsY < 0.5, `fill confined to the band (maxY ${maxAbsY})`);

// plateau twin clamps at 1
const flat = buildSurfaceSigilGeometry(sphere, [ring], {
  thickness: 0.3,
  relief: 'plateau',
  peakHeight: PEAK,
  laplacian: 0,
  heightSmooth: 0,
});
const flatDepth = flat.getAttribute('aDepth').array;
let flatMax = -Infinity;
for (let i = 0; i < flatDepth.length; i++) flatMax = Math.max(flatMax, flatDepth[i]);
assert.ok(flatMax <= 1 + 1e-6, `plateau depth ${flatMax} clamped`);

// Height is post-topology displacement: it stays genuinely independent from
// stroke width, unlike a volumetric extractor whose profile height changes the
// grid topology.
const low = buildSurfaceSigilGeometry(sphere, [ring], {
  thickness: 0.3,
  relief: 'plateau',
  peakHeight: 0.02,
  laplacian: 0,
  heightSmooth: 0,
});
const tall = buildSurfaceSigilGeometry(sphere, [ring], {
  thickness: 0.3,
  relief: 'plateau',
  peakHeight: 0.08,
  laplacian: 0,
  heightSmooth: 0,
});
assert.deepEqual(Array.from(tall.getIndex().array), Array.from(low.getIndex().array),
  'independent height preserves patch topology');
assert.deepEqual(Array.from(tall.getAttribute('aDepth').array), Array.from(low.getAttribute('aDepth').array),
  'independent height preserves width coverage');
const maxRadius = (geometry) => {
  const p = geometry.getAttribute('position');
  let max = -Infinity;
  for (let i = 0; i < p.count; i++) max = Math.max(max, Math.hypot(p.getX(i), p.getY(i), p.getZ(i)));
  return max;
};
assert.ok(maxRadius(tall) - RADIUS > (maxRadius(low) - RADIUS) * 3.5,
  'independent height controls displacement');

const closedTaper = buildSurfaceSigilGeometry(sphere, [ring], {
  thickness: 0.3,
  relief: 'carve',
  edgeFalloff: 0.06,
  peakHeight: PEAK,
  laplacian: 4,
  heightSmooth: 2,
  taper: 4,
});
assert.deepEqual(Array.from(closedTaper.getAttribute('position').array), Array.from(pos.array),
  'closed paths ignore open-end taper');

// A UV seam is an attribute boundary, not a relief boundary. The old
// open-edge-derived depth pinned the equator's internal seam to zero and made a
// visible dent. Field-derived relief must stay raised through that seam.
let internalSeamZeros = 0;
for (let i = 0; i < pos.count; i++) {
  if (depth[i] < 1e-6 && Math.abs(pos.getY(i)) < 0.03) internalSeamZeros++;
}
assert.equal(internalSeamZeros, 0, 'internal UV seam is not mistaken for the patch rim');

// Dense imports are commonly triangle soup. Coincident, normal-compatible
// corners are welded in the working patch without touching the visible source.
const soup = new SphereGeometry(RADIUS, 96, 64).toNonIndexed();
const soupGeo = buildSurfaceSigilGeometry(soup, [ring], {
  thickness: 0.3,
  edgeFalloff: 0.06,
  peakHeight: PEAK,
});
assert.ok(soupGeo.getAttribute('position').count <= pos.count * 1.05,
  'non-indexed source compacts to the same surface patch density');
assert.ok(Array.from(soupGeo.getAttribute('position').array).every(Number.isFinite),
  'non-indexed source stays finite');

const positionOnly = new SphereGeometry(RADIUS, 48, 32);
positionOnly.deleteAttribute('normal');
const generatedNormals = buildSurfaceSigilGeometry(positionOnly, [ring], {
  thickness: 0.3,
  peakHeight: PEAK,
});
assert.ok(generatedNormals.getAttribute('position').count > 0,
  'position-only source gets private generated normals');

// Field resolution is a brush-relative curve tolerance, not target
// decimation. Lower precision must reduce field segments while the spatial
// broad phase keeps work local to a small fraction of source triangles.
const wave = Array.from({ length: 121 }, (_, i) => {
  const x = -0.8 + i * (1.6 / 120);
  return [x, 0.06 * Math.sin(x * 18), Math.sqrt(1 - x * x)];
});
const coarseField = buildSurfaceSigilGeometry(sphere, [wave], {
  thickness: 0.12,
  fieldResolution: 0.25,
});
const fineField = buildSurfaceSigilGeometry(sphere, [wave], {
  thickness: 0.12,
  fieldResolution: 2,
});
assert.ok(coarseField.userData.surfaceSigil.fieldSegmentCount
  < fineField.userData.surfaceSigil.fieldSegmentCount,
'field resolution changes the stroke-field segment budget');
assert.ok(coarseField.userData.surfaceSigil.patchVertexCount
  < fineField.userData.surfaceSigil.patchVertexCount,
'field resolution changes pre-cut surface sampling');
assert.ok(fineField.userData.surfaceSigil.candidateTriangleCount
  < fineField.userData.surfaceSigil.sourceTriangleCount * 0.5,
'dense target evaluation stays local to the painted band');

// Open paths taper in the field itself: width and height both flow to a point
// without moving the target surface or post-pinching the output geometry.
const plane = new PlaneGeometry(2, 1, 80, 40);
const openLine = Array.from({ length: 65 }, (_, i) => [-0.8 + i * (1.6 / 64), 0, 0]);
const liquidOpts = {
  thickness: 0.24,
  relief: 'round',
  peakHeight: 0.08,
  taper: 4,
  taperPower: 1.15,
  fieldResolution: 0.5,
  laplacian: 0,
  heightSmooth: 0,
};
const unpolished = buildSurfaceSigilGeometry(plane, [openLine], {
  ...liquidOpts,
  normalSmooth: 0,
});
const polished = buildSurfaceSigilGeometry(plane, [openLine], {
  ...liquidOpts,
  normalSmooth: 6,
});
const bandExtents = (geometry, minX, maxX) => {
  const p = geometry.getAttribute('position');
  let width = 0, height = 0;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    if (x < minX || x >= maxX) continue;
    width = Math.max(width, Math.abs(p.getY(i)));
    height = Math.max(height, p.getZ(i));
  }
  return { width, height };
};
const tip = bandExtents(polished, -0.8, -0.68);
const middle = bandExtents(polished, -0.1, 0.1);
assert.ok(tip.width < middle.width * 0.2, 'field taper narrows the open tip');
assert.ok(tip.height < middle.height * 0.5, 'field taper lowers the open tip');
assert.deepEqual(Array.from(polished.getAttribute('position').array),
  Array.from(unpolished.getAttribute('position').array),
  'liquid polish changes shading only, never surface positions');

// Radius-bearing surface paths are explicit opt-in: point[3] scales the local
// half-width, is interpolated along the segment, and expands the broad phase.
const radiusPlane = new PlaneGeometry(2, 1.2, 120, 72);
const radiusPath = [[-0.8, 0, 0, 0.3], [0.8, 0, 0, 2.2]];
const radiusOpts = {
  thickness: 0.24,
  relief: 'plateau',
  peakHeight: 0,
  laplacian: 0,
  heightSmooth: 0,
  fieldResolution: 1,
};
const indexedPlane = createMeshIndex(radiusPlane);
const queriedRadii = [];
const radiusGeo = buildSurfaceSigilGeometry(radiusPlane, [radiusPath], {
  ...radiusOpts,
  pointRadius: true,
  meshIndex: {
    trianglesNearSegment(a, b, radius) {
      queriedRadii.push(radius);
      return indexedPlane.trianglesNearSegment(a, b, radius);
    },
  },
});
const localWidth = (geometry, minX, maxX) => {
  const p = geometry.getAttribute('position');
  let width = 0;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    if (x >= minX && x < maxX) width = Math.max(width, Math.abs(p.getY(i)));
  }
  return width;
};
const narrowWidth = localWidth(radiusGeo, -0.65, -0.4);
const wideWidth = localWidth(radiusGeo, 0.4, 0.65);
assert.ok(wideWidth > narrowWidth * 2.25,
  `interpolated point radius widens the surface patch (${narrowWidth} -> ${wideWidth})`);
assert.ok(wideWidth > radiusOpts.thickness * 0.75,
  'wide endpoint reaches beyond the legacy broad-phase radius');
assert.ok(Math.abs(Math.max(...queriedRadii) - radiusOpts.thickness * 0.5 * 2.2) < 1e-12,
  'broad phase is sized by the segment maximum radius scale');

// Default mode ignores a fourth coordinate exactly; opting in with an all-one
// profile is also bit-for-bit identical to the legacy 3D path.
const legacyPath = [[-0.8, 0, 0], [0.8, 0, 0]];
const legacyRadiusGeo = buildSurfaceSigilGeometry(radiusPlane, [legacyPath], radiusOpts);
const ignoredRadiusGeo = buildSurfaceSigilGeometry(radiusPlane, [radiusPath], radiusOpts);
const unitRadiusGeo = buildSurfaceSigilGeometry(
  radiusPlane,
  [[[-0.8, 0, 0, 1], [0.8, 0, 0, 1]]],
  { ...radiusOpts, pointRadius: true },
);
for (const geometry of [ignoredRadiusGeo, unitRadiusGeo]) {
  assert.deepEqual(Array.from(geometry.getIndex().array), Array.from(legacyRadiusGeo.getIndex().array),
    'point-radius compatibility preserves legacy topology');
  assert.deepEqual(Array.from(geometry.getAttribute('position').array),
    Array.from(legacyRadiusGeo.getAttribute('position').array),
    'point-radius compatibility preserves legacy positions exactly');
  assert.deepEqual(Array.from(geometry.getAttribute('aDepth').array),
    Array.from(legacyRadiusGeo.getAttribute('aDepth').array),
    'point-radius compatibility preserves legacy field values exactly');
}

// Periodic 3D B-spline output deliberately omits a duplicate seam sample.
// `closed:true` composes it directly into the patch builder and is exactly
// equivalent to the legacy explicit-seam representation.
const periodicPath = bspline([
  [-0.6, -0.3, 0],
  [0.6, -0.3, 0],
  [0.6, 0.3, 0],
  [-0.6, 0.3, 0],
], {
  closed: true,
  samplesPerSpan: 8,
  radiusScales: [0.5, 1, 2, 0.75],
});
const periodicOpts = {
  thickness: 0.18,
  pointRadius: true,
  relief: 'plateau',
  peakHeight: 0,
  taper: 4,
  laplacian: 0,
  heightSmooth: 0,
  fieldResolution: 0.5,
};
const closedOptionGeo = buildSurfaceSigilGeometry(radiusPlane, [periodicPath], {
  ...periodicOpts,
  closed: true,
});
const explicitSeamGeo = buildSurfaceSigilGeometry(
  radiusPlane,
  [[...periodicPath, periodicPath[0].slice()]],
  periodicOpts,
);
assert.equal(closedOptionGeo.userData.surfaceSigil.fieldSegmentCount, periodicPath.length,
  'closed option adds exactly one periodic segment');
assert.deepEqual(Array.from(closedOptionGeo.getIndex().array),
  Array.from(explicitSeamGeo.getIndex().array),
  'closed option matches explicit-seam topology');
assert.deepEqual(Array.from(closedOptionGeo.getAttribute('position').array),
  Array.from(explicitSeamGeo.getAttribute('position').array),
  'closed option matches explicit-seam positions');
assert.deepEqual(Array.from(closedOptionGeo.getAttribute('aDepth').array),
  Array.from(explicitSeamGeo.getAttribute('aDepth').array),
  'closed option matches explicit-seam radius field and ignores open taper');

const normalVariation = (geometry) => {
  const n = geometry.getAttribute('normal');
  const index = geometry.getIndex();
  let sum = 0, edges = 0;
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
    for (const [v0, v1] of [[a, b], [b, c], [c, a]]) {
      sum += 1 - (n.getX(v0) * n.getX(v1) + n.getY(v0) * n.getY(v1) + n.getZ(v0) * n.getZ(v1));
      edges++;
    }
  }
  return sum / edges;
};
assert.ok(normalVariation(polished) < normalVariation(unpolished),
  'liquid polish reduces triangle-scale normal variation');

console.log(`surface sigil OK · verts ${pos.count} · carve max ${maxDepth.toFixed(2)}`);
