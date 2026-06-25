import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { resampleByLength } from '../src/index.js';

// ============================================================================
// Realtime sparse sigil curves.
//
// This renderer is intentionally not a dense full-plane SDF. Strokes are
// resampled into curve-native blade geometry, then mirrored/symmetrized as real
// triangles. Empty space has no vertices, no fragment loop, and no per-pixel
// segment search. That is the shape needed for Max spline/room-scale reuse.
// ============================================================================

const RESAMPLE = 0.03;
const SIMPLIFY_TOL = 0.006;
const MIN_STEP = 0.012;
const TAU = Math.PI * 2;
const CROSS = [-1, -0.78, -0.52, -0.28, 0, 0.28, 0.52, 0.78, 1];

const state = {
  symmetry: 6,
  mirror: true,
  thickness: 0.07,
  spread: 0,
  peak: 0.13,
  roughness: 0.05,
  taperLen: 0.35,
  taperExp: 1.8,
  tipRadius: 0.004,
  ridge: 2.6,
  bevel: 0,
  rim: 0.7,
  rimPower: 3.2,
};

// ---------------------------------------------------------------- renderer ---
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
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
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: null };

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const keyLight = new THREE.DirectionalLight(0xbfdcff, 0.9);
keyLight.position.set(-2.4, -2.8, 4.6);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xfff1d2, 0.22);
fillLight.position.set(3.2, 2.0, 2.5);
scene.add(fillLight);

// --------------------------------------------------------------- material ----
const chromeTint = new THREE.Color(0xc2d2e8);
const rimColor = new THREE.Color(0x7fd4ff);
const sigilMaterial = new THREE.MeshStandardMaterial({
  color: chromeTint,
  metalness: 1,
  roughness: state.roughness,
  emissive: rimColor,
  emissiveIntensity: state.rim * 0.08,
  envMapIntensity: 1.85,
  side: THREE.DoubleSide,
  forceSinglePass: true,
});

const sigilMesh = new THREE.Mesh(new THREE.BufferGeometry(), sigilMaterial);
sigilMesh.frustumCulled = false;
scene.add(sigilMesh);

// ---------------------------------------------------------------- draw io ----
const raycaster = new THREE.Raycaster();
const drawPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const ndc = new THREE.Vector2();
const hit = new THREE.Vector3();
const orbitOffset = new THREE.Vector3();
const orbitSpherical = new THREE.Spherical();
let orbiting = false;
let orbitPointer = null;
let orbitX = 0;
let orbitY = 0;

function planePoint(event) {
  ndc.x = (event.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  if (!raycaster.ray.intersectPlane(drawPlane, hit)) return null;
  return [hit.x, hit.y];
}

function rotateView(dx, dy) {
  const rotateSpeed = 0.006;
  orbitOffset.copy(camera.position).sub(controls.target);
  orbitSpherical.setFromVector3(orbitOffset);
  orbitSpherical.theta -= dx * rotateSpeed;
  orbitSpherical.phi -= dy * rotateSpeed;
  orbitSpherical.makeSafe();
  orbitOffset.setFromSpherical(orbitSpherical);
  camera.position.copy(controls.target).add(orbitOffset);
  camera.lookAt(controls.target);
  controls.update();
}

function beginOrbit(event) {
  if (event.button !== 2) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  orbiting = true;
  orbitPointer = event.pointerId;
  orbitX = event.clientX;
  orbitY = event.clientY;
  renderer.domElement.setPointerCapture(event.pointerId);
  renderer.domElement.style.cursor = 'grabbing';
}

function moveOrbit(event) {
  if (!orbiting || event.pointerId !== orbitPointer) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const dx = event.clientX - orbitX;
  const dy = event.clientY - orbitY;
  orbitX = event.clientX;
  orbitY = event.clientY;
  rotateView(dx, dy);
}

function endOrbit(event) {
  if (!orbiting || event.pointerId !== orbitPointer) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  renderer.domElement.releasePointerCapture(event.pointerId);
  renderer.domElement.style.cursor = 'crosshair';
  orbiting = false;
  orbitPointer = null;
}

renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
renderer.domElement.addEventListener('pointerdown', beginOrbit, { capture: true });
renderer.domElement.addEventListener('pointermove', moveOrbit, { capture: true });
renderer.domElement.addEventListener('pointerup', endOrbit, { capture: true });
renderer.domElement.addEventListener('pointercancel', endOrbit, { capture: true });

// ------------------------------------------------------------ curve build ----
const strokes = [];
let current = [];
let drawing = false;
let activePointer = null;
let baseSegCount = 0;
let drawnSegCount = 0;
let vertexCount = 0;

function distanceToLineSq(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const lenSq = abx * abx + aby * aby;
  if (lenSq <= 1e-12) return apx * apx + apy * apy;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / lenSq));
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  return dx * dx + dy * dy;
}

