/**
 * Surface vines: sweep painted strokes that lie ON a mesh into chrome
 * sigil-work — profiled bands that hug the surface, with procedural thorn
 * offshoots (the couture-armor look).
 *
 * The cross-section carries the sigil character, mirroring the flat field
 * pipeline's relief semantics:
 *   - relief 'carve'   → peaked ridge (the classic engraved-sigil profile)
 *   - relief 'plateau' → flat-topped band with beveled rims
 *   - relief 'round'   → elliptical wire
 * `radius` is the lateral half-width and `peak` the height off the skin —
 * independent, exactly like Width vs Peak in the field modes. Sections sit
 * slightly below the surface so the metal reads as welded on, not floating.
 * `conform` (fraction of peak) pulls the whole section deeper along −normal so
 * seating depth is not tied to raising peak.
 *
 * Two builders share one skeleton (`vineDescriptor`: resampled path, frames,
 * section profile, thorn placements — all seeded, so rebuilds are stable):
 *
 * - buildSurfaceVineGeometry: direct swept band. Cheap and allocation-light;
 *   this is the live preview while a stroke is being painted. Crossing
 *   strokes interpenetrate — no welding.
 *
 * - buildSurfaceVineFieldGeometry: volume-style union. Every band segment
 *   becomes an extruded-profile SDF (thorns stay round cones); strokes merge
 *   through a smooth-min and the iso-surface is extracted with SPARSE
 *   surface nets (breadth-first over shell cells only — empty space is never
 *   visited). Where vines cross they weld into one liquid-metal joint. This
 *   is the committed look.
 *
 * The caller owns "conforming": samples must already sit on the target
 * surface with outward unit normals (see the paint-on-mesh example, which
 * smooths the raw pointer polyline and welds it back via a mesh index).
 */

import { BufferGeometry, BufferAttribute } from 'three';

// sections sink this fraction of the peak below the surface
const EMBED = 0.12;

/**
 * @typedef {{p:[number,number,number]|[number,number,number,number], n:[number,number,number], radiusScale?:number}} SurfaceSample
 *
 * Shared options (both builders):
 * @typedef {object} VineOptions
 * @property {number} [radius=0.03]      lateral half-width (same units as samples)
 * @property {number} [peak]             section height off the skin; default radius*1.5
 * @property {'carve'|'plateau'|'round'} [relief='round']
 * @property {number} [wobble=0.35]      0..1 organic section undulation
 * @property {number} [melt=0]           0..1 section-corner rounding — the molten
 *                                       field look; carve keeps a soft ridge
 * @property {number} [taper=3]          tip taper length, in ornament units
 * @property {number} [taperPower=0.72]  tip profile exponent: <1 blunt, >1 needle
 * @property {number} [thornSpacing=0]   arc distance between thorns, in ornament units (0 = none)
 * @property {number} [thornLength=3]    thorn length, in ornament units
 * @property {number} [conform=0]          pull whole section into the mesh along −normal, as a fraction of peak
 * @property {number} [seed=1]
 * @property {boolean} [closed=false]    join last sample back to first without tapered caps
 *
 * "Ornament units" = max(radius, peak*0.75): taper, thorns, weld and wobble
 * ride the section size, so a hairline width keeps its full character.
 */

/* ============================================================== skeleton */

