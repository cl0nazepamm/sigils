import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  uniform, uniformArray, Fn, Loop, If, varying,
  float, int, vec2, vec3, vec4,
  cos, sin, clamp, mix, min, smoothstep, length, dot, select, sqrt, sign,
  positionGeometry, transformNormalToView, positionViewDirection,
} from 'three/tsl';

import { resampleByLength } from '../src/index.js';

// ============================================================================
// Realtime, fully GPU sigil.
//
// The sigil is never meshed on the CPU. The strokes you draw become a list of
// line segments uploaded to a uniform buffer; a single TSL material evaluates
// the whole emblem as a signed-distance field every frame:
//
//   strokes ─▶ segment buffer (uploaded on change)
//          ─▶ kaleidoscope fold by `symmetry`  (free radial copies)
//          ─▶ smooth-union (smin) of segment distances  (the melt)
//          ─▶ dome height = profile(half-width − distance)
//          ─▶ analytic normal from the height gradient   → chrome reflection
//          ─▶ per-pixel discard outside the stroke        → crisp silhouette
//
// Drawing, symmetry, width, melt, peak and roughness are all live uniforms —
// nothing rebuilds.
// ============================================================================

const MAX_SEGS = 512;        // uniform-buffer capacity for base (pre-symmetry) segments
const RESAMPLE = 0.02;       // world-space spacing of captured segments (denser = smoother joints)
const PLANE_SIZE = 3.6;      // plane covers [-1.8, 1.8] in the draw domain
const PLANE_DIV = 320;       // plane tessellation
const CELL = PLANE_SIZE / PLANE_DIV;
// Lipschitz slack: the field is a distance (gradient <= 1), so within one triangle
// the true field differs from the interpolated vertex field by at most the longest
// edge (cell * sqrt2). Pixels beyond this slack from the threshold are decided by
// the cheap interpolated value; only the boundary band pays for the per-pixel field.
const SLACK = CELL * 1.6;

// ---------------------------------------------------------------- renderer ---
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.domElement.id = 'stage';
document.body.appendChild(renderer.domElement);
await renderer.init();

// ------------------------------------------------------------------- scene ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0b0d);

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100);
camera.up.set(0, 1, 0);
camera.position.set(0, -0.85, 3.7);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// ============================================================ SDF material ===
// Live uniforms — every one of these drives the shader with zero rebuild.
const uSegCount = uniform(0, 'int');
const uSym = uniform(6, 'int');         // PRESET: 6 radial copies
const uMirror = uniform(1);             // PRESET: dihedral on -> pointed tips
const uThickness = uniform(0.07);       // PRESET: thin wiry linework
const uMelt = uniform(0.0);             // PRESET (now 'Fuse'): 0 = hard min -> crisp, no joint scallop
const uPeak = uniform(0.13);            // PRESET: modest dome so the ridge reads
const uRough = uniform(0.05);           // PRESET: crisp near-mirror chrome

// --- needle taper (per-endpoint rounded-cone radius); all live, zero rebuild ---
const uTaperLen = uniform(0.35);        // world arc-length over which a terminal grows to full width
const uTaperExp = uniform(1.8);         // taper sharpness: >1 = long thin needle, 1 = linear cone
const uTipRadius = uniform(0.004);      // floor radius at the very tip (0 = perfect point)

// --- knife-edge ridge profile (HEIGHT only, never the cutout field) ---
const uRidge = uniform(2.6);            // flank exponent -> apex sharpness (1 = linear tent)
const uBevel = uniform(0.0);            // 0 = single knife crest; >0 carves a central groove

// --- cold-chrome presentation (shading only; field untouched) ---
const uRimStrength = uniform(0.7);                       // emissive fresnel rim intensity
const uRimPower = uniform(3.2);                          // rim sharpness (higher = thinner edge)
const uRimColor = uniform(new THREE.Color(0x7fd4ff));   // cool cyan-white contour glow
const uChromeTint = uniform(new THREE.Color(0xc2d2e8)); // cool steel reflection cast

// The base-segment buffer: MAX_SEGS vec4s (ax, ay, bx, by). Mutated in place as
// you draw; uniformArray re-uploads it each render, and the loop reads only the
// first `uSegCount` entries.
const segData = Array.from({ length: MAX_SEGS }, () => new THREE.Vector4(0, 0, 0, 0));
const segBuffer = uniformArray(segData, 'vec4');