function simplifyPolyline(points, tolerance) {
  if (points.length <= 2 || tolerance <= 0) return points;

  const keep = new Uint8Array(points.length);
  const stack = [0, points.length - 1];
  const tolSq = tolerance * tolerance;
  keep[0] = 1;
  keep[points.length - 1] = 1;

  while (stack.length) {
    const end = stack.pop();
    const start = stack.pop();
    let maxDist = -1;
    let split = -1;

    for (let i = start + 1; i < end; i++) {
      const dist = distanceToLineSq(points[i], points[start], points[end]);
      if (dist > maxDist) {
        maxDist = dist;
        split = i;
      }
    }

    if (maxDist > tolSq && split > start) {
      keep[split] = 1;
      stack.push(start, split, split, end);
    }
  }

  const simplified = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) simplified.push(points[i]);
  }
  return simplified;
}

function processStroke(stroke) {
  if (stroke.length < 2) return null;

  const sampled = resampleByLength(stroke, RESAMPLE);
  if (sampled.length < 2) return null;

  const rawClosed = Math.hypot(
    sampled[0][0] - sampled[sampled.length - 1][0],
    sampled[0][1] - sampled[sampled.length - 1][1],
  ) <= RESAMPLE * 1.5;
  const points = rawClosed ? sampled : simplifyPolyline(sampled, SIMPLIFY_TOL);
  if (points.length < 2) return null;

  const distance = [0];
  for (let i = 1; i < points.length; i++) {
    distance.push(distance[i - 1] + Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
    ));
  }

  const total = distance[distance.length - 1];
  const closed = Math.hypot(
    points[0][0] - points[points.length - 1][0],
    points[0][1] - points[points.length - 1][1],
  ) <= RESAMPLE * 1.5;

  return { points, distance, total, closed };
}

function pointHalfWidth(path, i) {
  const baseHalf = state.thickness * 0.5 + state.spread * 0.08;
  if (path.closed) return baseHalf;
  const terminalDistance = Math.min(path.distance[i], path.total - path.distance[i]);
  const t = Math.min(1, Math.max(0, terminalDistance / Math.max(state.taperLen, 1e-4)));
  return Math.max(state.tipRadius, baseHalf * Math.pow(t, state.taperExp));
}

function bladeHeight(cross) {
  const t = Math.max(0, 1 - Math.abs(cross));
  const blade = Math.pow(t, Math.max(0.25, state.ridge));
  const groove = Math.pow(t, 24) * state.bevel;
  return Math.max(0, state.peak * (blade - groove));
}

function transformPoint(p, sectorIndex, mirrored) {
  const y = mirrored ? -p[1] : p[1];
  const a = (TAU / Math.max(1, state.symmetry | 0)) * sectorIndex;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c - y * s, p[0] * s + y * c];
}

