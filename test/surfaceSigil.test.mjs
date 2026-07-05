import assert from 'node:assert/strict';
import { SphereGeometry } from 'three';
import { buildSurfaceSigilGeometry } from '../src/surfaceSigil.js';

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
  sigilize: 4,
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
  sigilize: 0,
  heightSmooth: 0,
});
const flatDepth = flat.getAttribute('aDepth').array;
let flatMax = -Infinity;
for (let i = 0; i < flatDepth.length; i++) flatMax = Math.max(flatMax, flatDepth[i]);
assert.ok(flatMax <= 1 + 1e-6, `plateau depth ${flatMax} clamped`);

console.log(`surface sigil OK · verts ${pos.count} · carve max ${maxDepth.toFixed(2)}`);
