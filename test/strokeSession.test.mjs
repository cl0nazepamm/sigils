import assert from 'node:assert/strict';
import {
  activeBuildPaths,
  buildOptionsForSession,
  committedBuildPaths,
  cvInsertIndexFromHit,
  cvInsertIndexFromPathHit,
  cvRadiusGuideRadius,
  cvRadiusScaleFromDrag,
  closestPointOnPolyline2D,
  cloneStrokeEdit,
  distanceToPolyline2D,
  expandActivePaths,
  isDrawSettingKey,
  isSplineRecord,
  makeSplineRecord,
  makeStrokeRecord,
  pickCvControl,
  pointOnPolyline2DHit,
  restoreStrokeEdit,
  sampleSplinePoints,
  strokePoints,
  strokeCopyCount,
  transformStrokeCopyPoint,
  inverseStrokeCopyPoint,
  updateSplineRecord,
} from '../examples/shared/strokeSession.js';

const state = {
  symmetry: 3,
  mirror: false,
  phase: 0,
  center: [0, 0],
  thickness: 0.14,
  resolution: 64,
};
const source = [[1, 0], [1, 1]];
const committed = makeStrokeRecord(source, state);

source[0][0] = 99;
state.symmetry = 1;
state.mirror = true;
state.center[0] = 3;

assert.equal(committedBuildPaths([committed]).length, 3, 'committed stroke keeps captured symmetry');
assert.deepEqual(strokePoints(committed), [[1, 0], [1, 1]], 'stroke points are copied at commit');

const live = activeBuildPaths([committed], [[0, 0], [0, 1]], state);
assert.equal(live.length, 5, 'active stroke uses current mirror setting without changing committed paths');

const buildOpts = buildOptionsForSession(state);
assert.equal(buildOpts.symmetry, 1, 'global symmetry disabled after expansion');
assert.equal(buildOpts.mirror, false, 'global mirror disabled after expansion');
assert.equal(buildOpts.phase, 0, 'global phase disabled after expansion');
assert.equal(buildOpts.resolution, 64, 'main build controls stay shared');
assert.equal(buildOpts.pointRadius, true, 'session builds opt into sampled point radii');

assert.equal(isDrawSettingKey('symmetry'), true);
assert.equal(isDrawSettingKey('mirror'), true);
assert.equal(isDrawSettingKey('smooth'), false);

// --- direct radius-ring interaction math ---
assert.ok(Math.abs(cvRadiusGuideRadius(0.2, 1.5) - 0.15) < 1e-12,
  'guide radius is half-width times CV scale');
assert.ok(Math.abs(cvRadiusScaleFromDrag(1, 0.11, 0.11, 0.2) - 1) < 1e-12,
  'grabbing slightly off the ring does not jump the radius');
assert.ok(Math.abs(cvRadiusScaleFromDrag(1, 0.11, 0.21, 0.2) - 2) < 1e-12,
  'radial pointer delta maps back to the normalized radius scale');
assert.equal(cvRadiusScaleFromDrag(1, 0.1, -1, 0.2), 0.05, 'direct radius drag clamps low');
assert.equal(cvRadiusScaleFromDrag(1, 0.1, 1, 0.2), 3, 'direct radius drag clamps high');

const controlCandidates = [
  { cv: [0, 0], radiusScale: 1, record: 'front', index: 0 },
  { cv: [0, 0], radiusScale: 1, record: 'back', index: 1 },
];
const controlPickOpts = {
  thickness: 0.2,
  handleRadius: 0.02,
  ringTolerance: 0.015,
  ringInnerRatio: 0.9,
  centerTolerance: 0.14,
};
assert.equal(pickCvControl([0.005, 0], controlCandidates, controlPickOpts).kind, 'move',
  'the visible center disk wins over an overlapping radius ring');
const ringPick = pickCvControl([0.1, 0], controlCandidates, controlPickOpts);
assert.equal(ringPick.kind, 'radius', 'the guide circumference wins over the fuzzy move target');
assert.equal(ringPick.record, 'front', 'equal ring hits retain the explicit topmost candidate order');
assert.equal(pickCvControl([0.092, 0], controlCandidates, controlPickOpts).kind, 'radius',
  'the full visible annulus remains directly draggable');
assert.equal(pickCvControl([0.135, 0], controlCandidates, controlPickOpts).kind, 'move',
  'the forgiving center target remains available away from the ring');
assert.equal(pickCvControl([0.2, 0], controlCandidates, controlPickOpts), null,
  'points outside both controls are not captured');
assert.ok(Math.abs(distanceToPolyline2D([0.5, 0.25], [[0, 0], [1, 0]]) - 0.25) < 1e-12,
  'viewport stroke picking measures the nearest segment, not just CVs');
