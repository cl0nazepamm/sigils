import assert from 'node:assert/strict';
import {
  buildSparseCurveGeometry,
  DistanceField,
  prepareStrokes,
} from '../src/index.js';
import {
  sparsePreviewOptionsFromState,
  createSigilState,
} from '../examples/shared/sigilDefaults.js';

const stroke = [[0, 0], [1, 0], [2, 0]];
const taper = 1;
const taperPower = 1.03;
const thickness = 0.2;

const opts = sparsePreviewOptionsFromState(createSigilState({
  thickness,
  taper,
  taperPower,
  symmetry: 1,
  mirror: false,
  relief: 'carve',
  edgeFalloffNorm: 0.5,
}));

assert.equal(opts.taper, 1, 'preview options pass field taper');
assert.equal(opts.taperPower, taperPower, 'preview options pass field taperPower');
assert.equal(opts.tipRadius, 0, 'field tips are allowed to pinch to zero');
assert.equal('taperLen' in opts, false, 'preview no longer uses tip-length taper');

const sparse = buildSparseCurveGeometry(stroke, {
  ...opts,
  symmetry: 1,
  mirror: false,
  resample: 0.25,
  simplify: 0,
  profile: [-1, 0, 1],
  baseDepth: 0,
  heightSmooth: 0,
});

const tip = sparseRowNearestX(sparse, 0);
const mid = sparseRowNearestX(sparse, 1);
assert.ok(tip.halfWidth < mid.halfWidth * 0.15,
  `field-style taper pinches tips (${tip.halfWidth} vs mid ${mid.halfWidth})`);
assert.ok(Math.abs(mid.halfWidth - thickness * 0.5) < 1e-6,
  `midspan keeps full half-width (${mid.halfWidth})`);

const roundCaps = buildSparseCurveGeometry(stroke, {
  ...opts,
  taper: 0,
  resample: 0.25,
  simplify: 0,
  profile: [-1, 0, 1],
  baseDepth: 0,
  heightSmooth: 0,
});
const roundTip = sparseRowNearestX(roundCaps, 0);
assert.ok(Math.abs(roundTip.halfWidth - thickness * 0.5) < 1e-6,
  `taper=0 keeps round caps (${roundTip.halfWidth})`);

// Same weight formula as DistanceField at mid and near tip.
const field = new DistanceField(prepareStrokes(stroke, {
  thickness,
  taper,
  taperPower,
  resolution: 64,
  resample: 0.25,
  smooth: 0,
}).set, { resolution: 64, margin: thickness, taper, taperPower });

const midWeight = field._taperWeight(0.5, false);
const tipWeight = field._taperWeight(0, false);
assert.ok(Math.abs(midWeight - 1) < 1e-9, `field mid weight is 1 (${midWeight})`);
assert.equal(tipWeight, 0, `field tip weight is 0 (${tipWeight})`);
assert.ok(tip.halfWidth <= 1e-9, 'strip tip half-width matches field zero weight');

function sparseRowNearestX(geometry, x) {
  const pos = geometry.getAttribute('position');
  let best = null;
  for (let i = 0; i < pos.count; i += 3) {
    const ax = pos.getX(i);
    const cx = pos.getX(i + 1);
    const bx = pos.getX(i + 2);
    const mx = (ax + bx) * 0.5;
    const halfWidth = Math.hypot(bx - ax, pos.getY(i + 2) - pos.getY(i)) * 0.5;
    const err = Math.abs(mx - x);
    if (!best || err < best.err) best = { err, halfWidth, x: mx, centerY: pos.getY(i + 1), cx };
  }
  return best;
}
