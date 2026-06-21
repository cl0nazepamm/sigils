/**
 * Spirograph curve generator (hypotrochoid / epitrochoid).
 *
 *   x = (R - r)·cos t + d·cos(((R - r)/r)·t)
 *   y = (R - r)·sin t − d·sin(((R - r)/r)·t)
 *
 * The self-intersections and cusps of these curves are what give a fattened
 * sigil its sharp points (instead of rounded blobs):
 *   - d ≈ r        → a hypocycloid with sharp cusps (R/r = 4 → astroid, 4 cusps).
 *   - d > r        → looping petals that cross (a connected network when fattened).
 *
 * The curve is scaled so its outer radius equals `radius`.
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.R=5]       - fixed ring radius (integer-ish for closure)
 * @param {number} [opts.r=3]       - rolling circle radius
 * @param {number} [opts.d=5]       - pen offset (d≈r → cusps; d>r → loops)
 * @param {number} [opts.radius=1]  - target outer radius (the curve is scaled to fit)
 * @param {number} [opts.turns]     - revolutions; default closes the curve exactly
 * @param {number} [opts.steps=2000]- sample count
 * @returns {[number, number][]}
 */
export function spirograph(opts = {}) {
  const { R = 5, r = 3, d = 5, radius = 1, steps = 2000 } = opts;

  const g = gcd(Math.round(R), Math.round(r)) || 1;
  const revolutions = opts.turns ?? Math.round(r / g);
  const tMax = Math.PI * 2 * revolutions;
  const k = (R - r) / r;

  const raw = new Array(steps + 1);
  let maxR = 1e-9;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * tMax;
    const x = (R - r) * Math.cos(t) + d * Math.cos(k * t);
    const y = (R - r) * Math.sin(t) - d * Math.sin(k * t);
    raw[i] = [x, y];
    const m = Math.hypot(x, y);
    if (m > maxR) maxR = m;
  }

  const s = radius / maxR;
  for (let i = 0; i <= steps; i++) {
    raw[i][0] *= s;
    raw[i][1] *= s;
  }
  return raw;
}

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}
