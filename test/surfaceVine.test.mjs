import assert from 'node:assert/strict';
import { BoxGeometry, SphereGeometry } from 'three';
import { buildSurfaceVineGeometry, buildSurfaceVineFieldGeometry } from '../src/surfaceVine.js';
import { createMeshIndex } from '../src/meshIndex.js';

// ---- shared fixtures: strokes on the unit sphere (p on surface, n = p) ----

function arcStroke(lonStart, lonEnd, lat, steps = 60) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const lon = lonStart + ((lonEnd - lonStart) * i) / steps;
    const p = [
      Math.cos(lat) * Math.cos(lon),
      Math.sin(lat),
      Math.cos(lat) * Math.sin(lon),
    ];
    out.push({ p, n: [...p] });
  }
  return out;
}

const OPTS = { radius: 0.05, wobble: 0.3, taper: 3, thornSpacing: 6, thornLength: 3, seed: 7 };

// ---- swept preview builder ----

const sweep = buildSurfaceVineGeometry(arcStroke(-1, 1, 0.2), OPTS);
{
  const pos = sweep.getAttribute('position');
  assert.ok(pos.count > 200, `sweep has coverage (${pos.count} verts)`);
  for (let i = 0; i < pos.array.length; i++) {
    assert.ok(Number.isFinite(pos.array[i]), 'sweep positions finite');
  }
  const again = buildSurfaceVineGeometry(arcStroke(-1, 1, 0.2), OPTS);
  assert.deepEqual(Array.from(again.getAttribute('position').array.slice(0, 30)),
    Array.from(pos.array.slice(0, 30)), 'sweep deterministic for a seed');
}

// ---- field builder: manifold, outward, welded ----

function edgeUse(geo) {
  const idx = geo.getIndex().array;
  const use = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e], b = idx[t + ((e + 1) % 3)];
      const key = a < b ? a * 1e7 + b : b * 1e7 + a;
      use.set(key, (use.get(key) ?? 0) + 1);
    }
  }
  return use;
}

function signedVolume(geo) {
  const idx = geo.getIndex().array;
  const p = geo.getAttribute('position');
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ax = p.array[a], ay = p.array[a + 1], az = p.array[a + 2];
    const bx = p.array[b], by = p.array[b + 1], bz = p.array[b + 2];
    const cx = p.array[c], cy = p.array[c + 1], cz = p.array[c + 2];
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

function componentCount(geo) {
  const idx = geo.getIndex().array;
  const n = geo.getAttribute('position').count;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(idx[t]);
    parent[find(idx[t + 1])] = a;
    parent[find(idx[t + 2])] = a;
  }
  const roots = new Set();
  for (let i = 0; i < n; i++) roots.add(find(i));
  return roots.size;
}

const single = buildSurfaceVineFieldGeometry(
  [{ samples: arcStroke(-1, 1, 0.2), seed: 7 }], OPTS);
{
  const pos = single.getAttribute('position');
  const nrm = single.getAttribute('normal');
  assert.ok(pos.count > 500, `field has coverage (${pos.count} verts)`);
  for (let i = 0; i < pos.array.length; i++) {
    assert.ok(Number.isFinite(pos.array[i]) && Number.isFinite(nrm.array[i]), 'field data finite');
  }
  // closed surface: no boundary (odd) edges; quad diagonals may coincide with
  // neighbor edges, so a small share of even counts above 2 is fine
  let manifold = 0, total = 0;
  for (const [, count] of edgeUse(single)) {
    assert.equal(count % 2, 0, 'field mesh has no open boundary edges');
    if (count === 2) manifold++;
    total++;
  }
  assert.ok(manifold / total > 0.95, `mostly manifold (${(manifold / total).toFixed(3)})`);
  assert.ok(signedVolume(single) > 0, `field winding is outward (vol ${signedVolume(single)})`);
  // normals roughly unit and agreeing with face orientation on average
  let unitOk = true;
  for (let i = 0; i < nrm.count; i++) {
    const l = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    if (Math.abs(l - 1) > 0.05) unitOk = false;
  }
  assert.ok(unitOk, 'gradient normals are unit length');
}

