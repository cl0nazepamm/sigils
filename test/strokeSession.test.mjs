import assert from 'node:assert/strict';
import {
  activeBuildPaths,
  buildOptionsForSession,
  committedBuildPaths,
  isDrawSettingKey,
  makeStrokeRecord,
  strokePoints,
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

console.log('stroke session OK');
