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

console.log('bspline OK');
