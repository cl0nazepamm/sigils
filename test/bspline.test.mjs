import assert from 'node:assert/strict';
import { bspline } from '../src/bspline.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const nearPt = (p, q, eps = 1e-9) => near(p[0], q[0], eps) && near(p[1], q[1], eps);

// --- degenerate inputs ---
assert.deepEqual(bspline([]), [], 'empty input yields empty polyline');
assert.deepEqual(bspline([[1, 2]]), [], 'single CV yields empty polyline');

// --- open (clamped): endpoints pinned to first/last CV ---
const cvs = [[0, 0], [1, 2], [3, 2], [4, 0], [5, -1]];
const open = bspline(cvs);
assert.ok(open.length > 16, 'open spline is densely sampled');
assert.ok(nearPt(open[0], cvs[0]), 'clamped start hits first CV');
assert.ok(nearPt(open.at(-1), cvs.at(-1)), 'clamped end hits last CV');

// interior stays inside the CV hull bounds (convex hull property).
for (const [x, y] of open) {
  assert.ok(x >= 0 - 1e-9 && x <= 5 + 1e-9, 'x within hull bounds');
  assert.ok(y >= -1 - 1e-9 && y <= 2 + 1e-9, 'y within hull bounds');
}

// approximating, not interpolating: interior CVs are NOT on the curve.
const hitsInteriorCv = open.some((p) => nearPt(p, [3, 2], 1e-6));
assert.ok(!hitsInteriorCv, 'interior CV is approximated, not interpolated');

// --- two CVs degrade to a straight segment ---
const line = bspline([[0, 0], [2, 2]]);
assert.ok(nearPt(line[0], [0, 0]) && nearPt(line.at(-1), [2, 2]), 'line endpoints');
for (const [x, y] of line) assert.ok(near(x, y, 1e-9), 'two CVs sample along the segment');

// --- symmetry: symmetric CVs produce a symmetric curve ---
const sym = bspline([[-2, 0], [-1, 2], [1, 2], [2, 0]]);
for (const [x, y] of sym) {
  const mirrored = sym.find((q) => near(q[0], -x, 1e-6));
  assert.ok(mirrored && near(mirrored[1], y, 1e-6), 'mirror-symmetric sampling');
}

// --- closed (periodic): seamless loop, no duplicate seam point ---
const square = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
const closed = bspline(square, { closed: true });
assert.ok(closed.length > 16, 'closed spline is densely sampled');
const first = closed[0];
const last = closed.at(-1);
assert.ok(!nearPt(first, last, 1e-9), 'closed loop omits the duplicate seam sample');
// wrap distance stays comparable to neighbor spacing (continuous seam).
const step = Math.hypot(closed[1][0] - closed[0][0], closed[1][1] - closed[0][1]);
const seam = Math.hypot(first[0] - last[0], first[1] - last[1]);
assert.ok(seam < step * 2.5, `closed seam is continuous (seam ${seam}, step ${step})`);
// the periodic square loop is centered and symmetric.
const cx = closed.reduce((s, p) => s + p[0], 0) / closed.length;
const cy = closed.reduce((s, p) => s + p[1], 0) / closed.length;
assert.ok(near(cx, 0, 1e-6) && near(cy, 0, 1e-6), 'closed loop is centered');

// --- degree falls back when CVs are scarce ---
const tri = bspline([[0, 0], [1, 1], [2, 0]], { closed: true });
assert.ok(tri.length > 8, 'closed spline with 3 CVs still evaluates');
const quad = bspline([[0, 0], [1, 1], [2, 0]]);
assert.ok(nearPt(quad[0], [0, 0]) && nearPt(quad.at(-1), [2, 0]), 'degree-2 fallback stays clamped');

// --- optional per-CV radius profile follows the same spline basis ---
const weightedLine = bspline([[0, 0], [2, 0]], { radiusScales: [0.5, 2.5] });
assert.deepEqual(weightedLine[0], [0, 0, 0.5], 'weighted open start keeps first CV radius');
assert.deepEqual(weightedLine.at(-1), [2, 0, 2.5], 'weighted open end keeps last CV radius');
assert.ok(near(weightedLine[Math.floor(weightedLine.length / 2)][2], 1.5),
  'two-CV radius profile interpolates linearly');

