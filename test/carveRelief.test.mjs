import assert from 'node:assert/strict';
import { buildSigilGeometry } from '../src/index.js';

// A straight fat bar: region halfwidth = thickness/2 = 0.1. With edgeFalloff
// 0.05 the spine sits two falloffs from the rim, so carve depth should reach
// ~2 while plateau clamps at 1.
const BAR = [[-1, 0], [1, 0]];
const OPTS = {
  thickness: 0.2,
  edgeFalloff: 0.05,
  resolution: 240,
  smooth: 0,
  taper: 0,
  sigilize: 0,
  heightSmooth: 0,
};

function depthStats(geo) {
  const depth = geo.getAttribute('aDepth').array;
  const dome = geo.getAttribute('aDome').array;
  let max = -Infinity;
  let finite = true;
  for (let i = 0; i < depth.length; i++) {
    if (!Number.isFinite(depth[i])) finite = false;
    if (dome[i] === 1 && depth[i] > max) max = depth[i];
  }
  return { depth, max, finite };
}

// --- plateau relief clamps depth at 1 ---
{
  const geo = buildSigilGeometry(BAR, { ...OPTS, relief: 'plateau' });
  const { max, finite } = depthStats(geo);
  assert.ok(finite, 'plateau depth has no NaN/Infinity');
  assert.ok(max <= 1 + 1e-6, `plateau max depth ${max} stays <= 1`);
  assert.ok(max > 0.95, `plateau reaches full height (max ${max})`);
}

// --- carve relief keeps rising past the falloff ---
{
  const geo = buildSigilGeometry(BAR, { ...OPTS, relief: 'carve' });
  const { max, finite } = depthStats(geo);
  assert.ok(finite, 'carve depth has no NaN/Infinity');
  assert.ok(max > 1.6 && max < 2.2, `spine depth ${max} near halfwidth/falloff = 2`);
}

// --- carve clamped at 1 matches plateau when no field blend is active ---
{
  const plateau = buildSigilGeometry(BAR, { ...OPTS, relief: 'plateau' });
  const carve = buildSigilGeometry(BAR, { ...OPTS, relief: 'carve' });
  const dp = plateau.getAttribute('aDepth').array;
  const dc = carve.getAttribute('aDepth').array;
  assert.equal(dp.length, dc.length, 'same topology');
  for (let i = 0; i < dp.length; i++) {
    assert.ok(Math.abs(Math.min(1, dc[i]) - dp[i]) < 1e-5,
      `vertex ${i}: min(1, carve ${dc[i]}) == plateau ${dp[i]}`);
  }
}

// --- carve pins the rim to depth 0 ---
{
  const geo = buildSigilGeometry(BAR, { ...OPTS, relief: 'carve', base: 0.05 });
  const pos = geo.getAttribute('position').array;
  const depth = geo.getAttribute('aDepth').array;
  const dome = geo.getAttribute('aDome').array;
  // Wall vertices duplicate rim positions at z=0; the matching dome vertex
  // at the same xy must carry depth 0.
  const rim = new Set();
  for (let i = 0; i < dome.length; i++) {
    if (dome[i] === 0 && pos[i * 3 + 2] === 0) {
      rim.add(`${pos[i * 3].toFixed(6)}|${pos[i * 3 + 1].toFixed(6)}`);
    }
  }
  assert.ok(rim.size > 0, 'walls exist');
  let checked = 0;
  for (let i = 0; i < dome.length; i++) {
    if (dome[i] !== 1) continue;
    if (rim.has(`${pos[i * 3].toFixed(6)}|${pos[i * 3 + 1].toFixed(6)}`)) {
      assert.ok(depth[i] === 0, `rim vertex ${i} depth ${depth[i]} == 0`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'matched rim vertices');
}

// --- reliefRange caps carve depth ---
{
  const geo = buildSigilGeometry(BAR, { ...OPTS, relief: 'carve', reliefRange: 1.5 });
  const { max } = depthStats(geo);
  assert.ok(max <= 1.5 + 1e-6, `capped depth ${max} <= reliefRange`);
}

console.log('carve relief OK');
