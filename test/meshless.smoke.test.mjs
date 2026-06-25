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

console.log(`meshless smoke OK · PEAK_MAX ${PEAK_MAX} · ${RAYMARCH_STEPS} steps`);
