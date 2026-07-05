import assert from 'node:assert/strict';
import {
  activeBuildPaths,
  buildOptionsForSession,
  committedBuildPaths,
  expandActivePaths,
  isDrawSettingKey,
  isSplineRecord,
  makeSplineRecord,
  makeStrokeRecord,
  sampleSplinePoints,
  strokePoints,
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

assert.equal(isDrawSettingKey('symmetry'), true);
assert.equal(isDrawSettingKey('mirror'), true);
assert.equal(isDrawSettingKey('smooth'), false);

// --- spline records (CV curves) ---
const splineState = { symmetry: 4, mirror: false, phase: 0, center: [0, 0], thickness: 0.14 };
const cvs = [[0.5, 0], [1, 0.5], [1.5, 0], [2, -0.5]];
const spline = makeSplineRecord(cvs, false, splineState);

assert.equal(isSplineRecord(spline), true, 'spline record is tagged');
assert.equal(isSplineRecord(committed), false, 'freehand record is not a spline');
assert.ok(spline.points.length > 8, 'spline record samples its polyline');
assert.deepEqual(spline.points[0], [0.5, 0], 'open spline pinned to first CV');
assert.deepEqual(spline.points.at(-1), [2, -0.5], 'open spline pinned to last CV');
assert.equal(committedBuildPaths([spline]).length, 4, 'spline expands with captured symmetry');

// CVs are cloned at commit; later edits go through updateSplineRecord.
cvs[0][0] = 42;
assert.equal(spline.cvs[0][0], 0.5, 'CVs copied at commit');

const before = spline.points.map((p) => [...p]);
updateSplineRecord(spline, [[0.5, 0], [1, 1.4], [1.5, 0], [2, -0.5]]);
assert.notDeepEqual(spline.points, before, 'CV edit re-samples the curve');
assert.equal(committedBuildPaths([spline]).length, 4, 'expansion refreshed after edit');
assert.deepEqual(spline.points[0], [0.5, 0], 'edited spline still clamped');

// Closed splines emit an explicitly closed polyline for the field builders.
const loop = makeSplineRecord([[1, 1], [-1, 1], [-1, -1], [1, -1]], true, splineState);
assert.deepEqual(loop.points[0], loop.points.at(-1), 'closed spline polyline is welded');
assert.deepEqual(sampleSplinePoints(loop.cvs, true)[0], loop.points[0], 'sampler matches record');

// Draft expansion uses the CURRENT draw settings.
splineState.symmetry = 2;
const draftPaths = expandActivePaths(sampleSplinePoints([[0, 0], [1, 0], [1, 1]], false), splineState);
assert.equal(draftPaths.length, 2, 'draft preview expands with live symmetry');

console.log('stroke session OK');