// Parallel per-segment buffer (fixed MAX_SEGS capacity, written in syncSegments):
//   x = arc-distance from endpoint a to the nearest OPEN stroke terminal
//   y = arc-distance from endpoint b to the nearest OPEN stroke terminal
// 1e3 = interior / closed-loop point (full radius, no taper). Drives the needle taper.
const radData = Array.from({ length: MAX_SEGS }, () => new THREE.Vector2(1e3, 1e3));
const radBuffer = uniformArray(radData, 'vec2');

const TAU = Math.PI * 2;

// rotate a 2D point by `a` radians
const rot2 = Fn(([p, a]) => {
  const c = cos(a);
  const s = sin(a);
  return vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)));
});

// Signed distance from p to a tapered capsule = iq's exact 2D rounded cone:
// the convex hull of a disk of radius r1 at a and r2 at b. Returns a TRUE signed
// Euclidean distance (radius baked in): negative inside, 0 on the surface,
// 1-Lipschitz whenever a2 = l2-(r1-r2)^2 >= 0 (guaranteed by the radius clamp in field()).
const roundedCone = Fn(([p, a, b, r1, r2]) => {
  const ba = b.sub(a);
  const l2 = dot(ba, ba).max(1e-7);
  const rr = r1.sub(r2);
  const a2 = l2.sub(rr.mul(rr));
  const il2 = float(1.0).div(l2);

  const pa = p.sub(a);
  const y = dot(pa, ba);
  const z = y.sub(l2);
  const xv = pa.mul(l2).sub(ba.mul(y));   // perpendicular component (scaled by l2)
  const x2 = dot(xv, xv);
  const y2 = y.mul(y).mul(l2);
  const z2 = z.mul(z).mul(l2);

  const k = sign(rr).mul(rr).mul(rr).mul(x2);
  const dCapB = sqrt(x2.add(z2)).mul(il2).sub(r2);                                 // sphere at b
  const dCapA = sqrt(x2.add(y2)).mul(il2).sub(r1);                                 // sphere at a
  // .max(0.0) guards the always-evaluated select branch (a2 could be < 0 before the clamp).
  const dBody = sqrt(x2.mul(a2).mul(il2).max(0.0)).add(y.mul(rr)).mul(il2).sub(r1); // cone flank

  const condB = sign(z).mul(a2).mul(z2).greaterThan(k);
  const condA = k.greaterThan(sign(y).mul(a2).mul(y2));  // == (sign(y)*a2*y2 < k), only .greaterThan used
  return select(condB, dCapB, select(condA, dCapA, dBody));
});

// polynomial smooth-min: blends two distances over radius k (the "melt")
const smin = Fn(([a, b, k]) => {
  const kk = k.max(1e-5);
  const h = clamp(float(0.5).add(b.sub(a).mul(0.5).div(kk)), 0.0, 1.0);
  return mix(b, a, h).sub(kk.mul(h).mul(h.oneMinus()));
});

// Distance to the whole symmetric emblem. Instead of storing rotated copies, we
// rotate the *query point* into each of `uSym` sectors and smooth-union the
// distance to the base strokes — so changing symmetry costs nothing on the CPU.
const field = Fn(([pIn]) => {
  const sector = float(TAU).div(float(uSym));
  const half = uThickness.mul(0.5);
  // CROSS-SECTOR accumulator: symmetry copies combine with a HARD min so they meet
  // at angular cusps (pointed star tips) and the center stays a sharp star.
  const d = float(1e9).toVar();

  Loop({ start: int(0), end: uSym, type: 'int', condition: '<', name: 'k' }, ({ k }) => {
    const q = rot2(pIn, sector.mul(float(k)).negate()).toVar();
    const qm = vec2(q.x, q.y.negate()); // query reflected across the sector axis

    // WITHIN one sector: smin is the OPTIONAL LOCAL FUSE. With uMelt small the
    // poly-smin correction collapses to 0 for distant strokes (auto hard-min).
    const dSec = float(1e9).toVar();
    Loop({ start: int(0), end: uSegCount, type: 'int', condition: '<', name: 's' }, ({ s }) => {
      const seg = segBuffer.element(s);
      const a = seg.xy;
      const b = seg.zw;
      // per-endpoint needle taper from the baked arc-distance to the nearest open
      // terminal: ramp over uTaperLen, sharpen by uTaperExp, scale by half-width,
      // floor at uTipRadius. pow/clamp touch only the radius CONSTANTS, not the metric.
      const rd = radBuffer.element(s);
      const t1 = clamp(rd.x.div(uTaperLen.max(1e-4)), 0.0, 1.0).pow(uTaperExp);
      const t2 = clamp(rd.y.div(uTaperLen.max(1e-4)), 0.0, 1.0).pow(uTaperExp);
      const r1 = half.mul(t1).max(uTipRadius);
      const r2 = half.mul(t2).max(uTipRadius);
      // LIPSCHITZ GUARD: pin |r1-r2| <= segLen (preserving the mean) so iq's rounded
      // cone stays an exact 1-Lipschitz SDF (a2 = l2-(r1-r2)^2 >= 0). Keeps SLACK valid.
      const segLen = length(b.sub(a)).max(1e-6);
      const rmid = r1.add(r2).mul(0.5);
      const rdif = clamp(r1.sub(r2), segLen.negate(), segLen);
      const r1c = rmid.add(rdif.mul(0.5));
      const r2c = rmid.sub(rdif.mul(0.5));
      // mirror on -> hard-min the reflected query for a crisp dihedral crease.
      const dPlain = roundedCone(q, a, b, r1c, r2c);
      const dUse = mix(dPlain, min(dPlain, roundedCone(qm, a, b, r1c, r2c)), uMirror);
      dSec.assign(smin(dSec, dUse, uMelt));
    });

    // KEEP-SHARP DEFAULT: sector copies cross with a hard min -> angular cusps.
    d.assign(min(d, dSec));
  });

  return d;
});