function appendBlade(path, sectorIndex, mirrored, positions, uvs, indices) {
  const start = positions.length / 3;
  const count = path.points.length;

  for (let i = 0; i < count; i++) {
    const p = transformPoint(path.points[i], sectorIndex, mirrored);
    const pPrev = transformPoint(path.points[Math.max(0, i - 1)], sectorIndex, mirrored);
    const pNext = transformPoint(path.points[Math.min(count - 1, i + 1)], sectorIndex, mirrored);
    let tx = pNext[0] - pPrev[0];
    let ty = pNext[1] - pPrev[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;

    const nx = -ty;
    const ny = tx;
    const half = pointHalfWidth(path, i);
    const along = path.total > 0 ? path.distance[i] / path.total : 0;

    for (const cross of CROSS) {
      positions.push(
        p[0] + nx * half * cross,
        p[1] + ny * half * cross,
        bladeHeight(cross),
      );
      uvs.push(along, cross * 0.5 + 0.5);
    }
  }

  const stride = CROSS.length;
  for (let i = 0; i + 1 < count; i++) {
    const a = start + i * stride;
    const b = start + (i + 1) * stride;
    for (let c = 0; c + 1 < stride; c++) {
      indices.push(a + c, b + c, a + c + 1);
      indices.push(a + c + 1, b + c, b + c + 1);
    }
  }
}

function buildSigilGeometry() {
  const all = current.length >= 2 ? [...strokes, current] : strokes;
  const positions = [];
  const uvs = [];
  const indices = [];
  let base = 0;
  let drawn = 0;

  for (const stroke of all) {
    const path = processStroke(stroke);
    if (!path) continue;

    const segs = path.points.length - 1;
    base += segs;

    for (let k = 0; k < state.symmetry; k++) {
      appendBlade(path, k, false, positions, uvs, indices);
      drawn += segs;
      if (state.mirror) {
        appendBlade(path, k, true, positions, uvs, indices);
        drawn += segs;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  return { geometry, base, drawn, vertices: positions.length / 3 };
}

function syncSigil() {
  const { geometry, base, drawn, vertices } = buildSigilGeometry();
  const oldGeometry = sigilMesh.geometry;
  sigilMesh.geometry = geometry;
  oldGeometry.dispose();
  baseSegCount = base;
  drawnSegCount = drawn;
  vertexCount = vertices;
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
  syncSigil();
});

function finishStroke() {
  if (!drawing) return;
  drawing = false;
  activePointer = null;
  if (current.length >= 2) strokes.push(current);
  current = [];
  syncSigil();
}

renderer.domElement.addEventListener('pointerup', finishStroke);
renderer.domElement.addEventListener('pointercancel', finishStroke);

// --------------------------------------------------------------- guide art ---
const guideGroup = new THREE.Group();
scene.add(guideGroup);
const guideMat = new THREE.LineBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0.5, depthTest: false });

function refreshGuides() {
  guideGroup.clear();
  guideGroup.visible = ui.guides.checked;
  if (!guideGroup.visible) return;

  const all = current.length >= 2 ? [...strokes, current] : strokes;
  for (const stroke of all) {
    if (stroke.length < 2) continue;
    const pts = stroke.map(([x, y]) => new THREE.Vector3(x, y, 0.016));
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

function bindSlider(el, apply, rebuild = true) {
  const out = document.getElementById(`${el.id}-out`);
  const decimals = String(el.step).split('.')[1]?.length || 0;
  el.addEventListener('input', () => {
    const v = Number(el.value);
    if (out) out.textContent = v.toFixed(decimals);
    apply(v);
    if (rebuild) syncSigil();
  });
}

bindSlider(ui.symmetry, (v) => { state.symmetry = v | 0; });
bindSlider(ui.thickness, (v) => { state.thickness = v; });
bindSlider(ui.melt, (v) => { state.spread = v; });
bindSlider(ui.peak, (v) => { state.peak = v; });
bindSlider(ui.roughness, (v) => {
  state.roughness = v;
  sigilMaterial.roughness = v;
}, false);
bindSlider(ui.taperLen, (v) => { state.taperLen = v; });
bindSlider(ui.taperExp, (v) => { state.taperExp = v; });
bindSlider(ui.tipRadius, (v) => { state.tipRadius = v; });
bindSlider(ui.ridge, (v) => { state.ridge = v; });
bindSlider(ui.bevel, (v) => { state.bevel = v; });
bindSlider(ui.rim, (v) => {
  state.rim = v;
  sigilMaterial.emissiveIntensity = v * 0.08;
}, false);
bindSlider(ui.rimpow, (v) => {
  state.rimPower = v;
  sigilMaterial.envMapIntensity = 1.4 + v * 0.14;
}, false);
ui.mirror.addEventListener('change', () => {
  state.mirror = ui.mirror.checked;
  syncSigil();
});
ui.guides.addEventListener('change', refreshGuides);

ui.undo.addEventListener('click', () => {
  if (drawing) finishStroke();
  strokes.pop();
  syncSigil();
});
ui.clear.addEventListener('click', () => {
  if (drawing) finishStroke();
  strokes.length = 0;
  current = [];
  syncSigil();
});

// ------------------------------------------------------------- seed glyph ----
(function seed() {
  const talon = [];
  for (let i = 0; i <= 34; i++) {
    const t = i / 34;
    const a = -0.5 + t * Math.PI * 0.78;
    const r = 0.16 + t * t * 0.92;
    talon.push([Math.cos(a) * r, Math.sin(a) * r - 0.05]);
  }
  strokes.push(talon);
  syncSigil();
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
    statsEl.textContent = `${fps} fps · ${baseSegCount} base · ${drawnSegCount} drawn · ${vertexCount} verts · symmetry ${state.symmetry}${state.mirror ? ' +mirror' : ''} · sparse`;
    frames = 0;
    fpsClock = 0;
  }
});