const openRadii = [0.25, 0.5, 1.5, 2, 0.75];
const weightedOpen = bspline(cvs, { radiusScales: openRadii });
assert.equal(weightedOpen.length, open.length, 'radius channel does not change sampling density');
for (let i = 0; i < weightedOpen.length; i++) {
  assert.ok(nearPt(weightedOpen[i], open[i]), 'radius channel does not move sampled XY');
  assert.ok(Number.isFinite(weightedOpen[i][2]), 'sampled radius stays finite');
  assert.ok(weightedOpen[i][2] >= Math.min(...openRadii) - 1e-9
    && weightedOpen[i][2] <= Math.max(...openRadii) + 1e-9,
    'sampled radius stays inside the CV profile bounds');
}
assert.ok(near(weightedOpen[0][2], openRadii[0]), 'open radius profile is clamped at its start');
assert.ok(near(weightedOpen.at(-1)[2], openRadii.at(-1)), 'open radius profile is clamped at its end');

const closedRadii = [0.25, 1.25, 2.5, 0.75];
const weightedClosed = bspline(square, { closed: true, radiusScales: closedRadii });
assert.equal(weightedClosed.length, closed.length, 'closed radius profile keeps periodic sample count');
const radiusStep = Math.abs(weightedClosed[1][2] - weightedClosed[0][2]);
const radiusSeam = Math.abs(weightedClosed[0][2] - weightedClosed.at(-1)[2]);
assert.ok(radiusSeam < radiusStep * 1.25,
  `closed radius profile is continuous at the seam (seam ${radiusSeam}, step ${radiusStep})`);
assert.ok(Math.max(...weightedClosed.map((p) => p[2]))
  - Math.min(...weightedClosed.map((p) => p[2])) > 0.5,
  'closed spline retains a non-uniform radius profile');

// The 3D extension must not perturb the established 2D evaluator. These are
// exact outputs captured from the 2D implementation, not approximate checks.
const compatibilityCvs = [[0, 0], [1, 2], [3, 1], [4, -1]];
const exact2d = bspline(compatibilityCvs, { samplesPerSpan: 2 });
assert.deepEqual(exact2d, [[0, 0], [2, 1], [4, -1]],
  '2D sampling remains exactly compatible');
assert.deepEqual(
  bspline(compatibilityCvs, { samplesPerSpan: 2, radiusScales: [0.5, 1, 2, 0.75] }),
  [[0, 0, 0.5], [2, 1, 1.28125], [4, -1, 0.75]],
  '2D radius output remains exactly compatible');

// 3D positions use the same basis, with radius appended as a fourth channel.
const cvs3 = [[0, 0, 1], [1, 2, 2], [3, 1, -1], [4, -1, 0.5]];
const curve3 = bspline(cvs3, { samplesPerSpan: 2 });
assert.equal(curve3[0].length, 3, 'unweighted 3D spline emits xyz tuples');
assert.deepEqual(curve3.map(([x, y]) => [x, y]), exact2d,
  'adding Z does not perturb XY sampling');
assert.deepEqual(curve3[0], cvs3[0], '3D open start is clamped to its first CV');
assert.deepEqual(curve3.at(-1), cvs3.at(-1), '3D open end is clamped to its last CV');
assert.notEqual(curve3[1][2], 0, '3D spline evaluates a real Z channel');

const curve3Radius = bspline(cvs3, {
  samplesPerSpan: 2,
  radiusScales: [0.5, 1, 2, 0.75],
});
assert.ok(curve3Radius.every((point) => point.length === 4),
  'weighted 3D spline emits xyz plus radius');
assert.deepEqual(curve3Radius.map((point) => point.slice(0, 3)), curve3,
  'radius does not perturb sampled XYZ');
assert.equal(curve3Radius[0][3], 0.5, '3D radius is clamped at the open start');
assert.equal(curve3Radius.at(-1)[3], 0.75, '3D radius is clamped at the open end');

console.log('bspline OK');