// Knife-edge ridge height at p (beveled-blade cross-section). field is now SIGNED
// (0 at the edge, -localRadius at the centerline), so depth is -field. Tapered tips
// have a smaller local radius, so -field never reaches half there -> the ridge thins
// to a sharp point at each needle. A high flank exponent (uRidge) keeps a flat skirt
// then a steep climb to a crisp apex crease (thin specular line, not a pillow);
// uBevel subtracts a narrow t^24 notch -> twin-ridge 'fuller'. HEIGHT only; field() untouched.
const BEVEL_EXP = float(24.0);
const heightAt = Fn(([p]) => {
  const half = uThickness.mul(0.5);
  const t = clamp(field(p).negate().div(half.max(1e-4)), 0.0, 1.0);
  const blade = t.pow(uRidge.max(0.25));        // flat skirt -> steep flanks -> sharp apex
  const groove = t.pow(BEVEL_EXP).mul(uBevel);  // narrow central notch (0 = single knife)
  return uPeak.mul(blade.sub(groove).max(0.0));
});

// height + analytic surface normal, packed as vec4(height, nx, ny, nz)
const surface = Fn(([p]) => {
  const e = float(0.035); // gradient step spans ~2 segments → averages out per-vertex normal kinks
  const h0 = heightAt(p);
  const hx = heightAt(vec2(p.x.add(e), p.y));
  const hy = heightAt(vec2(p.x, p.y.add(e)));
  const n = vec3(h0.sub(hx).div(e), h0.sub(hy).div(e), 1.0).normalize();
  return vec4(h0, n);
});

const material = new THREE.MeshStandardNodeMaterial();
const domain = positionGeometry.xy; // plane sits in XY at the origin → domain == world XY

// Evaluate the surface (height + analytic normal) once per vertex and interpolate.
// positionNode displaces the plane by the height; normalNode reflects chrome off
// the SDF-gradient normal. Sharing one varying avoids recomputing the field.
const surf = varying(surface(domain));
// Chrome relief reads from the NORMAL (surf.yzw), which is independent of how far
// we actually push the geometry. Displacing only a little keeps the silhouette the
// clean per-pixel cutout at all angles (no faceted dome rim at grazing) while the
// full-strength normal still gives crisp ridge reflections — a flat graphic sigil.
const uReliefZ = uniform(0.35);  // 0 = flat (cutout-crisp), 1 = full physical dome
material.positionNode = positionGeometry.add(vec3(0, 0, surf.x.mul(uReliefZ)));

// view-space normal shared by chrome shading and the emissive rim
const viewNormal = transformNormalToView(surf.yzw.normalize());
material.normalNode = viewNormal;

// Emissive Fresnel rim: a thin bright contour tracing every silhouette and grazing
// fold -> the glowing knife-line of cybersigilism. abs(dot) keeps it edge-only on
// BOTH faces of the DoubleSide plane (no back-face inversion). Pure shading; the
// field()/cutout/pre-reject are byte-for-byte unchanged so the Lipschitz bound holds.
const rim = clamp(float(1.0).sub(dot(viewNormal.normalize(), positionViewDirection).abs()), 0.0, 1.0).pow(uRimPower);
material.emissiveNode = uRimColor.mul(rim).mul(uRimStrength);