function vineDescriptor(samples, opts = {}) {
  const radius = Math.max(1e-5, opts.radius ?? 0.03);
  const peak = Math.max(1e-5, opts.peak ?? radius * 1.5);
  const relief = opts.relief ?? 'round';
  const wobble = clamp01(opts.wobble ?? 0.35);
  const melt = clamp01(opts.melt ?? 0);
  // Ornament features (taper, thorns, wobble period) scale with the SECTION
  // size, not the width alone — a hairline band keeps its full character
  // instead of collapsing into a dead wire when the width goes small.
  const ornament = ornamentScale(radius, peak);
  const taperLen = ornament * Math.max(0.5, opts.taper ?? 3);
  const taperPower = Math.max(0.2, opts.taperPower ?? 0.72);
  const thornSpacing = Math.max(0, opts.thornSpacing ?? 0) * ornament;
  const thornLength = ornament * Math.max(0.5, opts.thornLength ?? 3);
  const conform = Math.max(0, opts.conform ?? 0);
  const rng = mulberry32((opts.seed ?? 1) >>> 0 || 1);

  const step = ornament * 0.6;
  const closed = opts.closed === true || samplesFormClosedLoop(samples);
  const sampled = resampleSamples(samples, step, 512, closed);
  const path = sampled?.path;
  if (!path || path.length < 3) return null;

  const frames = surfaceFrames(path, closed);
  const total = sampled.total;

  // Section modulation: pointy tips, plus two incommensurate sine harmonics
  // for the hand-forged undulation (period tied to the width so it scales).
  // One factor drives BOTH width and peak so the section keeps its shape.
  const phaseA = rng() * Math.PI * 2;
  const phaseB = rng() * Math.PI * 2;
  // Closed modulation must return to the same value and derivative at the
  // seam. Choose the nearest integer harmonic to each open-path wavelength;
  // the open branch below deliberately retains its original arithmetic.
  const loopPhaseScale = closed && total > 0 ? (Math.PI * 2) / total : 0;
  const loopHarmonicA = closed
    ? Math.max(1, Math.round(total / (Math.PI * 2 * ornament * 5.2)))
    : 0;
  const loopHarmonicB = closed
    ? Math.max(1, Math.round(total / (Math.PI * 2 * ornament * 2.3)))
    : 0;
  const mods = path.map(({ s }) => {
    // The final resampled `s` can round a few ulps past `total`. Clamp before
    // the fractional taper power so an open tip becomes zero, never NaN.
    const tip = closed ? Infinity : Math.max(0, Math.min(s, total - s));
    const pinch = closed || tip >= taperLen ? 1 : Math.pow(tip / taperLen, taperPower);
    const waveA = closed ? s * loopPhaseScale * loopHarmonicA : s / (ornament * 5.2);
    const waveB = closed ? s * loopPhaseScale * loopHarmonicB : s / (ornament * 2.3);
    const wave = 1
      + wobble * 0.28 * Math.sin(waveA + phaseA)
      + wobble * 0.14 * Math.sin(waveB + phaseB);
    return pinch * Math.max(0.25, wave);
  });
  // interior sections never shrink below the field's cell size (sub-cell
  // stretches "bead" into disconnected specks); the end stations still pinch
  // to zero so tips stay sharp
  const minSection = Math.max(0, opts.minSection ?? 0);
  const last = mods.length - 1;
  const widths = mods.map((m, i) => {
    const value = radius * m * path[i].radiusScale;
    return !closed && (i === 0 || i === last) ? value : Math.max(value, minSection);
  });
  const peaks = mods.map((m, i) => {
    const value = peak * m * path[i].radiusScale;
    return !closed && (i === 0 || i === last) ? value : Math.max(value, minSection * 2);
  });

  const thorns = [];
  if (thornSpacing > 0) {
    const margin = closed ? 0 : taperLen * 1.15;
    let side = rng() < 0.5 ? 1 : -1;
    let s = margin + rng() * thornSpacing * (closed ? 1 : 0.5);
    while (s < total - margin) {
      const i = nearestIndex(path, s, total, closed);
      const f = frames[i];

      // Lean outward off the skin, kick sideways off the vine, drift along it.
      const outw = 0.5 + rng() * 0.55;
      const sway = side * (0.55 + rng() * 0.6);
      const drift = (rng() - 0.5) * 0.5;
      const dir = [
        f.n[0] * outw + f.b[0] * sway + f.t[0] * drift,
        f.n[1] * outw + f.b[1] * sway + f.t[1] * drift,
        f.n[2] * outw + f.b[2] * sway + f.t[2] * drift,
      ];
      normalize3(dir);

      const len = thornLength * (0.6 + rng() * 0.8) * Math.min(1, mods[i] + 0.35);
      // thorn roots may be fatter than a hairline band — the field welds the
      // joint shut, and a spike needs enough girth to read as metal
      const section = Math.max(
        Math.min(widths[i], peaks[i]),
        ornament * mods[i] * path[i].radiusScale * 0.5,
      );
      const baseR = Math.min(section * 0.9, ornament * 0.6);
      // root the thorn inside the band so the weld is seamless
      const p = path[i].p;
      const sink = peaks[i] * conform;
      const base = [
        p[0] + f.n[0] * (peaks[i] * 0.45 - sink) + dir[0] * widths[i] * 0.15,
        p[1] + f.n[1] * (peaks[i] * 0.45 - sink) + dir[1] * widths[i] * 0.15,
        p[2] + f.n[2] * (peaks[i] * 0.45 - sink) + dir[2] * widths[i] * 0.15,
      ];
      thorns.push({ base, dir, bendN: f.n, len, baseR, bend: len * (0.2 + rng() * 0.3) });

      side = -side;
      s += thornSpacing * (0.7 + rng() * 0.7);
    }
  }

  return { path, frames, widths, peaks, thorns, radius, peak, relief, melt, conform, closed };
}

/** Point along a thorn's bent spine at t ∈ [0,1], and its radius. */
function thornPoint(th, t) {
  return [
    th.base[0] + th.dir[0] * th.len * t + th.bendN[0] * th.bend * t * t,
    th.base[1] + th.dir[1] * th.len * t + th.bendN[1] * th.bend * t * t,
    th.base[2] + th.dir[2] * th.len * t + th.bendN[2] * th.bend * t * t,
  ];
}

function thornRadius(th, t) {
  return t >= 1 ? 0 : th.baseR * Math.pow(1 - t, 1.35);
}

/* ======================================================= section outlines */

/**
 * Normalized section outlines in (lateral ℓ, height h): ℓ scales by the
 * half-width, h by the peak. h runs from -EMBED (below the skin) to 1.
 * Ordered top → +ℓ → bottom → -ℓ, matching the old ring winding.
 */
const OUTLINES = {
  round: Array.from({ length: 12 }, (_, k) => {
    const a = (k / 12) * Math.PI * 2;
    return [Math.sin(a), (1 - EMBED) / 2 + (1 + EMBED) / 2 * Math.cos(a)];
  }),
  carve: [
    [0, 1], [0.5, 0.44], [0.9, -0.08], [0.45, -EMBED],
    [-0.45, -EMBED], [-0.9, -0.08], [-0.5, 0.44],
  ],
  plateau: [
    [0, 1], [0.55, 1], [0.92, 0.82], [1, 0.4], [0.92, -0.06], [0.45, -EMBED],
    [-0.45, -EMBED], [-0.92, -0.06], [-1, 0.4], [-0.92, 0.82], [-0.55, 1],
  ],
};

/**
 * 2D signed distance of a section at (ℓ, h), half-width w, height pk.
 * `round` (absolute units) melts the profile corners: the section is shrunk
 * and re-inflated by that amount, like the field pipeline's molten smoothing.
 */
function sdSection(l, h, w, pk, relief, round = 0) {
  if (round > 0) {
    const m = Math.min(round, w * 0.7, pk * 0.7);
    return sdSectionCore(l, h, w - m, pk - m, relief) - m;
  }
  return sdSectionCore(l, h, w, pk, relief);
}

function sdSectionCore(l, h, w, pk, relief) {
  if (relief === 'plateau') {
    // rounded box spanning ℓ ∈ [-w, w], h ∈ [-EMBED*pk, pk]
    const cy = pk * (1 - EMBED) * 0.5;
    const hy = pk * (1 + EMBED) * 0.5;
    const r = Math.min(w, hy) * 0.45;
    const qx = Math.abs(l) - w + r;
    const qy = Math.abs(h - cy) - hy + r;
    const ax = qx > 0 ? qx : 0, ay = qy > 0 ? qy : 0;
    return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
  }
  if (relief === 'carve') {
    // peaked wedge: base corners (±w, -EMBED*pk), apex (0, pk); half-plane
    // max is exact inside/near edges — corner chamfer is hidden by the smin
    const e = EMBED * pk;
    const dBase = -(h + e);
    const len = Math.sqrt((pk + e) * (pk + e) + w * w);
    const dSide = ((Math.abs(l) - w) * (pk + e) + (h + e) * w) / len;
    return Math.max(dBase, dSide) - 0.06 * pk;
  }
  // round: ellipse, radii (w, pk*(1+EMBED)/2), centered below the crest
  const ry = pk * (1 + EMBED) * 0.5;
  const cy = pk * (1 - EMBED) * 0.5;
  const k = Math.hypot(l / w, (h - cy) / ry);
  return (k - 1) * Math.min(w, ry);
}

