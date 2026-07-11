import assert from 'node:assert/strict';
import {
  buildSigilGeometry,
  buildSparseCurveGeometry,
  DistanceField,
  prepareStrokes,
} from '../src/index.js';

const weightedHorizontal = [[0, 0, 0.5], [2, 0, 2]];
const sparse = buildSparseCurveGeometry(weightedHorizontal, {
  pointRadius: true,
  symmetry: 1,
  mirror: false,
  thickness: 0.2,
  resample: 0.1,
  simplify: 0,
  taperLen: 0,
  tipRadius: 0,
  profile: [-1, 0, 1],
  baseDepth: 0,
});

const narrowRow = sparseRowNearestX(sparse, 0.5);
const wideRow = sparseRowNearestX(sparse, 1.5);
assert.ok(narrowRow.halfWidth > 0, 'weighted sparse preview emits a nonzero narrow row');
assert.ok(wideRow.halfWidth > narrowRow.halfWidth * 1.6,
  `pointRadius changes local strip width (${narrowRow.halfWidth} -> ${wideRow.halfWidth})`);

// The CPU field uses the interpolated point radius as its local iso radius.
const weightedVertical = [[0, -1, 0.5], [0, 1, 2]];
const fieldOpts = {
  pointRadius: true,
  thickness: 0.2,
  resolution: 256,
  resample: 0.02,
  smooth: 0,
  taper: 0,
  gridBufferFactor: 1.5,
};
const prepared = prepareStrokes(weightedVertical, fieldOpts);
assert.ok(close(prepared.fieldOpts.margin, 0.3),
  'implicit grid margin includes the maximum point radius scale');
assert.equal(prepared.fieldOpts.pointRadius, true, 'CPU field receives the point-radius opt-in');

const legacyPrepared = prepareStrokes(weightedVertical.map(([x, y]) => [x, y]), {
  ...fieldOpts,
  pointRadius: false,
});
assert.ok(close(legacyPrepared.fieldOpts.margin, 0.15), 'legacy uniform grid margin stays unchanged');

const field = new DistanceField(prepared.set, prepared.fieldOpts);
const narrowScale = field.sampleWeight(0, -0.7);
const wideScale = field.sampleWeight(0, 0.7);
assert.ok(close(narrowScale, 0.725, 0.03), `narrow-side field scale interpolates (${narrowScale})`);
assert.ok(close(wideScale, 1.775, 0.03), `wide-side field scale interpolates (${wideScale})`);
assert.ok(implicitAtWorld(field, 0.12, -0.7, prepared.threshold) > 0,
  'probe outside the narrow radius remains outside the CPU field');
assert.ok(implicitAtWorld(field, 0.12, 0.7, prepared.threshold) < 0,
  'same probe falls inside the wide radius of the CPU field');

// Radius-normalized distance can make a slightly farther thick stroke the
// correct field contributor instead of the geometrically nearest centerline.
const weightedWinner = new DistanceField([
  [[0, -1, 0.25], [0, 1, 0.25]],
  [[0.15, -1, 2], [0.15, 1, 2]],
], {
  pointRadius: true,
  resolution: 192,
  margin: 0.25,
  smooth: 0,
  taper: 0,
});
assert.ok(close(weightedWinner.sampleWeight(0, 0), 0.25, 0.01),
  'query on the thin centerline still selects the thin segment');
assert.ok(close(weightedWinner.sampleWeight(0.04, 0), 2, 0.01),
  'farther thick segment wins when its radius-normalized distance is smaller');

// Exercise the complete synchronous CPU mesh path as well as the field class.
const meshOptions = {
  ...fieldOpts,
  resolution: 160,
  laplacian: 0,
  heightSmooth: 0,
  base: 0,
};
const weightedMesh = buildSigilGeometry(weightedVertical, meshOptions);
const uniformMesh = buildSigilGeometry([[0, -1, 1], [0, 1, 1]], meshOptions);
const weightedWidth = weightedMesh.boundingBox.max.x - weightedMesh.boundingBox.min.x;
const uniformWidth = uniformMesh.boundingBox.max.x - uniformMesh.boundingBox.min.x;
assert.ok(weightedWidth > uniformWidth * 1.5,
  `CPU mesh bounds retain nonuniform point radius (${uniformWidth} -> ${weightedWidth})`);
weightedMesh.dispose();
uniformMesh.dispose();
sparse.dispose();

console.log('point radius OK');

function sparseRowNearestX(geometry, targetX) {
  const position = geometry.getAttribute('position');
  const { topStride, rowStride } = geometry.userData.sparseCurveLayout;
  const centerColumn = 1;
  const rowCount = position.count / rowStride;
  let bestRow = 0;
  let bestDistance = Infinity;
  for (let row = 0; row < rowCount; row++) {
    const center = row * rowStride + centerColumn;
    const distance = Math.abs(position.getX(center) - targetX);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestRow = row;
    }
  }
  const first = bestRow * rowStride;
  const last = first + topStride - 1;
  return {
    halfWidth: Math.hypot(
      position.getX(last) - position.getX(first),
      position.getY(last) - position.getY(first),
    ) * 0.5,
  };
}

function implicitAtWorld(field, x, y, threshold) {
  return field.implicitAt(Math.round(field.gx(x)), Math.round(field.gy(y)), threshold);
}

function close(actual, expected, epsilon = 1e-9) {
  return Math.abs(actual - expected) <= epsilon;
}