// fragment: keep only what's inside the stroke → a crisp silhouette that doesn't
// depend on mesh resolution, via an alpha cutout (opacity 0/1 + alphaTest; a bare
// .discard() gets tree-shaken when its result is unused).
//
// The per-pixel field loop is the dominant cost, so we pre-reject with the
// interpolated vertex field: a fragment that's confidently inside/outside (beyond
// the Lipschitz slack) skips the loop. A real If() branch is required — select()
// would still evaluate the expensive path.
const vField = varying(field(domain)); // field sampled per vertex, interpolated
material.opacityNode = Fn(() => {
  const thr = float(0.0);   // radius is baked into the distance -> inside is field <= 0
  const slack = float(SLACK);
  const op = float(0.0).toVar();
  If(thr.sub(vField).greaterThan(slack), () => {
    op.assign(1.0);                                  // confidently inside
  }).ElseIf(vField.sub(thr).greaterThan(slack), () => {
    op.assign(0.0);                                  // confidently outside
  }).Else(() => {
    op.assign(select(field(domain).lessThanEqual(thr), float(1.0), float(0.0)));
  });
  return op;
})();
material.alphaTest = 0.5; // opaque alpha cutout → crisp edge + correct depth

material.metalness = 1.0;
material.roughnessNode = uRough;
material.colorNode = uChromeTint;      // cool steel cast on the metallic reflections (tints F0)
material.envMapIntensity = 1.6;
material.side = THREE.DoubleSide;

// The plane: dense enough that the displaced dome reads smoothly. The silhouette
// crispness comes from the per-pixel discard, not from this tessellation.
const plane = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE, PLANE_DIV, PLANE_DIV), material);
scene.add(plane);

// ---------------------------------------------------------------- draw io ----
const raycaster = new THREE.Raycaster();
const drawPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const ndc = new THREE.Vector2();
const hit = new THREE.Vector3();

function planePoint(event) {
  ndc.x = (event.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  if (!raycaster.ray.intersectPlane(drawPlane, hit)) return null;
  return [hit.x, hit.y];
}

const strokes = [];   // completed strokes
let current = [];     // active stroke
let drawing = false;
let activePointer = null;
let segCount = 0;     // active base-segment count (for the readout)
const MIN_STEP = 0.012;

// Rebuild the GPU segment buffer from the current strokes. This is the only
// CPU-side cost of a change, and it's just writing floats — no meshing.
function syncSegments() {
  const all = current.length >= 2 ? [...strokes, current] : strokes;
  let n = 0;
  for (const stroke of all) {
    if (stroke.length < 2) continue;
    const rs = resampleByLength(stroke, RESAMPLE);
    if (rs.length < 2) continue;
    // cumulative arc length along the resampled polyline
    const cum = [0];
    for (let i = 1; i < rs.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(rs[i][0] - rs[i - 1][0], rs[i][1] - rs[i - 1][1]));
    }
    const total = cum[cum.length - 1];
    // closed loop -> endpoints meet, keep full radius (no terminal taper)
    const closed = Math.hypot(rs[0][0] - rs[rs.length - 1][0], rs[0][1] - rs[rs.length - 1][1]) <= RESAMPLE * 1.5;
    const termDist = (i) => (closed ? 1e3 : Math.min(cum[i], total - cum[i]));
    for (let i = 0; i + 1 < rs.length && n < MAX_SEGS; i++) {
      segData[n].set(rs[i][0], rs[i][1], rs[i + 1][0], rs[i + 1][1]);
      radData[n].set(termDist(i), termDist(i + 1));
      n++;
    }
    if (n >= MAX_SEGS) break;
  }
  uSegCount.value = n;
  segCount = n;
  refreshGuides();
}

function pushPoint(p) {
  if (!p) return;
  const last = current[current.length - 1];
  if (last) {
    const dx = p[0] - last[0];
    const dy = p[1] - last[1];
    if (dx * dx + dy * dy < MIN_STEP * MIN_STEP) return;
  }
  current.push(p);
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  drawing = true;
  activePointer = event.pointerId;
  renderer.domElement.setPointerCapture(event.pointerId);
  current = [];
  pushPoint(planePoint(event));
});

renderer.domElement.addEventListener('pointermove', (event) => {
  if (!drawing || event.pointerId !== activePointer) return;
  pushPoint(planePoint(event));
  syncSegments(); // live: the chrome grows as you move
});

