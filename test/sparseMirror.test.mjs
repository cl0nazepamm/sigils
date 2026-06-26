import assert from 'node:assert/strict';
import { buildSparseCurveGeometry } from '../src/index.js';

const geometry = buildSparseCurveGeometry([[0.2, 0.1], [0.4, 0.3], [1.3, 0.45]], {
  symmetry: 1,
  mirror: true,
  center: [0, 0],
  thickness: 0.1,
  resample: 0.12,
  simplify: 0,
  profile: [-1, 0, 1],
  baseDepth: 0,
});

const position = geometry.getAttribute('position');
const { topStride, rowStride } = geometry.userData.sparseCurveLayout;
const centerColumn = 1;
const rowCount = position.count / (topStride * 2);
const mirroredOffset = rowCount * rowStride;

assert.ok(rowCount > 2, 'test stroke generated preview rows');
for (let i = 0; i < rowCount; i++) {
  const source = i * rowStride + centerColumn;
  const mirrored = mirroredOffset + i * rowStride + centerColumn;
  assert.ok(close(position.getX(mirrored), -position.getX(source)), `mirrored row ${i} x`);
  assert.ok(close(position.getY(mirrored), position.getY(source)), `mirrored row ${i} y`);
}

console.log('sparse mirror OK');

function close(actual, expected) {
  return Math.abs(actual - expected) < 1e-6;
}
