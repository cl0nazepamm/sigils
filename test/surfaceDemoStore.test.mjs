import assert from 'node:assert/strict';
import { restoreStore, serializeStore } from '../examples/modes/surface.js';

const raw = [
  { p: [0, 0, 0], n: [0, 1, 0] },
  { p: [1, 0, 0], n: [0, 1, 0] },
];
const cvs = [
  { p: [0, 0, 0], n: [0, 1, 0] },
  { p: [0.35, 0.1, 0.2], n: [0, 0.6, 0.8] },
  { p: [0.7, 0, 0.35], n: [0, 0.8, 0.6] },
];
const cvRadiusScales = [0.4, 1.25, 2.5];
const serialized = serializeStore({
  settings: { surfaceBackend: 'patch', patchHeight: 0.12, manualMeshing: true },
  committed: [{ raw, seed: 42, conformed: [{ private: true }] }],
  redo: [{ raw, seed: 84 }],
  targetGeometry: { shouldNotSerialize: true },
  targetScale3: [1, -1, 1],
  targetQuaternion: [0, 0, 0, 1],
  targetPosition: [1, 2, 3],
});

assert.equal(serialized.settings.surfaceBackend, 'patch');
assert.equal(serialized.settings.patchHeight, 0.12);
assert.equal(serialized.settings.manualMeshing, true, 'manual meshing preference persists');
assert.equal(serialized.committed.length, 1);
assert.equal(serialized.committed[0].seed, 42);
assert.ok(!('conformed' in serialized.committed[0]), 'derived surface data is not persisted');
assert.ok(!('targetGeometry' in serialized), 'dense geometry does not leak into localStorage JSON');

const restored = await restoreStore(serialized);
assert.deepEqual(restored.targetScale3, [1, -1, 1]);
assert.deepEqual(restored.targetPosition, [1, 2, 3]);
assert.deepEqual(
  restored.committed[0].raw.map(({ p, n }) => ({ p, n })),
  raw,
  'legacy raw positions and normals survive canonical restore',
);

// Surface CV strokes persist only their canonical edit data. Sampled/welded
// paths are target-dependent caches and must be rebuilt after restore.
const splineSerialized = serializeStore({
  committed: [{
    kind: 'spline',
    cvs,
    cvRadiusScales,
    closed: true,
    seed: 123,
    raw: [{ private: 'sampled spline cache' }],
    conformed: [{ private: 'welded cache' }],
    conformedM: [{ private: 'mirrored cache' }],
  }],
  redo: [{
    kind: 'spline',
    cvs,
    cvRadiusScales,
    closed: false,
    seed: 456,
    raw: [{ private: true }],
  }],
});
const expectedSpline = {
  kind: 'spline',
  cvs,
  cvRadiusScales,
  closed: true,
  seed: 123,
};
assert.deepEqual(splineSerialized.committed[0], expectedSpline, 'surface spline edit data round-trips canonically');
assert.deepEqual(splineSerialized.redo[0], { ...expectedSpline, closed: false, seed: 456 }, 'redo preserves surface splines');
for (const key of ['raw', 'conformed', 'conformedM', 'points', 'expanded']) {
  assert.ok(!(key in splineSerialized.committed[0]), `${key} derived cache is omitted from surface spline saves`);
}

const splineRestored = await restoreStore(splineSerialized);
assert.deepEqual(splineRestored.committed[0], expectedSpline, 'surface spline survives restore');
assert.ok(!('raw' in splineRestored.committed[0]), 'restore does not manufacture target-dependent spline samples');

// Plain raw records are the legacy/freehand schema and remain accepted beside
// the new spline record shape.
const mixed = serializeStore({
  committed: [
    { raw, seed: 7 },
    { kind: 'spline', cvs, cvRadiusScales, closed: false, seed: 8 },
  ],
});
assert.equal(mixed.committed[0].seed, 7, 'legacy raw surface stroke preserves its seed');
assert.deepEqual(
  mixed.committed[0].raw.map(({ p, n }) => ({ p, n })),
  raw,
  'legacy raw surface stroke remains accepted without an explicit kind',
);
if (mixed.committed[0].kind != null) {
  assert.equal(mixed.committed[0].kind, 'freehand', 'legacy raw input may be canonicalized as freehand');
}
assert.ok(
  mixed.committed[0].raw.every((sample) => (sample.radiusScale ?? 1) === 1),
  'legacy raw samples acquire a uniform radius profile',
);
assert.equal(mixed.committed[1].kind, 'spline', 'legacy and spline strokes can coexist');

const malformed = serializeStore({
  committed: [{ raw: [{ p: [0, 0], n: [0, 1, 0] }] }],
  targetPosition: [Infinity, 0, 0],
});
assert.equal(malformed.committed.length, 0, 'malformed strokes are dropped on restore');
assert.ok(!('targetPosition' in malformed), 'non-finite transforms are dropped on restore');

const malformedSplines = serializeStore({
  committed: [
    { kind: 'spline', cvs: cvs.slice(0, 1), cvRadiusScales: [1], closed: false, seed: 1 },
    { kind: 'spline', cvs: [{ p: [0, 0], n: [0, 1, 0] }, ...cvs.slice(1)], cvRadiusScales, closed: false, seed: 2 },
    { kind: 'spline', cvs: [{ p: [0, 0, 0], n: [0, Infinity, 0] }, ...cvs.slice(1)], cvRadiusScales, closed: false, seed: 3 },
    { kind: 'spline', cvs, cvRadiusScales: [1, 2], closed: false, seed: 4 },
    { kind: 'spline', cvs, cvRadiusScales: [1, Number.NaN, 1], closed: false, seed: 5 },
    { kind: 'spline', cvs, cvRadiusScales: [1, -0.25, 1], closed: false, seed: 6 },
  ],
});
assert.equal(
  malformedSplines.committed.length,
  0,
  'short/malformed CV lists and mismatched, non-finite, or non-positive radii are rejected',
);

console.log('surface demo store OK');