/* ================================================================= sweep */

/**
 * Direct swept band + thorn cones — fast, un-welded. Live-preview builder.
 *
 * @param {SurfaceSample[]} samples - stroke points on the surface (≥ 2)
 * @param {VineOptions} [opts]
 * @returns {BufferGeometry} indexed, with computed normals (empty when degenerate)
 */
export function buildSurfaceVineGeometry(samples, opts = {}) {
  const desc = vineDescriptor(samples, opts);
  if (!desc) return new BufferGeometry();
  const { path, frames, widths, peaks, thorns, relief, melt, conform, closed } = desc;
  let outline = OUTLINES[relief] ?? OUTLINES.round;
  // preview counterpart of the field's molten rounding: corner-cut the outline
  if (melt > 0.2) outline = chaikin(outline);
  if (melt > 0.55) outline = chaikin(outline);

  const builder = createBuilder();

  const rings = [];
  for (let i = 0; i < path.length; i++) {
    rings.push(builder.profileRing(
      path[i].p, frames[i].n, frames[i].b, widths[i], peaks[i], outline, conform,
    ));
  }
  const bandSegments = closed ? rings.length : rings.length - 1;
  for (let i = 0; i < bandSegments; i++) {
    builder.stitch(rings[i], rings[(i + 1) % rings.length]);
  }

  if (!closed) {
    // Open ends pinch to zero section — close them with a point fan on the skin.
    const first = path[0].p, last = path[path.length - 1].p;
    builder.fan(builder.vertex(first[0], first[1], first[2]), rings[0], true);
    builder.fan(builder.vertex(last[0], last[1], last[2]), rings[rings.length - 1], false);
  }

  for (const th of thorns) {
    const u = orthogonal(th.dir);
    const v = cross3(th.dir, u);
    const steps = [0, 0.34, 0.62, 0.83];
    const thornRings = steps.map((t) =>
      builder.ring(thornPoint(th, t), u, v, thornRadius(th, t), 6));
    for (let i = 0; i < thornRings.length - 1; i++) builder.stitch(thornRings[i], thornRings[i + 1]);
    builder.fan(builder.vertex(...thornPoint(th, 1)), thornRings[thornRings.length - 1], false);
  }

  return builder.finish();
}

/* ================================================================= field */

/**
 * Volume-style union of many vines: bands become extruded-profile SDFs,
 * thorns round cones, all smooth-min blended, and the iso-surface is
 * extracted with sparse surface nets. Crossing strokes weld into one
 * continuous chrome body.
 *
 * @param {Array<{samples: SurfaceSample[], seed?: number, closed?: boolean}>} strokes
 * @param {VineOptions & {
 *   blend?: number,      // weld softness in ornament units (default 0.9)
 *   detail?: number,     // grid cells across the smallest full section axis (default 3.2)
 *   cellBudget?: number, // soft cap on shell cells ≈ output verts (default 100000)
 * }} [opts]
 * @returns {BufferGeometry} indexed, with SDF-gradient normals
 */
export function buildSurfaceVineFieldGeometry(strokes, opts = {}) {
  const radius0 = Math.max(1e-5, opts.radius ?? 0.03);
  const peak0 = Math.max(1e-5, opts.peak ?? radius0 * 1.5);
  const detail = Math.max(1.5, opts.detail ?? 3.2);
  const budget = Math.max(10_000, opts.cellBudget ?? 100_000);

  const build = (radius, peak, minSection) => {
    const segments = [];
    const seeds = []; // points on (or near) the union surface to start the BFS
    let group = 0;
    let area = 0; // rough shell area, to price the grid before building it
    let minRadiusScale = Infinity;
    for (const stroke of strokes ?? []) {
      const desc = vineDescriptor(stroke.samples, {
        ...opts,
        radius,
        peak,
        minSection,
        closed: stroke.closed ?? opts.closed,
        seed: stroke.seed ?? opts.seed ?? 1,
      });
      if (!desc) continue;
      group = collectSegments(desc, segments, group);
      const { path, frames, widths, peaks } = desc;
      for (const sample of path) {
        if (sample.radiusScale > 0) minRadiusScale = Math.min(minRadiusScale, sample.radiusScale);
      }
      const step = Math.max(1, path.length >> 4);
      for (let i = 0; i < path.length; i += step) {
        const sink = peaks[i] * desc.conform;
        const n = frames[i].n;
        seeds.push({
          at: [
            path[i].p[0] - n[0] * sink * 0.5,
            path[i].p[1] - n[1] * sink * 0.5,
            path[i].p[2] - n[2] * sink * 0.5,
          ],
          out: n,
          r: Math.max(widths[i], peaks[i]),
        });
      }
    }
    for (const s of segments) {
      const perim = s.kind === 1
        ? 2 * (s.wa + s.wb) + 1.12 * (s.pa + s.pb)
        : Math.PI * (s.ra + s.rb);
      area += perim * (s.kind === 1 ? s.L : Math.sqrt(s.l2));
    }
    return {
      segments,
      seeds,
      area,
      minRadiusScale: Number.isFinite(minRadiusScale) ? minRadiusScale : 1,
    };
  };

  let { segments, area, minRadiusScale } = build(radius0, peak0, 0);
  if (segments.length === 0) return new BufferGeometry();

  // the grid must resolve the smallest FULL section axis (a flat band's
  // height, a hairline band's width) or the surface falls between samples...
  // Radius profiles are UI-clamped to 0.05. Resolve that authored scale when
  // affordable, while the area-derived budget and MAX_DIM cap below remain
  // hard upper bounds on work for mixed wide/narrow drawings.
  // Resolve the larger section axis. Sizing the grid to a tiny authored peak
  // forced an ultra-fine cell, tripped the budget path, then isotropic
  // dilation rebuilt height from the coarse cell — shallow carves became fins.
  const profileResolutionScale = Math.max(0.05, Math.min(1, minRadiusScale));
  let cell = (Math.max(radius0, peak0) * profileResolutionScale) / detail;
  let radius = radius0, peak = peak0;
  // Extreme drawings still need a spend cap: coarsen to the budget and scale
  // the WHOLE section up so the larger axis clears the grid — keep the
  // authored peak/width ratio (never inflate peak alone).
  // Thin variable-radius sections spend proportionally more straddling cells
  // after extraction dilation than their authored perimeter predicts. The 13.6
  // calibration keeps that worst case near the soft budget; ordinary sections
  // still use the detail-derived cell whenever it is already coarser.
  const budgetCell = Math.sqrt((area * 13.6) / budget);
  if (budgetCell > cell) {
    cell = budgetCell;
    const minAxis = cell * 1.2;
    const major0 = Math.max(radius0, peak0);
    const scale = major0 > 1e-12 ? Math.max(1, minAxis / major0) : 1;
    radius = radius0 * scale;
    peak = peak0 * scale;
  }
  // Keep the authored local section all the way down to the UI's 0.05 radius
  // scale. The extractor already supplies a bounded, grid-relative dilation
  // below; flooring the SDF section itself made every scale below ~0.35 the
  // same size. Dilation retains the anti-speck minimum footprint without
  // erasing the profile before sampling, and the cell/budget caps stay intact.
  const final = build(radius, peak, 0);

  // weld softness rides the ornament scale too: hairline bands still melt
  const blend = ornamentScale(radius, peak) * Math.max(0.01, opts.blend ?? 0.9);
  // Shallow sections (peak << width) have wide sub-cell rim wedges; scale the
  // extractor's anti-fin dilation with the aspect so flat inlays stay clean
  // while proud sections keep the tighter (crisper) 0.35 floor.
  const aspect = Math.min(1, peak / Math.max(radius, 1e-9));
  let dilateScale = Math.min(0.8, 0.35 + 0.45 * (1 - aspect));
  // Isotropic dilation also grows HEIGHT. Cap it for shallow carves so a coarse
  // budget cell cannot invent tall fins that dwarf the authored peak.
  if (aspect < 0.45) {
    const peakDilate = Math.max(peak * 2.5, cell * 0.2);
    dilateScale = Math.min(dilateScale, peakDilate / Math.max(cell, 1e-12));
  }
  return surfaceNets(final.segments, final.seeds, { cell, blend, dilateScale });
}