assert.equal(distanceToPolyline2D([0, 0], []), Infinity, 'empty strokes cannot capture viewport clicks');
const weightedHit = closestPointOnPolyline2D([0.5, 0.2], [[0, 0, 0.5], [1, 0, 2.5]]);
assert.ok(Math.abs(weightedHit.radiusScale - 1.5) < 1e-12,
  'viewport stroke picking interpolates the local radius profile');

const copyDraw = { symmetry: 3, mirror: true, phase: 0.2, center: [0.1, -0.2] };
assert.equal(strokeCopyCount(copyDraw), 6, 'copy count matches radial symmetry plus mirrors');
const copyRecord = makeStrokeRecord([[0.7, 0.35], [0.9, -0.1]], copyDraw);
for (let copyIndex = 0; copyIndex < strokeCopyCount(copyDraw); copyIndex++) {
  const basePoint = [0.7, 0.35, 1.4];
  const displayedPoint = transformStrokeCopyPoint(basePoint, copyDraw, copyIndex);
  const roundTrip = inverseStrokeCopyPoint(displayedPoint, copyDraw, copyIndex);
  assert.ok(Math.hypot(roundTrip[0] - basePoint[0], roundTrip[1] - basePoint[1]) < 1e-12,
    `symmetry copy ${copyIndex} round-trips through viewport editing`);
  assert.equal(roundTrip[2], basePoint[2], 'copy transforms preserve the radius payload');
  const expected = copyRecord.expanded[copyIndex][0];
  assert.ok(Math.hypot(displayedPoint[0] - expected[0], displayedPoint[1] - expected[1]) < 1e-12,
    `copy ${copyIndex} control transform matches the rendered symmetry ordering`);
}

// --- spline records (CV curves) ---
const splineState = { symmetry: 4, mirror: false, phase: 0, center: [0, 0], thickness: 0.14 };
const cvs = [[0.5, 0], [1, 0.5], [1.5, 0], [2, -0.5]];
const cvRadiusScales = [0.5, 1, 2, 0.75];
const spline = makeSplineRecord(cvs, false, splineState, cvRadiusScales);

assert.equal(isSplineRecord(spline), true, 'spline record is tagged');
assert.equal(isSplineRecord(committed), false, 'freehand record is not a spline');
assert.ok(spline.points.length > 8, 'spline record samples its polyline');
assert.deepEqual(spline.points[0], [0.5, 0, 0.5], 'open spline pins position and radius to first CV');
assert.deepEqual(spline.points.at(-1), [2, -0.5, 0.75], 'open spline pins position and radius to last CV');
assert.equal(committedBuildPaths([spline]).length, 4, 'spline expands with captured symmetry');
for (const path of committedBuildPaths([spline])) {
  assert.deepEqual(path.map((point) => point[2]), spline.points.map((point) => point[2]),
    'captured symmetry preserves the sampled radius profile');
}

// CVs and radius controls are cloned at commit; later edits go through updateSplineRecord.
cvs[0][0] = 42;
cvRadiusScales[0] = 3;
assert.equal(spline.cvs[0][0], 0.5, 'CVs copied at commit');
assert.equal(spline.cvRadiusScales[0], 0.5, 'CV radius scales copied at commit');

const before = spline.points.map((p) => [...p]);
const radiiBeforeMove = [...spline.cvRadiusScales];
updateSplineRecord(spline, [[0.5, 0], [1, 1.4], [1.5, 0], [2, -0.5]]);
assert.notDeepEqual(spline.points, before, 'CV edit re-samples the curve');
assert.deepEqual(spline.cvRadiusScales, radiiBeforeMove, 'moving CVs preserves their radius controls');
assert.equal(committedBuildPaths([spline]).length, 4, 'expansion refreshed after edit');
assert.deepEqual(spline.points[0], [0.5, 0, 0.5], 'edited spline still clamps position and radius');

const centerlineBeforeRadiusEdit = spline.points.map((point) => point.slice(0, 2));
const radiusProfileBeforeEdit = spline.points.map((point) => point[2]);
updateSplineRecord(spline, spline.cvs, spline.closed, [0.25, 0.75, 2.5, 1.25]);
assert.deepEqual(spline.points.map((point) => point.slice(0, 2)), centerlineBeforeRadiusEdit,
  'radius-only edit leaves the sampled centerline unchanged');
assert.notDeepEqual(spline.points.map((point) => point[2]), radiusProfileBeforeEdit,
  'radius-only edit refreshes the sampled radius profile');

const uniform = makeSplineRecord([[0, 0], [1, 0], [2, 0]], false, splineState);
assert.deepEqual(uniform.cvRadiusScales, [1, 1, 1], 'missing CV radii default to a uniform profile');
assert.ok(uniform.points.every((point) => point[2] === 1), 'default sampled profile stays uniformly one');