// crossing strokes weld into ONE body; distant strokes stay separate
const crossed = buildSurfaceVineFieldGeometry([
  { samples: arcStroke(-1, 1, 0.2), seed: 7 },
  { samples: arcStroke(-1, 1, -0.2).map(({ p, n }) => ({ p: [p[0], p[2] * 0.5 + p[1], p[2]], n })), seed: 8 },
], { ...OPTS, thornSpacing: 0 });
const apart = buildSurfaceVineFieldGeometry([
  { samples: arcStroke(-1, -0.4, 0.6), seed: 7 },
  { samples: arcStroke(0.4, 1, -0.6), seed: 8 },
], { ...OPTS, thornSpacing: 0 });
assert.equal(componentCount(apart), 2, 'distant strokes stay two bodies');
assert.equal(componentCount(crossed), 1, 'crossing strokes weld into one body');

// determinism of the field for identical input
{
  const again = buildSurfaceVineFieldGeometry(
    [{ samples: arcStroke(-1, 1, 0.2), seed: 7 }], OPTS);
  assert.equal(again.getAttribute('position').count, single.getAttribute('position').count,
    'field deterministic for a seed');
}

// ---- sigil-character options: relief profiles, peak, taper power ----

function radialRange(geo) {
  const p = geo.getAttribute('position');
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const r = Math.hypot(p.getX(i), p.getY(i), p.getZ(i));
    lo = Math.min(lo, r); hi = Math.max(hi, r);
  }
  return [lo, hi];
}

for (const relief of ['carve', 'plateau', 'round']) {
  const PEAK = 0.06;
  const geo = buildSurfaceVineFieldGeometry(
    [{ samples: arcStroke(-1, 1, 0.2), seed: 7 }],
    { ...OPTS, relief, peak: PEAK, thornSpacing: 0 },
  );
  const pos = geo.getAttribute('position');
  assert.ok(pos.count > 500, `${relief} field has coverage (${pos.count} verts)`);
  for (const [, count] of edgeUse(geo)) {
    assert.equal(count % 2, 0, `${relief} field has no open boundary edges`);
  }
  assert.equal(componentCount(geo), 1, `${relief} field is one body`);
  const [lo, hi] = radialRange(geo);
  // crest sits near sphereR + peak; base embeds a little below the surface
  assert.ok(hi <= 1 + PEAK * 1.25, `${relief} crest bounded by peak (${(hi - 1).toFixed(3)})`);
  assert.ok(hi >= 1 + PEAK * 0.55, `${relief} actually rises toward peak (${(hi - 1).toFixed(3)})`);
  assert.ok(lo >= 1 - PEAK * 0.6, `${relief} base only embeds slightly (${(1 - lo).toFixed(3)})`);
}

// a flatter peak stays lower than a tall one (peak decoupled from width)
{
  const lowGeo = buildSurfaceVineFieldGeometry(
    [{ samples: arcStroke(-1, 1, 0.2), seed: 7 }],
    { ...OPTS, relief: 'plateau', peak: 0.02, thornSpacing: 0, wobble: 0 },
  );
  const tallGeo = buildSurfaceVineFieldGeometry(
    [{ samples: arcStroke(-1, 1, 0.2), seed: 7 }],
    { ...OPTS, relief: 'plateau', peak: 0.09, thornSpacing: 0, wobble: 0 },
  );
  const dLow = radialRange(lowGeo)[1] - 1;
  const dTall = radialRange(tallGeo)[1] - 1;
  assert.ok(dTall > dLow * 2.5, `peak drives height (${dLow.toFixed(3)} vs ${dTall.toFixed(3)})`);
}

// Conform pulls the whole section into the mesh along −normal without changing peak.
{
  const peak = 0.06;
  const flush = buildSurfaceVineFieldGeometry(
    [{ samples: arcStroke(-1, 1, 0.2), seed: 7 }],
    { ...OPTS, relief: 'round', peak, conform: 0, thornSpacing: 0, wobble: 0 },
  );
  const sunk = buildSurfaceVineFieldGeometry(
    [{ samples: arcStroke(-1, 1, 0.2), seed: 7 }],
    { ...OPTS, relief: 'round', peak, conform: 0.55, thornSpacing: 0, wobble: 0 },
  );
  const flushHi = radialRange(flush)[1];
  const sunkHi = radialRange(sunk)[1];
  assert.ok(sunkHi < flushHi - peak * 0.25,
    `conform lowers the crest (${(flushHi - 1).toFixed(3)} → ${(sunkHi - 1).toFixed(3)})`);
}