/**
 * Emit a stroke's segments. Chained pieces (the band; each thorn) share a
 * `group`: within a group the union is an exact min — consecutive segments
 * are near-equidistant everywhere, and a smooth-min there would inflate the
 * whole band by ~blend/4 and round off the carve ridge. The smooth weld only
 * happens ACROSS groups (stroke crossings, thorn roots, mirror twins).
 */
function collectSegments(desc, out, group) {
  const { path, frames, widths, peaks, thorns, relief, melt, conform, closed } = desc;
  const bandSegments = closed ? path.length : path.length - 1;
  for (let i = 0; i < bandSegments; i++) {
    const j = (i + 1) % path.length;
    const seg = bandSegment(
      path[i].p, path[j].p, frames[i], frames[j],
      widths[i], widths[j], peaks[i], peaks[j], relief, conform,
    );
    seg.group = group;
    seg.melt = melt;
    out.push(seg);
  }
  const steps = [0, 0.34, 0.62, 0.83, 1];
  for (const th of thorns) {
    group++;
    for (let i = 0; i < steps.length - 1; i++) {
      const seg = coneSegment(
        thornPoint(th, steps[i]), thornPoint(th, steps[i + 1]),
        thornRadius(th, steps[i]), thornRadius(th, steps[i + 1]),
      );
      seg.group = group;
      out.push(seg);
    }
  }
  return group + 1;
}

/** Extruded sigil section between two stations, frame-lerped. */
function bandSegment(a, b, fa, fb, wa, wb, pa, pb, relief, conform = 0) {
  const tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
  const L = Math.hypot(tx, ty, tz) || 1e-9;
  const n = [(fa.n[0] + fb.n[0]) * 0.5, (fa.n[1] + fb.n[1]) * 0.5, (fa.n[2] + fb.n[2]) * 0.5];
  normalize3(n);
  const bv = [(fa.b[0] + fb.b[0]) * 0.5, (fa.b[1] + fb.b[1]) * 0.5, (fa.b[2] + fb.b[2]) * 0.5];
  normalize3(bv);
  const rMax = Math.max(wa, wb, pa, pb);
  const sink = Math.max(0, conform) * Math.max(pa, pb);
  return {
    kind: 1, a, relief, conform,
    tx: tx / L, ty: ty / L, tz: tz / L, L,
    n, bv, wa, wb, pa, pb, rMax,
    cx: (a[0] + b[0]) * 0.5 - n[0] * sink * 0.5,
    cy: (a[1] + b[1]) * 0.5 - n[1] * sink * 0.5,
    cz: (a[2] + b[2]) * 0.5 - n[2] * sink * 0.5,
    br: L * 0.5 + rMax + sink,
  };
}

function sdBand(px, py, pz, seg) {
  const qx = px - seg.a[0], qy = py - seg.a[1], qz = pz - seg.a[2];
  const x = qx * seg.tx + qy * seg.ty + qz * seg.tz;
  const t = x <= 0 ? 0 : x >= seg.L ? 1 : x / seg.L;
  const w = seg.wa + (seg.wb - seg.wa) * t;
  const pk = seg.pa + (seg.pb - seg.pa) * t;
  const l = qx * seg.bv[0] + qy * seg.bv[1] + qz * seg.bv[2];
  // Shift section coords so conform pulls the band into the mesh along −n.
  const h = qx * seg.n[0] + qy * seg.n[1] + qz * seg.n[2] + (seg.conform ?? 0) * pk;
  const round = seg.melt > 0 ? seg.melt * 0.45 * Math.min(w, pk) : 0;
  const d2 = w > 1e-9 && pk > 1e-9 ? sdSection(l, h, w, pk, seg.relief, round) : Math.hypot(l, h);
  const over = Math.max(-x, x - seg.L, 0);
  if (over <= 0) return d2;
  return d2 <= 0 ? over : Math.hypot(d2, over);
}