// Closed splines emit an explicitly closed polyline for the field builders.
const loopRadii = [0.25, 1.25, 2.5, 0.75];
const loop = makeSplineRecord(
  [[1, 1], [-1, 1], [-1, -1], [1, -1]],
  true,
  splineState,
  loopRadii,
);
assert.deepEqual(loop.points[0], loop.points.at(-1), 'closed spline polyline is welded');
assert.equal(loop.points[0].length, 3, 'closed seam keeps the radius channel');
assert.deepEqual(sampleSplinePoints(loop.cvs, true, loopRadii)[0], loop.points[0], 'sampler matches record');

// Draft expansion uses the CURRENT draw settings.
splineState.symmetry = 2;
const draft = sampleSplinePoints([[0, 0], [1, 0], [1, 1]], false, [0.5, 2, 1]);
const draftPaths = expandActivePaths(draft, splineState);
assert.equal(draftPaths.length, 2, 'draft preview expands with live symmetry');
for (const path of draftPaths) {
  assert.deepEqual(path.map((point) => point[2]), draft.map((point) => point[2]),
    'draft symmetry preserves sampled radii');
}

// A unified drawing mode keeps both record kinds in one chronological stack.
// Flattening that stack for a build must preserve order and the spline's
// sampled point-radius channel.
const mixedState = {
  symmetry: 1,
  mirror: false,
  phase: 0,
  center: [0, 0],
  thickness: 0.14,
};
const freehandBefore = makeStrokeRecord([[-2, 0], [-1.5, 0.25]], mixedState);
const mixedSpline = makeSplineRecord(
  [[-0.75, 0], [-0.25, 0.5], [0.25, -0.25], [0.75, 0]],
  false,
  mixedState,
  [0.35, 1.25, 2.4, 0.6],
);
const freehandAfter = makeStrokeRecord([[1.5, -0.2], [2, 0.1]], mixedState);
const mixedPaths = committedBuildPaths([freehandBefore, mixedSpline, freehandAfter]);

assert.equal(mixedPaths.length, 3, 'mixed records produce one path each without reordering');
assert.deepEqual(mixedPaths[0], freehandBefore.points,
  'freehand path before the spline stays first');
assert.deepEqual(mixedPaths[1], mixedSpline.points,
  'spline path stays in its chronological position');
assert.deepEqual(mixedPaths[2], freehandAfter.points,
  'freehand path after the spline stays last');
assert.deepEqual(mixedPaths[1].map((point) => point[2]), mixedSpline.points.map((point) => point[2]),
  'mixed flattening preserves every sampled spline radius');
assert.equal(mixedPaths[1][0][2], 0.35, 'mixed spline keeps its first CV radius');
assert.equal(mixedPaths[1].at(-1)[2], 0.6, 'mixed spline keeps its last CV radius');

const insertHit = { segmentIndex: 8, t: 0.25 };
assert.equal(cvInsertIndexFromHit(5, false, insertHit, 16), 1, 'early open span inserts after the first CV');
assert.equal(cvInsertIndexFromHit(5, false, { segmentIndex: 20, t: 0.5 }, 16), 3, 'later open span can reach late CV slots');
assert.equal(cvInsertIndexFromHit(4, true, { segmentIndex: 60, t: 0 }, 16), 4, 'closed end span may append');
assert.equal(cvInsertIndexFromHit(4, false, { segmentIndex: 8, t: 0 }, 16), 2, 'single-span cubic still reaches mid inserts');
assert.deepEqual(
  pointOnPolyline2DHit([[0, 0], [2, 0]], { segmentIndex: 0, t: 0.5 }),
  [1, 0],
  'polyline hit reconstructs the closest point',
);

{
  const path = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
  assert.equal(
    cvInsertIndexFromPathHit(5, false, path, { segmentIndex: 3, t: 0.5 }),
    4,
    'arc-length insert tracks the clicked end of the path',
  );
  assert.equal(
    cvInsertIndexFromPathHit(5, false, path, { segmentIndex: 0, t: 0.25 }),
    1,
    'arc-length insert keeps the first CV pinned',
  );
}

{
  const editable = makeSplineRecord(
    [[0, 0], [1, 0], [1, 1], [0, 1]],
    false,
    mixedState,
    [0.5, 1, 1.5, 0.75],
  );
  const before = cloneStrokeEdit(editable);
  updateSplineRecord(editable, [[0, 0], [2, 0], [2, 2]], false, [1, 1, 1]);
  assert.equal(editable.cvs.length, 3, 'edit shrinks the CV list');
  restoreStrokeEdit(editable, before);
  assert.deepEqual(cloneStrokeEdit(editable), before, 'restore brings CV edit snapshots back');
}

console.log('stroke session OK');