// Budget coarsening must preserve authored peak/width aspect. The old path
// floored peak at cell·3.2 (vs width at cell·1.2), turning shallow carves into
// tall fins once a long drawing forced a coarse grid.
{
  const radius = 0.06;
  const peak = radius * 0.05;
  const longStroke = {
    samples: arcStroke(-Math.PI, Math.PI, 0.15, 180),
    seed: 3,
  };
  const shallow = buildSurfaceVineFieldGeometry([longStroke], {
    radius,
    peak,
    relief: 'carve',
    wobble: 0,
    taper: 2,
    thornSpacing: 0,
    detail: 3.2,
    cellBudget: 12_000,
  });
  const crest = radialRange(shallow)[1] - 1;
  assert.ok(shallow.getAttribute('position').count > 200, 'budgeted shallow carve still meshes');
  assert.ok(
    crest < peak * 8,
    `shallow carve stays near authored peak under budget pressure (${crest.toFixed(4)} vs peak ${peak})`,
  );
  assert.ok(
    crest < radius * 0.6,
    `shallow carve does not grow into width-scale fins (${crest.toFixed(4)} vs radius ${radius})`,
  );
  shallow.dispose();
}

// molten melt keeps the body closed and whole at full strength
{
  const molten = buildSurfaceVineFieldGeometry(
    [{ samples: arcStroke(-1, 1, 0.2), seed: 7 }],
    { ...OPTS, relief: 'carve', melt: 1, blend: 1.7 },
  );
  assert.ok(molten.getAttribute('position').count > 500, 'molten field has coverage');
  for (const [, count] of edgeUse(molten)) {
    assert.equal(count % 2, 0, 'molten field has no open boundary edges');
  }
  assert.equal(componentCount(molten), 1, 'molten field stays one body');
}

// taperPower shapes the tips: needle tips shed section length sooner, so the
// swept band encloses less volume than blunt tips at the same settings
{
  const blunt = buildSurfaceVineGeometry(arcStroke(-1, 1, 0.2),
    { ...OPTS, thornSpacing: 0, wobble: 0, taper: 6, taperPower: 0.35 });
  const needle = buildSurfaceVineGeometry(arcStroke(-1, 1, 0.2),
    { ...OPTS, thornSpacing: 0, wobble: 0, taper: 6, taperPower: 2.2 });
  assert.ok(Math.abs(signedVolume(blunt)) > Math.abs(signedVolume(needle)) * 1.15,
    'taperPower changes tip mass');
}

