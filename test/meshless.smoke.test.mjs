/**
 * Headless TSL graph-build smoke test for the meshless raymarch path.
 *
 * GPU EXECUTION cannot run here, so this only constructs the node graph against
 * a mocked field descriptor (real StorageBufferAttributes, no renderer) and
 * asserts that the storage().toReadOnly() + bilinear closures + Loop/If/Break +
 * .discard() + transformNormalToView normalNode all build synchronously without
 * throwing. Visuals are verified in-browser by the user.
 *
 * Run: node test/meshless.smoke.test.mjs
 */

import assert from 'node:assert';
import { StorageBufferAttribute } from 'three/webgpu';
import {
  createRaymarchSigilMaterial,
  updateRaymarchSigilMaterial,
  updateRaymarchFieldUniforms,
  buildProxyBoxGeometry,
  PEAK_MAX,
  RAYMARCH_STEPS,
} from '../src/tsl/raymarchSigilMaterial.js';
import { buildResidentField } from '../src/meshlessField.js';
import { prepareStrokes } from '../src/strokePipeline.js';

function fakeField() {
  const width = 8;
  const height = 6;
  const total = width * height;
  return {
    grid: { minX: -1, minY: -1, cell: 0.05, width, height, segmentCount: 4 },
    capacity: total,
    threshold: 0.07,
    boundaryFalloff: 0.07,
    smooth: 3,
    mergeBlend: 0.375,
    depthBlend: 0.5,
    rawAttr: new StorageBufferAttribute(new Float32Array(total * 2), 2),
    smoothAttr: new StorageBufferAttribute(new Float32Array(total * 2), 2),
    reused: false,
  };
}

assert.ok(PEAK_MAX >= 0.45, 'PEAK_MAX must clear the peak control max');
assert.ok(RAYMARCH_STEPS > 0, 'RAYMARCH_STEPS exported');

// Both height profiles build (linear default + round closed form).
for (const profile of ['linear', 'round']) {
  const field = fakeField();
  const material = createRaymarchSigilMaterial(field, {
    profile,
    peakHeight: 0.14,
    roughness: 0.05,
    envMapIntensity: 1.6,
  });
  assert.ok(material.normalNode, `normalNode set (${profile})`);
  assert.ok(material.roughnessNode, `roughnessNode set (${profile})`);
  assert.ok(material.sigilUniforms?.peakHeight, `sigilUniforms (${profile})`);
  assert.ok(material.gridUniforms?.uW, `gridUniforms (${profile})`);

  const geo = buildProxyBoxGeometry(field);
  assert.ok((geo.getAttribute('position')?.count ?? 0) > 0, `proxy box geometry (${profile})`);

  updateRaymarchSigilMaterial(material, { peakHeight: 0.2, roughness: 0.1 });
  assert.strictEqual(material.sigilUniforms.peakHeight.value, 0.2, 'live peak update');
  updateRaymarchFieldUniforms(material, field);

  geo.dispose();
  material.dispose();
}

// smooth=0 path: smoothAttr === rawAttr (single read-only binding reused).
{
  const field = fakeField();
  field.smoothAttr = field.rawAttr;
  field.smooth = 0;
  field.mergeBlend = 0;
  field.depthBlend = 0;
  const material = createRaymarchSigilMaterial(field, { profile: 'linear' });
  assert.ok(material.normalNode, 'normalNode set (smooth=0)');
  material.dispose();
}

// Grid margin controls should affect field/proxy size unless an explicit margin is provided.
{
  const stroke = [[0, 0], [1, 0]];
  const scaled = prepareStrokes(stroke, { thickness: 0.2, resolution: 16, gridBufferFactor: 3 });
  assert.ok(Math.abs(scaled.fieldOpts.margin - scaled.threshold * 3) < 1e-9, 'gridBufferFactor margin');

  const explicit = prepareStrokes(stroke, {
    thickness: 0.2,
    resolution: 16,
    gridBuffer: 0.42,
    gridBufferFactor: 3,
  });
  assert.strictEqual(explicit.fieldOpts.margin, 0.42, 'gridBuffer overrides factor');
}

// Segment uploads can grow every drag tick; they must not force the material-bound
// raw/smoothed field storage to be recreated.
{
  const renderer = { computeAsync: async () => {} };
  const opts = {
    thickness: 0.2,
    resolution: 16,
    fieldResolution: 16,
    smooth: 0,
    symmetry: 1,
    mirror: false,
    resample: 0.1,
  };
  const small = await buildResidentField(renderer, [[0, 0], [1, 0]], opts);
  assert.ok(small && !small.reused, 'first field allocates');

  const raw = small.rawAttr;
  const smooth = small.smoothAttr;
  const seg = small._buf.segAttr;
  const longStroke = Array.from({ length: 160 }, (_, i) => [i / 159, Math.sin(i) * 0.02]);
  const grownSegments = await buildResidentField(renderer, longStroke, opts, small);
  assert.ok(grownSegments.reused, 'field storage reused when only segment upload grows');
  assert.strictEqual(grownSegments.rawAttr, raw, 'raw storage stays bound');
  assert.strictEqual(grownSegments.smoothAttr, smooth, 'smooth storage stays bound');
  assert.notStrictEqual(grownSegments._buf.segAttr, seg, 'segment upload buffer can grow independently');

  grownSegments.dispose(true);
}

console.log(`meshless smoke OK · PEAK_MAX ${PEAK_MAX} · ${RAYMARCH_STEPS} steps`);