/** Round cone (capsule with different end radii) for thorns. */
function coneSegment(a, b, ra, rb) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = ra - rb;
  const rMax = Math.max(ra, rb);
  return {
    kind: 0, a, ra, rb, rMax,
    bax, bay, baz, l2,
    il2: l2 > 0 ? 1 / l2 : 0,
    a2: l2 - rr * rr,
    rr,
    cx: (a[0] + b[0]) * 0.5, cy: (a[1] + b[1]) * 0.5, cz: (a[2] + b[2]) * 0.5,
    br: Math.sqrt(l2) * 0.5 + rMax,
  };
}

/** Quilez's sdRoundCone with segment constants precomputed. */
function sdRoundCone(px, py, pz, seg) {
  const [ax, ay, az] = seg.a;
  const { bax, bay, baz, l2, il2, rr, a2 } = seg;
  const pax = px - ax, pay = py - ay, paz = pz - az;
  if (l2 < 1e-12) return Math.hypot(pax, pay, paz) - seg.rMax;

  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const qx = pax * l2 - bax * y, qy = pay * l2 - bay * y, qz = paz * l2 - baz * y;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;

  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - seg.rb;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - seg.ra;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - seg.ra;
}

/** Polynomial smooth-min: unions melt together within k of each other. */
function smin(d1, d2, k) {
  const h = clamp01(0.5 + (0.5 * (d2 - d1)) / k);
  return d2 + (d1 - d2) * h - k * h * (1 - h);
}

/**
 * Sparse surface nets over the smooth-min union of segments. Cells are
 * visited by BFS from seed points outward along the shell, so cost scales
 * with the vine's surface area — the bounding box is never rasterized.
 */
