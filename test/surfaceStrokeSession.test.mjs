import assert from 'node:assert/strict';
import {
  cleanSurfaceSample,
  cleanSurfaceStrokeRecord,
  cleanSurfaceStrokeRecords,
  cloneSurfaceStrokeEdit,
  closestPointOnSurfacePolyline,
  cvInsertIndexNearSurfacePoint,
  inverseSurfaceCopySample,
  isSurfaceSplineRecord,
  makeSurfaceFreehandRecord,
  makeSurfaceSplineRecord,
  pickSurfaceCvControl,
  pickSurfaceStroke,
  restoreSurfaceStrokeEdit,
  sampleSurfaceSpline,
  surfaceStrokeCopyCount,
  transformSurfaceCopySample,
  updateSurfaceSplineRecord,
} from '../examples/shared/surfaceStrokeSession.js';

const near = (a, b, epsilon = 1e-9) => Math.abs(a - b) <= epsilon;
const nearTuple = (a, b, epsilon = 1e-9) =>
  a.length === b.length && a.every((value, index) => near(value, b[index], epsilon));
const sample = (p, n = [0, 0, 1], radiusScale) => ({
  p,
  n,
  ...(radiusScale == null ? {} : { radiusScale }),
});

// --- canonical authority and strict persisted-data sanitation ---

assert.deepEqual(cleanSurfaceSample(sample([1, 2, 3], [0, 0, 4])), {
  p: [1, 2, 3], n: [0, 0, 1],
}, 'samples clone position and normalize their normal');
assert.equal(cleanSurfaceSample(sample([1, 2], [0, 0, 1])), null, 'malformed positions are rejected');
assert.equal(cleanSurfaceSample(sample([1, 2, 3], [0, 0, 1], 0)), null,
  'non-positive sample radii are rejected');

const legacyRaw = [sample([0, 0, 0]), sample([1, 0, 0])];
const legacy = cleanSurfaceStrokeRecord({
  raw: legacyRaw,
  seed: 42,
  conformed: [{ private: true }],
});
assert.equal(legacy.kind, 'freehand', 'legacy records migrate to explicit freehand authority');
assert.deepEqual(legacy.raw.map(({ radiusScale }) => radiusScale), [1, 1],
  'legacy freehand samples gain a uniform radius channel');
assert.ok(!('conformed' in legacy), 'derived caches never survive sanitation');

const splineCvs = [
  sample([1, 0, 0], [1, 0, 0]),
  sample([0, 1, 0], [0, 1, 0]),
  sample([-1, 0, 0], [-1, 0, 0]),
  sample([0, -1, 0], [0, -1, 0]),
];
const spline = cleanSurfaceStrokeRecord({
  id: 7,
  kind: 'spline',
  cvs: splineCvs,
  cvRadiusScales: [0.5, 1, 2, 1.5],
  closed: true,
  seed: 99,
  raw: [{ private: true }],
  conformed: [{ private: true }],
});
assert.deepEqual(spline, {
  id: 7,
  kind: 'spline',
  cvs: splineCvs,
  cvRadiusScales: [0.5, 1, 2, 1.5],
  closed: true,
  seed: 99,
}, 'spline sanitation keeps only CV authority and identity');
assert.equal(cleanSurfaceStrokeRecord({ ...spline, cvRadiusScales: [1, 1] }), null,
  'radius length mismatches reject the whole spline');
assert.equal(cleanSurfaceStrokeRecord({ ...spline, cvRadiusScales: [1, 1, NaN, 1] }), null,
  'non-finite spline radii are rejected');
assert.equal(cleanSurfaceStrokeRecord({ ...spline, cvRadiusScales: [1, 1, 0, 1] }), null,
  'non-positive spline radii are rejected');
assert.equal(cleanSurfaceStrokeRecord({ ...spline, cvs: splineCvs.slice(0, 1), cvRadiusScales: [1] }), null,
  'a spline needs at least two CVs');
assert.equal(cleanSurfaceStrokeRecords([legacy, { malformed: true }, spline]).length, 2,
  'record-set sanitation drops malformed entries without poisoning valid neighbors');

const freehandInput = [sample([0, 0, 0]), sample([1, 0, 0], [0, 0, 1], 1.25)];
const freehand = makeSurfaceFreehandRecord(freehandInput, { id: 3, seed: 11 });
freehandInput[0].p[0] = 100;
assert.equal(freehand.raw[0].p[0], 0, 'record creation deep-clones freehand authority');
assert.equal(freehand.conformed, null, 'new records begin without a derived path cache');