// A surface sample's radiusScale follows the arc-length resample and scales
// both lateral width and peak height in the swept and field builders.
{
  const samples = Array.from({ length: 81 }, (_, i) => ({
    p: [-2 + (4 * i) / 80, 0, 0],
    n: [0, 0, 1],
    radiusScale: 0.35 + (1.85 * i) / 80,
  }));
  const opts = {
    radius: 0.08,
    peak: 0.1,
    relief: 'round',
    wobble: 0,
    taper: 0,
    thornSpacing: 0,
    detail: 3,
  };
  const variableSweep = buildSurfaceVineGeometry(samples, opts);
  const variableField = buildSurfaceVineFieldGeometry([{ samples, seed: 1 }], opts);
  const sectionExtents = (geometry, minX, maxX) => {
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
  for (const [label, geometry] of [['sweep', variableSweep], ['field', variableField]]) {
    const narrow = sectionExtents(geometry, -1.7, -1.3);
    const wide = sectionExtents(geometry, 1.3, 1.7);
    assert.ok(wide.width > narrow.width * 2.4,
      `${label} interpolates radius into width (${narrow.width} -> ${wide.width})`);
    assert.ok(wide.height > narrow.height * 2.4,
      `${label} interpolates radius into peak (${narrow.height} -> ${wide.height})`);
  }

  // Packed `[x,y,z,radius]` positions let the 3D B-spline output feed this
  // builder directly through a conformed sample wrapper.
  const packed = samples.map(({ p, n, radiusScale }) => ({ p: [...p, radiusScale], n }));
  const packedSweep = buildSurfaceVineGeometry(packed, opts);
  assert.deepEqual(Array.from(packedSweep.getAttribute('position').array),
    Array.from(variableSweep.getAttribute('position').array),
    'packed and explicit radius channels produce identical swept geometry');

  const unweighted = samples.map(({ p, n }) => ({ p, n }));
  const unitWeighted = unweighted.map(({ p, n }) => ({ p, n, radiusScale: 1 }));
  const legacySweep = buildSurfaceVineGeometry(unweighted, opts);
  const unitSweep = buildSurfaceVineGeometry(unitWeighted, opts);
  assert.deepEqual(Array.from(unitSweep.getAttribute('position').array),
    Array.from(legacySweep.getAttribute('position').array),
    'unit radius preserves legacy swept positions exactly');
  assert.deepEqual(Array.from(unitSweep.getIndex().array), Array.from(legacySweep.getIndex().array),
    'unit radius preserves legacy swept topology exactly');

  const legacyField = buildSurfaceVineFieldGeometry([{ samples: unweighted }], opts);
  const unitField = buildSurfaceVineFieldGeometry([{ samples: unitWeighted }], opts);
  assert.deepEqual(Array.from(unitField.getAttribute('position').array),
    Array.from(legacyField.getAttribute('position').array),
    'unit radius preserves legacy field positions exactly');
  assert.deepEqual(Array.from(unitField.getIndex().array), Array.from(legacyField.getIndex().array),
    'unit radius preserves legacy field topology exactly');
}

// The welded default field must retain the full UI radius range. Extraction
// dilation may provide a bounded anti-speck footprint, but authored low scales
// remain visibly ordered instead of collapsing to one minSection floor.
{
  const scales = [0.05, 0.1, 0.2, 0.35];
  const samples = [];
  for (let plateau = 0; plateau < scales.length; plateau++) {
    for (let i = plateau === 0 ? 0 : 1; i <= 20; i++) {
      samples.push({
        p: [plateau * 2 + (i * 2) / 20, 0, 0],
        n: [0, 0, 1],
        radiusScale: scales[plateau],
      });
    }
  }
  const lowScaleField = buildSurfaceVineFieldGeometry([{ samples }], {
    // Match the panel's widest brush and default 0.9 peak ratio.
    radius: 0.06,
    peak: 0.054,
    relief: 'round',
    wobble: 0,
    taper: 0,
    thornSpacing: 0,
  });
  const p = lowScaleField.getAttribute('position');
  const extents = scales.map((_, plateau) => {
    let width = 0, height = -Infinity;
    const minX = plateau * 2 + 0.6;
    const maxX = plateau * 2 + 1.4;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      if (x < minX || x >= maxX) continue;
      width = Math.max(width, Math.abs(p.getY(i)));
      height = Math.max(height, p.getZ(i));
    }
    return { width, height };
  });
  assert.ok(extents[0].width > 0 && extents[0].height > 0,
    'minimum UI radius 0.05 remains visible in the default field');
  for (let i = 1; i < extents.length; i++) {
    assert.ok(extents[i].width > extents[i - 1].width * 1.15,
      `default field distinguishes radius ${scales[i - 1]} -> ${scales[i]} in width`);
    assert.ok(extents[i].height > extents[i - 1].height * 1.15,
      `default field distinguishes radius ${scales[i - 1]} -> ${scales[i]} in peak`);
  }
  assert.equal(componentCount(lowScaleField), 1,
    'adaptive low-radius extraction keeps the field connected');
  for (const [, count] of edgeUse(lowScaleField)) {
    assert.equal(count % 2, 0, 'adaptive low-radius extraction keeps a closed shell');
  }
  assert.ok(p.count < 100_000,
    `default soft budget bounds low-radius extraction (${p.count} verts)`);
}

