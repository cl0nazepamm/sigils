import assert from 'node:assert/strict';
import { buildSigilGeometryAsync, buildSparseCurveGeometryAsync } from '../src/index.js';

const paths = [[0, 0], [0.6, 0.25], [1, -0.1]];
const renderer = {
  computeAsync: async () => { throw new Error('synthetic compute failure'); },
  getArrayBufferAsync: async () => new ArrayBuffer(0),
};

let fallbacks = 0;
const merged = await buildSigilGeometryAsync(paths, {
  renderer,
  fieldBackend: 'hybrid',
  resolution: 48,
  thickness: 0.18,
  laplacian: 3,
  onGpuFallback: () => { fallbacks++; },
});

assert.ok(merged.getAttribute('position').count > 0, 'CPU fallback emits merged geometry');
assert.equal(merged.userData.fieldBackend, 'cpu', 'failed GPU field records CPU backend');
assert.equal(merged.userData.laplacianBackend, 'cpu', 'field failure does not retry GPU laplacian');
assert.equal(fallbacks, 1, 'one field failure triggers one fallback callback');
merged.dispose();

fallbacks = 0;
const sparseAsync = await buildSparseCurveGeometryAsync(renderer, paths, {
  fieldResolution: 48,
  thickness: 0.18,
  fieldLaplacian: 3,
  onGpuFallback: () => { fallbacks++; },
});
assert.ok(sparseAsync.getAttribute('position').count > 0, 'async sparse API falls back to a CPU merged mesh');
assert.equal(sparseAsync.userData.fieldBackend, 'cpu', 'async sparse fallback records CPU backend');
assert.equal(fallbacks, 1, 'async sparse API reports one GPU failure');
sparseAsync.dispose();

console.log('gpu fallback OK');
