import assert from 'node:assert/strict';
import { buildSigilGeometry } from '../src/index.js';

const geometry = buildSigilGeometry([[0, 0], [1, 0], [1, 0.4]], {
  base: 0.08,
  thickness: 0.18,
  resolution: 96,
  smooth: 3,
  heightSmooth: 3,
  laplacian: 8,
  laplacianWeight: 0.7,
});

const position = geometry.getAttribute('position');
const depth = geometry.getAttribute('aDepth');
const dome = geometry.getAttribute('aDome');
const normal = geometry.getAttribute('aNormal');
const index = geometry.getIndex();
const topByXY = new Map();

for (let i = 0; i < position.count; i++) {
  if (dome.getX(i) !== 1) continue;
  topByXY.set(pointKey(position, i), i);
}

let sideTopMatches = 0;
let maxRimDepth = 0;
for (let i = 0; i < position.count; i++) {
  if (dome.getX(i) !== 0 || Math.abs(position.getZ(i)) > 1e-9) continue;
  const top = topByXY.get(pointKey(position, i));
  if (top === undefined) continue;
  sideTopMatches++;
  maxRimDepth = Math.max(maxRimDepth, depth.getX(top));
}

assert.ok(sideTopMatches > 0, 'solid base creates side-wall top vertices');
assert.ok(maxRimDepth < 1e-6, 'top rim depth stays pinned to side-wall height');

let checkedFaces = 0;
for (let i = 0; i < index.count; i += 3) {
  const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
  const abx = position.getX(b) - position.getX(a);
  const aby = position.getY(b) - position.getY(a);
  const abz = position.getZ(b) - position.getZ(a);
  const acx = position.getX(c) - position.getX(a);
  const acy = position.getY(c) - position.getY(a);
  const acz = position.getZ(c) - position.getZ(a);
  const fx = aby * acz - abz * acy;
  const fy = abz * acx - abx * acz;
  const fz = abx * acy - aby * acx;
  const faceArea2 = Math.hypot(fx, fy, fz);
  if (faceArea2 < 1e-12) continue;

  const nx = normal.getX(a) + normal.getX(b) + normal.getX(c);
  const ny = normal.getY(a) + normal.getY(b) + normal.getY(c);
  const nz = normal.getZ(a) + normal.getZ(b) + normal.getZ(c);
  assert.ok(fx * nx + fy * ny + fz * nz > 0, 'face winding agrees with authored outward normal');
  checkedFaces++;
}
assert.ok(checkedFaces > 0, 'solid base exposes non-degenerate faces for winding validation');

console.log('base solidify OK');

function pointKey(position, i) {
  return `${position.getX(i).toFixed(6)}|${position.getY(i).toFixed(6)}`;
}