function surfaceNets(segments, seeds, { cell, blend, dilateScale = 0.35 }) {
  // grid bounds: all segments inflated by section size + weld swell + margin
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const s of segments) {
    minX = Math.min(minX, s.cx - s.br - blend);
    minY = Math.min(minY, s.cy - s.br - blend);
    minZ = Math.min(minZ, s.cz - s.br - blend);
    maxX = Math.max(maxX, s.cx + s.br + blend);
    maxY = Math.max(maxY, s.cy + s.br + blend);
    maxZ = Math.max(maxZ, s.cz + s.br + blend);
  }
  minX -= cell * 3; minY -= cell * 3; minZ -= cell * 3;
  maxX += cell * 3; maxY += cell * 3; maxZ += cell * 3;

  // keep every axis under the packing budget; coarsen if a huge drawing asks
  // for more cells than that
  const MAX_DIM = 4000;
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (span / cell > MAX_DIM) cell = span / MAX_DIM;
  const nx = Math.ceil((maxX - minX) / cell) + 2;
  const ny = Math.ceil((maxY - minY) / cell) + 2;
  const nz = Math.ceil((maxZ - minZ) / cell) + 2;
  const packCell = (x, y, z) => (x * ny + y) * nz + z;

  // coarse grid of segments so each SDF eval only sees nearby pieces
  const coarse = cell * 4;
  const cnx = Math.ceil((maxX - minX) / coarse) + 1;
  const cny = Math.ceil((maxY - minY) / coarse) + 1;
  const cnz = Math.ceil((maxZ - minZ) / coarse) + 1;
  const segCells = new Map();
  const clampC = (v, n) => (v < 0 ? 0 : v >= n ? n - 1 : v);
  for (const s of segments) {
    const m = s.br + blend + coarse; // covers query-band + quantization slack
    const x0 = clampC(Math.floor((s.cx - m - minX) / coarse), cnx);
    const x1 = clampC(Math.floor((s.cx + m - minX) / coarse), cnx);
    const y0 = clampC(Math.floor((s.cy - m - minY) / coarse), cny);
    const y1 = clampC(Math.floor((s.cy + m - minY) / coarse), cny);
    const z0 = clampC(Math.floor((s.cz - m - minZ) / coarse), cnz);
    const z1 = clampC(Math.floor((s.cz + m - minZ) / coarse), cnz);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const key = (ix * cny + iy) * cnz + iz;
          let list = segCells.get(key);
          if (!list) segCells.set(key, (list = []));
          list.push(s);
        }
      }
    }
  }
  // collectSegments emits monotonically increasing group ids and every bucket
  // receives segments in that same order, so the lists are already grouped.

  const far = cell * 8;
  function sdf(x, y, z) {
    const ix = clampC(Math.floor((x - minX) / coarse), cnx);
    const iy = clampC(Math.floor((y - minY) / coarse), cny);
    const iz = clampC(Math.floor((z - minZ) / coarse), cnz);
    const list = segCells.get((ix * cny + iy) * cnz + iz);
    if (!list) return far;
    let d = far;        // welded union so far
    let chain = far;    // exact min within the current group
    let g = -1;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.group !== g) {
        if (chain < far) d = smin(d, chain, blend);
        chain = far;
        g = s.group;
      }
      // bounding-sphere reject (squared): this piece can't pull the min lower
      const de = chain < d ? chain : d;
      const t = de + blend + s.br;
      if (t > 0) {
        const dx = x - s.cx, dy = y - s.cy, dz = z - s.cz;
        if (dx * dx + dy * dy + dz * dz > t * t) continue;
      }
      const sd = s.kind === 1 ? sdBand(x, y, z, s) : sdRoundCone(x, y, z, s);
      if (sd < chain) chain = sd;
    }
    if (chain < far) d = smin(d, chain, blend);
    return d;
  }

  // Features thinner than the grid (the carve section's tapering skirts) fold
  // the shell back through a single cell and mesh as non-manifold fins — the
  // jagged-teeth edge artifact. Dilating the field floors every sheet's
  // thickness at what the grid can represent (a wedge of thickness t becomes
  // t + 2·dilate). The scale rises for shallow sections — peak << width makes
  // the sub-cell rim strip WIDE — via dilateScale from the builder.
  const dilate = cell * dilateScale;

  // cached corner samples
  const cornerVals = new Map();
  function corner(x, y, z) {
    const key = packCell(x, y, z);
    let v = cornerVals.get(key);
    if (v === undefined) {
      v = sdf(minX + x * cell, minY + y * cell, minZ + z * cell) - dilate;
      cornerVals.set(key, v);
    }
    return v;
  }

  const CORNERS = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  const positions = [];
  const normals = [];
  const cellVerts = new Map(); // packed cell -> vertex index
  const vals = new Float64Array(8);

  /** If the cell straddles the iso, place its vertex and return true. */
  function processCell(x, y, z, key) {
    let neg = false, pos = false;
    for (let c = 0; c < 8; c++) {
      const v = corner(x + CORNERS[c][0], y + CORNERS[c][1], z + CORNERS[c][2]);
      vals[c] = v;
      if (v < 0) neg = true; else pos = true;
    }
    if (!neg || !pos) return false;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of EDGES) {
      if ((vals[a] < 0) === (vals[b] < 0)) continue;
      const t = vals[a] / (vals[a] - vals[b]);
      sx += CORNERS[a][0] + (CORNERS[b][0] - CORNERS[a][0]) * t;
      sy += CORNERS[a][1] + (CORNERS[b][1] - CORNERS[a][1]) * t;
      sz += CORNERS[a][2] + (CORNERS[b][2] - CORNERS[a][2]) * t;
      n++;
    }
    const inv = n > 0 ? 1 / n : 0;
    const fx = sx * inv, fy = sy * inv, fz = sz * inv;
    cellVerts.set(key, positions.length / 3);
    positions.push(
      minX + (x + fx) * cell,
      minY + (y + fy) * cell,
      minZ + (z + fz) * cell,
    );
    // SDF gradient from the corner samples we already paid for: trilinear
    // interpolation of the axis differences at the vertex's fractional spot
    const gx = (vals[1] - vals[0]) * (1 - fy) * (1 - fz)
      + (vals[3] - vals[2]) * fy * (1 - fz)
      + (vals[5] - vals[4]) * (1 - fy) * fz
      + (vals[7] - vals[6]) * fy * fz;
    const gy = (vals[2] - vals[0]) * (1 - fx) * (1 - fz)
      + (vals[3] - vals[1]) * fx * (1 - fz)
      + (vals[6] - vals[4]) * (1 - fx) * fz
      + (vals[7] - vals[5]) * fx * fz;
    const gz = (vals[4] - vals[0]) * (1 - fx) * (1 - fy)
      + (vals[5] - vals[1]) * fx * (1 - fy)
      + (vals[6] - vals[2]) * (1 - fx) * fy
      + (vals[7] - vals[3]) * fx * fy;
    const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
    normals.push(gx / gl, gy / gl, gz / gl);
    return true;
  }

  // BFS from the seeds across the shell
  const MAX_CELLS = 600000;
  const queued = new Set();
  const queue = [];
  const enqueue = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= nx - 1 || y >= ny - 1 || z >= nz - 1) return;
    const key = packCell(x, y, z);
    if (queued.has(key)) return;
    queued.add(key);
    queue.push(x, y, z, key);
  };
  function enqueueNeighbors(x, y, z) {
    enqueue(x - 1, y, z); enqueue(x + 1, y, z);
    enqueue(x, y - 1, z); enqueue(x, y + 1, z);
    enqueue(x, y, z - 1); enqueue(x, y, z + 1);
  }

  for (const seed of seeds) {
    // march from the (inside) centerline outward until a shell cell is found
    const steps = Math.ceil((seed.r + blend) / cell) + 3;
    for (let k = 0; k <= steps; k++) {
      const px = seed.at[0] + seed.out[0] * k * cell;
      const py = seed.at[1] + seed.out[1] * k * cell;
      const pz = seed.at[2] + seed.out[2] * k * cell;
      const x = Math.floor((px - minX) / cell);
      const y = Math.floor((py - minY) / cell);
      const z = Math.floor((pz - minZ) / cell);
      if (x < 0 || y < 0 || z < 0 || x >= nx - 1 || y >= ny - 1 || z >= nz - 1) continue;
      const key = packCell(x, y, z);
      if (queued.has(key)) break;
      if (processCell(x, y, z, key)) {
        queued.add(key);
        enqueueNeighbors(x, y, z);
        break;
      }
    }
  }

  let truncated = false;
  for (let q = 0; q < queue.length; q += 4) {
    if (cellVerts.size >= MAX_CELLS) { truncated = true; break; }
    const x = queue[q], y = queue[q + 1], z = queue[q + 2], key = queue[q + 3];
    if (cellVerts.has(key)) continue;
    if (processCell(x, y, z, key)) enqueueNeighbors(x, y, z);
  }

  // faces: for every straddling cell, the three min-corner edges it owns
  const indices = [];
  const AXES = [
    { d: [1, 0, 0], quad: [[0, -1, -1], [0, 0, -1], [0, 0, 0], [0, -1, 0]] },
    { d: [0, 1, 0], quad: [[-1, 0, -1], [-1, 0, 0], [0, 0, 0], [0, 0, -1]] },
    { d: [0, 0, 1], quad: [[-1, -1, 0], [0, -1, 0], [0, 0, 0], [-1, 0, 0]] },
  ];
  for (const key of cellVerts.keys()) {
    const z = key % nz;
    const y = ((key - z) / nz) % ny;
    const x = (key - z - y * nz) / (nz * ny);
    const v0 = corner(x, y, z);
    for (const { d, quad } of AXES) {
      const v1 = corner(x + d[0], y + d[1], z + d[2]);
      if ((v0 < 0) === (v1 < 0)) continue;
      const q = [];
      let ok = true;
      for (const [ox, oy, oz] of quad) {
        const vi = cellVerts.get(packCell(x + ox, y + oy, z + oz));
        if (vi === undefined) { ok = false; break; }
        q.push(vi);
      }
      if (!ok) continue;
      if (v0 < 0) indices.push(q[0], q[1], q[2], q[0], q[2], q[3]);
      else indices.push(q[0], q[2], q[1], q[0], q[3], q[2]);
    }
  }

  relaxSurfaceNets(positions, normals, indices, cell);

  const clean = dropSpecks(positions, normals, indices);

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(clean.positions, 3));
  geo.setAttribute('normal', new BufferAttribute(clean.normals, 3));
  geo.setIndex(clean.positions.length / 3 > 65535
    ? new BufferAttribute(Uint32Array.from(clean.indices), 1)
    : new BufferAttribute(Uint16Array.from(clean.indices), 1));
  geo.computeBoundingSphere();
  geo.userData.vineFieldStats = { cells: cellVerts.size, truncated };
  return geo;
}