const editable = makeSurfaceSplineRecord(splineCvs, false, [0.5, 1, 2, 1.5], { id: 8, seed: 12 });
assert.ok(isSurfaceSplineRecord(editable), 'spline record detection is explicit');
editable.conformed = [{ private: true }];
updateSurfaceSplineRecord(editable, splineCvs, true, [0.6, 1, 2, 1.4]);
assert.equal(editable.closed, true, 'spline update replaces closed authority');
assert.equal(editable.conformed, null, 'spline update invalidates derived geometry');

// --- 3D B-spline and radius channel use the same basis ---

const twoCv = [sample([0, 0, 0]), sample([2, 0, 2])];
const line = sampleSurfaceSpline(twoCv, { radiusScales: [0.5, 2.5] });
assert.deepEqual(line[0], sample([0, 0, 0], [0, 0, 1], 0.5),
  'open 3D spline retains its first position and radius');
assert.deepEqual(line.at(-1), sample([2, 0, 2], [0, 0, 1], 2.5),
  'open 3D spline retains its last position and radius');
const lineMid = line[Math.floor(line.length / 2)];
assert.ok(nearTuple(lineMid.p, [1, 0, 1]), '3D coordinates interpolate through de Boor');
assert.ok(near(lineMid.radiusScale, 1.5), 'radius follows the same spline basis');

const sphereProject = (p) => {
  const length = Math.hypot(...p) || 1;
  const point = p.map((value) => value / length);
  return { point, normal: point };
};
const projected = sampleSurfaceSpline(splineCvs, {
  radiusScales: [0.5, 1, 2, 1.5],
  project: sphereProject,
});
for (const item of projected) {
  assert.ok(near(Math.hypot(...item.p), 1, 1e-8), 'projected spline lies on its target surface');
  assert.ok(nearTuple(item.p, item.n, 1e-8), 'projection supplies aligned target normals');
}
assert.equal(projected[0].radiusScale, 0.5, 'projection does not disturb the radius channel');
assert.equal(projected.at(-1).radiusScale, 1.5, 'projected end keeps its CV radius');

const closed = sampleSurfaceSpline(splineCvs, {
  closed: true,
  radiusScales: [0.5, 1, 2, 1.5],
  project: sphereProject,
});
assert.ok(nearTuple(closed[0].p, closed.at(-1).p), 'closed spline emits an explicit position seam');
assert.ok(nearTuple(closed[0].n, closed.at(-1).n), 'closed spline emits an explicit normal seam');
assert.equal(closed[0].radiusScale, closed.at(-1).radiusScale,
  'closed spline radius is periodic at the seam');

// --- target-local nearest path and direct viewport picking ---

const path = [
  sample([0, 0, 0], [0, 0, 1], 0.5),
  sample([2, 0, 0], [0, 0, 1], 2.5),
];
const closest = closestPointOnSurfacePolyline([1, 0.2, 0], path);
assert.ok(near(closest.distance, 0.2), '3D nearest path reports physical distance');
assert.ok(near(closest.t, 0.5), '3D nearest path reports the segment parameter');
assert.ok(nearTuple(closest.p, [1, 0, 0]), '3D nearest path reports its closest point');
assert.ok(near(closest.radiusScale, 1.5), 'nearest path interpolates its local radius');

const candidate = { record: editable, index: 0, cv: splineCvs[0], radiusScale: 1.5 };
assert.equal(pickSurfaceCvControl(sample([1.02, 0, 0], [1, 0, 0]), [candidate], {
  baseRadius: 1,
  handleRadius: 0.05,
  centerTolerance: 0.2,
  ringTolerance: 0.08,
}).kind, 'move', 'visible center disk wins direct CV picking');
assert.equal(pickSurfaceCvControl(sample([2.5, 0, 0], [1, 0, 0]), [candidate], {
  baseRadius: 1,
  handleRadius: 0.05,
  centerTolerance: 0.2,
  ringTolerance: 0.08,
}).kind, 'radius', 'physical radius ring is directly pickable');
assert.equal(pickSurfaceCvControl(sample([1.02, 0, 0], [-1, 0, 0]), [candidate], {
  baseRadius: 1,
  handleRadius: 0.05,
  centerTolerance: 0.2,
  ringTolerance: 0.08,
  normalDotMin: 0.1,
}), null, 'opposite target shells do not steal a CV pick');

const pickedStroke = pickSurfaceStroke(sample([1, 0.2, 0]), [
  { record: { id: 'far' }, path: path.map((item) => sample([item.p[0], 1, 0], item.n, item.radiusScale)) },
  { record: { id: 'near' }, path },
], { baseRadius: 0.1, padding: 0.15, normalDotMin: 0 });
assert.equal(pickedStroke.record.id, 'near', 'direct stroke picking chooses the closest reachable path');
assert.ok(near(pickedStroke.closest.radiusScale, 1.5), 'stroke picks retain the local radius result');