// Closed vines are periodic: no tapered seam/cap, and an explicit closed flag
// matches the traditional duplicate-endpoint representation exactly.
{
  const loop = Array.from({ length: 48 }, (_, i) => {
    const a = (i / 48) * Math.PI * 2;
    return {
      p: [Math.cos(a), Math.sin(a), 0],
      n: [0, 0, 1],
      radiusScale: 0.8 + 0.2 * Math.cos(a),
    };
  });
  const opts = {
    radius: 0.08,
    peak: 0.1,
    relief: 'round',
    wobble: 0,
    taper: 8,
    thornSpacing: 0,
    detail: 3,
  };
  const explicit = buildSurfaceVineGeometry(loop, { ...opts, closed: true });
  const duplicateLoop = [...loop, {
    p: [...loop[0].p],
    n: [...loop[0].n],
    radiusScale: loop[0].radiusScale,
  }];
  const automatic = buildSurfaceVineGeometry(duplicateLoop, opts);
  assert.equal(explicit.getIndex().count, explicit.getAttribute('position').count * 6,
    'closed sweep stitches every ring and emits no end-cap vertices');
  assert.deepEqual(Array.from(automatic.getAttribute('position').array),
    Array.from(explicit.getAttribute('position').array),
    'duplicate endpoint auto-detection matches explicit closed sweep positions');
  assert.deepEqual(Array.from(automatic.getIndex().array), Array.from(explicit.getIndex().array),
    'duplicate endpoint auto-detection matches explicit closed sweep topology');

  const explicitField = buildSurfaceVineFieldGeometry([{ samples: loop }], { ...opts, closed: true });
  const automaticField = buildSurfaceVineFieldGeometry([{ samples: duplicateLoop }], opts);
  assert.deepEqual(Array.from(automaticField.getAttribute('position').array),
    Array.from(explicitField.getAttribute('position').array),
    'closed field auto-detection matches explicit periodic positions');
  assert.deepEqual(Array.from(automaticField.getIndex().array), Array.from(explicitField.getIndex().array),
    'closed field auto-detection matches explicit periodic topology');

  const perStrokeField = buildSurfaceVineFieldGeometry([{ samples: loop, closed: true }], opts);
  assert.deepEqual(Array.from(perStrokeField.getAttribute('position').array),
    Array.from(explicitField.getAttribute('position').array),
    'field builder honors per-stroke closed positions');
  assert.deepEqual(Array.from(perStrokeField.getIndex().array), Array.from(explicitField.getIndex().array),
    'field builder honors per-stroke closed topology');

  const globallyOpen = buildSurfaceVineFieldGeometry([{ samples: loop }], { ...opts, closed: false });
  const strokeOpenOverride = buildSurfaceVineFieldGeometry(
    [{ samples: loop, closed: false }],
    { ...opts, closed: true },
  );
  assert.deepEqual(Array.from(strokeOpenOverride.getAttribute('position').array),
    Array.from(globallyOpen.getAttribute('position').array),
    'per-stroke false overrides a global closed default');

  const wobbleLoop = loop.map(({ p, n }) => ({ p, n, radiusScale: 1 }));
  const wobbled = buildSurfaceVineGeometry(wobbleLoop, {
    ...opts,
    closed: true,
    wobble: 1,
    seed: 1,
  });
  const wobblePos = wobbled.getAttribute('position');
  const ringSize = 12; // round outline, melt 0
  const ringCount = wobblePos.count / ringSize;
  const sectionRadius = (ring) => {
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < ringSize; j++) {
      const i = ring * ringSize + j;
      cx += wobblePos.getX(i); cy += wobblePos.getY(i); cz += wobblePos.getZ(i);
    }
    cx /= ringSize; cy /= ringSize; cz /= ringSize;
    let radius = 0;
    for (let j = 0; j < ringSize; j++) {
      const i = ring * ringSize + j;
      radius = Math.max(radius, Math.hypot(
        wobblePos.getX(i) - cx,
        wobblePos.getY(i) - cy,
        wobblePos.getZ(i) - cz,
      ));
    }
    return radius;
  };
  const firstSize = sectionRadius(0);
  const secondSize = sectionRadius(1);
  const lastSize = sectionRadius(ringCount - 1);
  const beforeLastSize = sectionRadius(ringCount - 2);
  const seamDelta = Math.abs(firstSize - lastSize);
  const neighborDelta = Math.max(
    Math.abs(secondSize - firstSize),
    Math.abs(lastSize - beforeLastSize),
  );
  assert.ok(seamDelta <= neighborDelta * 1.25,
    `closed wobble is periodic at the seam (${seamDelta} vs neighbor ${neighborDelta})`);
}