/**
 * The classic surface-nets relaxation this extractor was missing: raw
 * edge-crossing vertices alias into saw teeth wherever the shell is thin or
 * tightly curved. Pull each vertex toward its neighbor average (positions,
 * then normals), clamped near its own cell so topology and genuine creases
 * survive. Operates in-place on the flat arrays.
 */
function relaxSurfaceNets(positions, normals, indices, cell) {
  const count = positions.length / 3;
  if (count === 0 || indices.length === 0) return;

  // CSR adjacency from triangle corners (repeats just reweight the average
  // identically across the symmetric quad pattern — no dedupe needed).
  const degree = new Uint32Array(count);
  for (let t = 0; t < indices.length; t += 3) {
    degree[indices[t]] += 2;
    degree[indices[t + 1]] += 2;
    degree[indices[t + 2]] += 2;
  }
  const offsets = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i] + degree[i];
  const nbr = new Uint32Array(offsets[count]);
  const cursor = Uint32Array.from(offsets.subarray(0, count));
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    nbr[cursor[a]++] = b; nbr[cursor[a]++] = c;
    nbr[cursor[b]++] = a; nbr[cursor[b]++] = c;
    nbr[cursor[c]++] = a; nbr[cursor[c]++] = b;
  }

  const home = Float64Array.from(positions); // anchor for the cell clamp
  const prev = new Float64Array(count * 3);
  const maxOff = cell * 0.75; // stay near the vertex's own cell
  const W = 0.5;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < count * 3; i++) prev[i] = positions[i];
    for (let i = 0; i < count; i++) {
      const lo = offsets[i], hi = offsets[i + 1];
      if (hi === lo) continue;
      let sx = 0, sy = 0, sz = 0;
      for (let k = lo; k < hi; k++) {
        const j = nbr[k] * 3;
        sx += prev[j]; sy += prev[j + 1]; sz += prev[j + 2];
      }
      const inv = W / (hi - lo);
      const i3 = i * 3;
      const tx = prev[i3] * (1 - W) + sx * inv;
      const ty = prev[i3 + 1] * (1 - W) + sy * inv;
      const tz = prev[i3 + 2] * (1 - W) + sz * inv;
      positions[i3] = clampAround(tx, home[i3], maxOff);
      positions[i3 + 1] = clampAround(ty, home[i3 + 1], maxOff);
      positions[i3 + 2] = clampAround(tz, home[i3 + 2], maxOff);
    }
  }

  // Normal smoothing over the same adjacency kills the sparkle on cells whose
  // trilinear gradient straddled a crease.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < count * 3; i++) prev[i] = normals[i];
    for (let i = 0; i < count; i++) {
      const lo = offsets[i], hi = offsets[i + 1];
      if (hi === lo) continue;
      const i3 = i * 3;
      let nx = prev[i3] * 2, ny = prev[i3 + 1] * 2, nz = prev[i3 + 2] * 2;
      for (let k = lo; k < hi; k++) {
        const j = nbr[k] * 3;
        nx += prev[j]; ny += prev[j + 1]; nz += prev[j + 2];
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      normals[i3] = nx / l;
      normals[i3 + 1] = ny / l;
      normals[i3 + 2] = nz / l;
    }
  }
}

function clampAround(v, center, r) {
  const lo = center - r;
  const hi = center + r;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Pinched tips can shed sub-cell debris — isolated specks of a few vertices.
 * Drop connected components that are dust next to the largest body; genuinely
 * small-but-real pieces (a short deliberate stroke) survive the relative test.
 */
function dropSpecks(positions, normals, indices) {
  const count = positions.length / 3;
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(indices[t]);
    parent[find(indices[t + 1])] = a;
    parent[find(indices[t + 2])] = a;
  }
  const sizes = new Map();
  let largest = 0;
  for (let i = 0; i < count; i++) {
    const r = find(i);
    const s = (sizes.get(r) ?? 0) + 1;
    sizes.set(r, s);
    if (s > largest) largest = s;
  }
  const cutoff = Math.min(30, largest * 0.1);
  let dropsAny = false;
  for (const size of sizes.values()) {
    if (size < cutoff) { dropsAny = true; break; }
  }
  if (!dropsAny) {
    return {
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      indices,
    };
  }
  const keepVert = (i) => sizes.get(find(i)) >= cutoff;

  const remap = new Int32Array(count).fill(-1);
  const outPos = [];
  const outNrm = [];
  for (let i = 0; i < count; i++) {
    if (!keepVert(i)) continue;
    remap[i] = outPos.length / 3;
    outPos.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    outNrm.push(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
  }
  const outIdx = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a < 0 || b < 0 || c < 0) continue;
    outIdx.push(a, b, c);
  }
  return {
    positions: Float32Array.from(outPos),
    normals: Float32Array.from(outNrm),
    indices: outIdx,
  };
}

/* ============================================================== path bits */

/**
 * Resample the {p, n, radiusScale?} polyline to uniform arc steps. Normals and
 * local radius are lerped; normals are renormalized. A closed path omits the
 * duplicate seam station so frames and section profiles stay periodic.
 */