const insertCvs = [
  sample([0, 0, 0]),
  sample([8, 0, 0]),
  sample([8, 2, 0]),
  sample([0, 2, 0]),
];
assert.equal(cvInsertIndexNearSurfacePoint(insertCvs, false, [7.9, 1.5, 0]), 2,
  'surface insertion uses the nearest authoritative CV gap, independent of displayed arc length');
assert.equal(cvInsertIndexNearSurfacePoint(insertCvs, true, [0, 1.5, 0]), 4,
  'closed surface insertion can select the seam gap');

// --- symmetry / mirror display copies map back to one authoritative record ---

const mirrorSettings = { symmetry: 1, mirror: true, phase: 0, center: [1, 0, 0] };
const authoritative = sample([0.5, 2, 3], [1 / 3, 2 / 3, 2 / 3], 1.25);
const mirrored = transformSurfaceCopySample(authoritative, mirrorSettings, 1);
assert.deepEqual(mirrored.p, [1.5, 2, 3], 'mirror copy reflects around the target center');
assert.ok(mirrored.n[0] < 0 && mirrored.n[1] > 0, 'mirror copy reflects its surface normal');
assert.equal(mirrored.radiusScale, 1.25, 'mirror copy preserves radius authority');
const inverted = inverseSurfaceCopySample(mirrored, mirrorSettings, 1);
assert.ok(nearTuple(inverted.p, authoritative.p), 'mirrored edit maps back to authoritative position');
assert.ok(nearTuple(inverted.n, authoritative.n), 'mirrored edit maps back to authoritative normal');
assert.equal(surfaceStrokeCopyCount(mirrorSettings), 2, 'enabled mirror exposes two selectable copies');
assert.equal(surfaceStrokeCopyCount({ mirror: false }), 1, 'disabled mirror exposes only authority');

const radial = { symmetry: 4, mirror: false, phase: 0, center: [0, 0, 0] };
assert.equal(surfaceStrokeCopyCount(radial), 4, 'radial symmetry exposes N copies');
assert.equal(surfaceStrokeCopyCount({ symmetry: 3, mirror: true }), 6, 'dihedral symmetry exposes 2N copies');
const spun = transformSurfaceCopySample(sample([1, 0, 0], [1, 0, 0]), radial, 1);
assert.ok(near(spun.p[0], 0, 1e-9) && near(spun.p[1], 1, 1e-9), '90° copy rotates in XY');
const spunBack = inverseSurfaceCopySample(spun, radial, 1);
assert.ok(nearTuple(spunBack.p, [1, 0, 0]), 'radial edit maps back to authority');

const withDraw = makeSurfaceFreehandRecord(
  [sample([0, 0, 0]), sample([1, 0, 0])],
  { seed: 7, draw: { symmetry: 3, mirror: true, phase: 0.1, center: [0.2, 0, 0] } },
);
assert.equal(withDraw.draw.symmetry, 3, 'freehand records capture per-stroke symmetry');
assert.equal(withDraw.draw.mirror, true, 'freehand records capture per-stroke mirror');
const cleaned = cleanSurfaceStrokeRecord({
  ...withDraw,
  conformed: [{ private: true }],
});
assert.equal(cleaned.draw.symmetry, 3, 'persisted draw settings survive sanitation');
assert.ok(!('conformed' in cleaned), 'derived caches still drop during sanitation');

// --- edit snapshots are deep, restorable, and never retain stale caches ---

const before = cloneSurfaceStrokeEdit(editable);
const originalX = before.cvs[0].p[0];
editable.cvs[0].p[0] = 123;
editable.cvRadiusScales[0] = 3;
editable.conformed = [{ stale: true }];
assert.equal(before.cvs[0].p[0], originalX, 'edit snapshot does not alias live CV arrays');
restoreSurfaceStrokeEdit(editable, before);
assert.equal(editable.cvs[0].p[0], originalX, 'edit snapshot restores CV authority');
assert.equal(editable.cvRadiusScales[0], before.cvRadiusScales[0], 'edit snapshot restores radius authority');
assert.equal(editable.conformed, null, 'edit restore invalidates derived caches');
assert.throws(() => restoreSurfaceStrokeEdit(editable, { kind: 'freehand', raw: legacyRaw }),
  /snapshot kind/, 'snapshot kinds cannot cross record families');

console.log('surface stroke session OK');