// The periodic branch must not perturb the original open-path modulation.
{
  const openWobble = buildSurfaceVineGeometry(arcStroke(-1, 1, 0.2), {
    ...OPTS,
    wobble: 0.7,
    thornSpacing: 0,
    seed: 11,
  });
  assert.deepEqual(Array.from(openWobble.getAttribute('position').array.slice(360, 390)), [
    0.822658121585846, 0.21033143997192383, -0.6321171522140503,
    0.8161526322364807, 0.22863107919692993, -0.6271201372146606,
    0.8045451045036316, 0.24027743935585022, -0.6182041168212891,
    0.7909457087516785, 0.24214985966682434, -0.6077580451965332,
    0.7789983749389648, 0.23374664783477783, -0.5985810160636902,
    0.771904468536377, 0.21731942892074585, -0.5931320190429688,
    0.7715647220611572, 0.19726987183094025, -0.5928710699081421,
    0.7780702114105225, 0.17897023260593414, -0.5978680849075317,
    0.7896777987480164, 0.16732388734817505, -0.6067841649055481,
    0.8032771944999695, 0.16545146703720093, -0.6172301769256592,
  ], 'open wobble positions remain exactly compatible');
}

// Floating-point endpoint rounding must not poison a fractional taper power.
{
  const total = 0.000370370367;
  const radius = 0.00003086419725 / 0.6;
  const samples = [
    { p: [0, 0, 0], n: [0, 0, 1] },
    { p: [total, 0, 0], n: [0, 0, 1] },
  ];
  const opts = { radius, peak: radius, taperPower: 1.04, wobble: 0, detail: 3.2 };
  const taperedSweep = buildSurfaceVineGeometry(samples, opts);
  const taperedField = buildSurfaceVineFieldGeometry([{ samples }], opts);
  assert.ok(Array.from(taperedSweep.getAttribute('position').array).every(Number.isFinite),
    'fractional open taper keeps its final sweep ring finite');
  assert.ok(taperedField.getAttribute('position').count > 0,
    'fractional open taper still seeds a committed field');
  taperedSweep.dispose();
  taperedField.dispose();
}

// ---- closest-point mesh index ----

{
  const sphere = new SphereGeometry(1, 64, 48);
  const index = createMeshIndex(sphere);
  assert.ok(index.triangleCount > 1000, 'index ingests the mesh');

  const q = [0.3, 1.4, -0.2];
  const qLen = Math.hypot(...q);
  const hit = index.closestPoint(q[0], q[1], q[2], 1);
  assert.ok(hit, 'query near the surface hits');
  assert.ok(Math.abs(hit.distance - (qLen - 1)) < 0.01,
    `distance ≈ radial gap (${hit.distance} vs ${qLen - 1})`);
  assert.ok(Math.abs(Math.hypot(...hit.point) - 1) < 0.01, 'closest point sits on the sphere');
  const dot = (hit.normal[0] * q[0] + hit.normal[1] * q[1] + hit.normal[2] * q[2]) / qLen;
  assert.ok(dot > 0.95, `normal points outward (dot ${dot})`);

  // inside query lands on the surface too
  const inner = index.closestPoint(0.4, 0, 0, 1);
  assert.ok(inner && Math.abs(Math.hypot(...inner.point) - 1) < 0.01, 'inside query welds outward');

  // beyond the cap → null
  assert.equal(index.closestPoint(5, 5, 5, 0.5), null, 'far query respects maxDist');

  const shell = createMeshIndex(new BoxGeometry(2, 2, 0.2));
  const back = shell.closestPoint(0, 0, 0.04, 0.25, {
    normal: [0, 0, -1],
    minNormalDot: 0.5,
  });
  assert.ok(back && back.point[2] < 0,
    'normal-constrained projection stays on the requested shell instead of the nearer opposite face');
}

console.log(`surface vine OK · sweep ${sweep.getAttribute('position').count} verts · field ${single.getAttribute('position').count} verts`);
