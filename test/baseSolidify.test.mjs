import assert from 'node:assert/strict';
import { buildSigilGeometry } from '../src/index.js';

const geometry = buildSigilGeometry([[0, 0], [1, 0], [1, 0.4]], {
  base: 0.08,
  thickness: 0.18,
  resolution: 96,
  smooth: 3,
  heightSmooth: 3,
  sigilize: 8,
  sigilizeWeight: 0.7,
});

const position = geometry.getAttribute('position');
const depth = geometry.getAttribute('aDepth');
const dome = geometry.getAttribute('aDome');
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

console.log('base solidify OK');

function pointKey(position, i) {
  return `${position.getX(i).toFixed(6)}|${position.getY(i).toFixed(6)}`;
}