function resampleSamples(samples, step, maxPoints, closed = false) {
  if (!samples || samples.length < 2) return null;
  let pts = samples;
  if (closed && samplesFormClosedLoop(pts)) pts = pts.slice(0, -1);
  if (pts.length < (closed ? 3 : 2)) return null;

  const edgeCount = closed ? pts.length : pts.length - 1;
  const cum = [0];
  for (let i = 0; i < edgeCount; i++) {
    const next = (i + 1) % pts.length;
    cum.push(cum[i] + dist3(pts[i].p, pts[next].p));
  }
  const total = cum[cum.length - 1];
  if (total < step * 2) return null;

  const count = Math.min(maxPoints, Math.max(8, Math.round(total / step) + (closed ? 0 : 1)));
  const out = [];
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const s = closed ? (total * i) / count : (total * i) / (count - 1);
    while (seg < edgeCount - 1 && cum[seg + 1] < s) seg++;
    const span = cum[seg + 1] - cum[seg];
    const t = span > 0 ? (s - cum[seg]) / span : 0;
    const a = pts[seg], b = pts[(seg + 1) % pts.length];
    const n = [
      a.n[0] + (b.n[0] - a.n[0]) * t,
      a.n[1] + (b.n[1] - a.n[1]) * t,
      a.n[2] + (b.n[2] - a.n[2]) * t,
    ];
    normalize3(n);
    out.push({
      p: [
        a.p[0] + (b.p[0] - a.p[0]) * t,
        a.p[1] + (b.p[1] - a.p[1]) * t,
        a.p[2] + (b.p[2] - a.p[2]) * t,
      ],
      n,
      radiusScale: sampleRadiusScale(a) + (sampleRadiusScale(b) - sampleRadiusScale(a)) * t,
      s,
    });
  }
  return { path: out, total };
}

function samplesFormClosedLoop(samples) {
  if (!samples || samples.length < 3) return false;
  return dist3(samples[0].p, samples[samples.length - 1].p) <= 1e-6;
}

function sampleRadiusScale(sample) {
  const explicit = Number(sample?.radiusScale);
  if (Number.isFinite(explicit)) return Math.max(0, explicit);
  const packed = Number(sample?.p?.[3]);
  return Number.isFinite(packed) ? Math.max(0, packed) : 1;
}

/**
 * Orthonormal frame per point, guided by the surface normal instead of
 * parallel transport: T from central differences, N = surface normal made
 * perpendicular to T, B = T × N. Guiding by the normal keeps the band's "up"
 * glued to the skin and cannot flip on inflection points.
 */
function surfaceFrames(path, closed = false) {
  const frames = [];
  let prevN = null;
  for (let i = 0; i < path.length; i++) {
    const a = path[closed ? (i - 1 + path.length) % path.length : Math.max(0, i - 1)].p;
    const b = path[closed ? (i + 1) % path.length : Math.min(path.length - 1, i + 1)].p;
    const t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    normalize3(t);
    const n = [...path[i].n];
    const dot = n[0] * t[0] + n[1] * t[1] + n[2] * t[2];
    n[0] -= dot * t[0]; n[1] -= dot * t[1]; n[2] -= dot * t[2];
    if (!normalize3(n)) {
      // stroke momentarily runs along its own normal — carry the last frame
      n[0] = prevN?.[0] ?? 1; n[1] = prevN?.[1] ?? 0; n[2] = prevN?.[2] ?? 0;
    }
    prevN = n;
    frames.push({ t, n, b: cross3(t, n) });
  }
  return frames;
}

/* --------------------------------------------------------------- builder */

function createBuilder() {
  const positions = [];
  const indices = [];
  return {
    vertex(x, y, z) {
      positions.push(x, y, z);
      return positions.length / 3 - 1;
    },
    /** Circle of `segs` vertices around `center` in the (u, v) plane. */
    ring(center, u, v, r, segs) {
      const ids = [];
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        const cu = Math.cos(a) * r, cv = Math.sin(a) * r;
        ids.push(this.vertex(
          center[0] + u[0] * cu + v[0] * cv,
          center[1] + u[1] * cu + v[1] * cv,
          center[2] + u[2] * cu + v[2] * cv,
        ));
      }
      return ids;
    },
    /** Sigil section outline: ℓ along `bv` scaled by w, h along `n` by pk.
     *  `conform` (fraction of pk) pulls the whole ring into the mesh along −n. */
    profileRing(center, n, bv, w, pk, outline, conform = 0) {
      const ids = [];
      const bias = -conform * pk;
      for (const [l, h] of outline) {
        ids.push(this.vertex(
          center[0] + bv[0] * l * w + n[0] * (h * pk + bias),
          center[1] + bv[1] * l * w + n[1] * (h * pk + bias),
          center[2] + bv[2] * l * w + n[2] * (h * pk + bias),
        ));
      }
      return ids;
    },
    /** Quad-strip two same-length rings together. */
    stitch(a, b) {
      const n = a.length;
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        indices.push(a[k], b[k], b[k1], a[k], b[k1], a[k1]);
      }
    },
    /** Close a ring with a tip vertex. `flip` for the stroke-start cap. */
    fan(tip, ring, flip) {
      const n = ring.length;
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        if (flip) indices.push(tip, ring[k1], ring[k]);
        else indices.push(tip, ring[k], ring[k1]);
      }
    },
    finish() {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
      geo.setIndex(positions.length / 3 > 65535
        ? new BufferAttribute(Uint32Array.from(indices), 1)
        : new BufferAttribute(Uint16Array.from(indices), 1));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      return geo;
    },
  };
}

/* ----------------------------------------------------------------- maths */

/** Feature size the ornament (taper, thorns, weld, wobble) scales with. */
function ornamentScale(radius, peak) {
  return Math.max(radius, peak * 0.75);
}

/** One corner-cutting pass over a closed 2D outline. */
function chaikin(outline) {
  const out = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    out.push(
      [a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25],
      [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75],
    );
  }
  return out;
}

function nearestIndex(path, s, total = path[path.length - 1].s, closed = false) {
  // uniform arc resample → direct lookup
  const t = total > 0 ? s / total : 0;
  if (closed) return Math.round(t * path.length) % path.length;
  return Math.min(path.length - 1, Math.max(0, Math.round(t * (path.length - 1))));
}

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l < 1e-9) return false;
  v[0] /= l; v[1] /= l; v[2] /= l;
  return true;
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function orthogonal(v) {
  const o = Math.abs(v[0]) < 0.7 ? [1, 0, 0] : [0, 1, 0];
  const c = cross3(v, o);
  normalize3(c);
  return c;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