function finishStroke() {
  if (!drawing) return;
  drawing = false;
  activePointer = null;
  if (current.length >= 2) strokes.push(current);
  current = [];
  syncSegments();
}

renderer.domElement.addEventListener('pointerup', finishStroke);
renderer.domElement.addEventListener('pointercancel', finishStroke);

// --------------------------------------------------------------- guide art ---
const guideGroup = new THREE.Group();
scene.add(guideGroup);
const guideMat = new THREE.LineBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0.6, depthTest: false });

function refreshGuides() {
  guideGroup.clear();
  guideGroup.visible = ui.guides.checked;
  if (!guideGroup.visible) return;
  const all = current.length >= 2 ? [...strokes, current] : strokes;
  for (const stroke of all) {
    if (stroke.length < 2) continue;
    const pts = stroke.map(([x, y]) => new THREE.Vector3(x, y, 0.012));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), guideMat);
    line.renderOrder = 2;
    guideGroup.add(line);
  }
}

// ----------------------------------------------------------------- panel -----
const ui = {
  symmetry: document.getElementById('symmetry'),
  mirror: document.getElementById('mirror'),
  thickness: document.getElementById('thickness'),
  melt: document.getElementById('melt'),
  peak: document.getElementById('peak'),
  roughness: document.getElementById('roughness'),
  taperLen: document.getElementById('taperLen'),
  taperExp: document.getElementById('taperExp'),
  tipRadius: document.getElementById('tipRadius'),
  ridge: document.getElementById('ridge'),
  bevel: document.getElementById('bevel'),
  rim: document.getElementById('rim'),
  rimpow: document.getElementById('rimpow'),
  guides: document.getElementById('guides'),
  undo: document.getElementById('undo'),
  clear: document.getElementById('clear'),
};

function bindSlider(el, apply) {
  const out = document.getElementById(`${el.id}-out`);
  const decimals = String(el.step).split('.')[1]?.length || 0;
  el.addEventListener('input', () => {
    const v = Number(el.value);
    if (out) out.textContent = v.toFixed(decimals);
    apply(v);
  });
}

bindSlider(ui.symmetry, (v) => { uSym.value = v | 0; });
bindSlider(ui.thickness, (v) => { uThickness.value = v; });
bindSlider(ui.melt, (v) => { uMelt.value = v; });
bindSlider(ui.peak, (v) => { uPeak.value = v; });
bindSlider(ui.roughness, (v) => { uRough.value = v; });
bindSlider(ui.taperLen, (v) => { uTaperLen.value = v; });
bindSlider(ui.taperExp, (v) => { uTaperExp.value = v; });
bindSlider(ui.tipRadius, (v) => { uTipRadius.value = v; });
bindSlider(ui.ridge, (v) => { uRidge.value = v; });
bindSlider(ui.bevel, (v) => { uBevel.value = v; });
bindSlider(ui.rim, (v) => { uRimStrength.value = v; });
bindSlider(ui.rimpow, (v) => { uRimPower.value = v; });
ui.mirror.addEventListener('change', () => { uMirror.value = ui.mirror.checked ? 1 : 0; });
ui.guides.addEventListener('change', refreshGuides);

ui.undo.addEventListener('click', () => { if (drawing) finishStroke(); strokes.pop(); syncSegments(); });
ui.clear.addEventListener('click', () => { if (drawing) finishStroke(); strokes.length = 0; current = []; syncSegments(); });

// ------------------------------------------------------------- seed glyph ----
(function seed() {
  const arc = [];
  for (let i = 0; i <= 22; i++) {
    const t = i / 22;
    const a = -Math.PI * 0.62 + t * Math.PI * 1.24;
    arc.push([Math.cos(a) * 0.7, Math.sin(a) * 0.7 - 0.08]);
  }
  strokes.push(arc);
  syncSegments();
})();

// ------------------------------------------------------------------ loop -----
const statsEl = document.getElementById('stats');
let frames = 0;
let fpsClock = 0;
let lastT = performance.now();

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);

  const now = performance.now();
  fpsClock += now - lastT;
  lastT = now;
  frames++;
  if (fpsClock >= 500) {
    const fps = Math.round((frames * 1000) / fpsClock);
    statsEl.textContent = `${fps} fps · ${segCount} segs · symmetry ${uSym.value}${uMirror.value ? ' +mirror' : ''}`;
    frames = 0;
    fpsClock = 0;
  }
});
