import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { createSigilAsync, updateChromeMaterial } from '../src/index.js';

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

// Near top-down so what you draw on the z=0 plane lands where the sigil grows,
// but tilted just enough to read the chrome relief.
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100);
camera.up.set(0, 1, 0);
camera.position.set(0, -0.85, 3.7);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);
// Keep the left button free for drawing; orbit on right-drag, dolly on scroll.
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

// studio reflections for the chrome
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// ------------------------------------------------------------- draw plane ----
// Pointer positions are projected onto the z=0 plane to get stroke coordinates,
// so drawing stays correct regardless of how the camera is orbited.
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

// --------------------------------------------------------------- guide art ---
// Thin faint lines showing the raw strokes that feed the generator.
const guideGroup = new THREE.Group();
guideGroup.renderOrder = 2;
scene.add(guideGroup);
const guideMat = new THREE.LineBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0.7, depthTest: false });

function refreshGuides() {
  guideGroup.clear();
  guideGroup.visible = ui.guides.checked;
  if (!guideGroup.visible) return;
  const lines = current.length >= 2 ? [...strokes, current] : strokes;
  for (const stroke of lines) {
    if (stroke.length < 2) continue;
    const pts = stroke.map(([x, y]) => new THREE.Vector3(x, y, 0.012));
    guideGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), guideMat));
  }
}

// ------------------------------------------------------------------ state ----
const state = {
  symmetry: 6,
  mirror: false,
  thickness: 0.14,
  peak: 0.14,
  roughness: 0.05,
};

const strokes = [];      // completed strokes, each a polyline of [x, y]
let current = [];        // stroke being drawn right now
let sigil = null;
let rebuildVersion = 0;

// --------------------------------------------------------------- generate ----
async function rebuild() {
  if (strokes.length === 0) {
    if (sigil) { scene.remove(sigil); sigil.geometry.dispose(); sigil.material.dispose(); sigil = null; }
    return;
  }

  const version = ++rebuildVersion;
  const next = await createSigilAsync(strokes, {
    symmetry: state.symmetry,
    mirror: state.mirror,
    center: [0, 0],          // rotate around the canvas origin, not the stroke centroid
    thickness: state.thickness,
    resolution: 460,
    fieldBackend: 'hybrid',
    renderer,
    smooth: 3,
    taper: 1,                // open ends taper to sharp points
    taperPower: 1.05,
    depthMode: 'boundary',
    edgeFalloff: state.thickness * 0.5,
    sigilize: 36,
    sigilizeWeight: 0.75,
    heightSmooth: 2,
    base: 0,
    peakHeight: state.peak,
    profile: 'linear',
    roughness: state.roughness,
    color: 0xffffff,
    envMapIntensity: 1.6,
    onGpuFallback: (error) => console.warn('sigils: hybrid field fallback', error),
  });

  // A newer rebuild started while we were awaiting — drop this one.
  if (version !== rebuildVersion) {
    next.geometry.dispose();
    next.material.dispose();
    return;
  }

  if (sigil) { scene.remove(sigil); sigil.geometry.dispose(); sigil.material.dispose(); }
  sigil = next;
  scene.add(sigil);
}

// look-only changes: update uniforms, skip the geometry rebuild
function live() {
  if (sigil) updateChromeMaterial(sigil.material, { peakHeight: state.peak, roughness: state.roughness });
}

let rebuildTimer = 0;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 120);
}

// -------------------------------------------------------------- pointer io ---
let drawing = false;
let activePointer = null;
const MIN_STEP = 0.015; // world-space spacing between captured points

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
  if (event.button !== 0) return; // left button draws; let right/middle orbit
  drawing = true;
  activePointer = event.pointerId;
  renderer.domElement.setPointerCapture(event.pointerId);
  current = [];
  pushPoint(planePoint(event));
  refreshGuides();
});

renderer.domElement.addEventListener('pointermove', (event) => {
  if (!drawing || event.pointerId !== activePointer) return;
  pushPoint(planePoint(event));
  refreshGuides();
});

function finishStroke() {
  if (!drawing) return;
  drawing = false;
  activePointer = null;
  if (current.length >= 2) {
    strokes.push(current);
    rebuild();
  }
  current = [];
  refreshGuides();
}

renderer.domElement.addEventListener('pointerup', finishStroke);
renderer.domElement.addEventListener('pointercancel', finishStroke);

// ----------------------------------------------------------------- panel -----
const ui = {
  symmetry: document.getElementById('symmetry'),
  mirror: document.getElementById('mirror'),
  thickness: document.getElementById('thickness'),
  peak: document.getElementById('peak'),
  roughness: document.getElementById('roughness'),
  guides: document.getElementById('guides'),
  undo: document.getElementById('undo'),
  clear: document.getElementById('clear'),
};

function bindSlider(el, key, { live: isLive = false } = {}) {
  const out = document.getElementById(`${el.id}-out`);
  el.addEventListener('input', () => {
    state[key] = Number(el.value);
    if (out) out.textContent = Number(el.value).toFixed(String(el.step).split('.')[1]?.length || 0);
    if (isLive) live();
    else scheduleRebuild();
  });
}

bindSlider(ui.symmetry, 'symmetry');
bindSlider(ui.thickness, 'thickness');
bindSlider(ui.peak, 'peak', { live: true });
bindSlider(ui.roughness, 'roughness', { live: true });

ui.mirror.addEventListener('change', () => { state.mirror = ui.mirror.checked; scheduleRebuild(); });
ui.guides.addEventListener('change', refreshGuides);

ui.undo.addEventListener('click', () => {
  if (drawing) finishStroke();
  strokes.pop();
  refreshGuides();
  rebuild();
});

ui.clear.addEventListener('click', () => {
  if (drawing) finishStroke();
  strokes.length = 0;
  current = [];
  refreshGuides();
  rebuild();
});

// ------------------------------------------------------------- seed glyph ----
// A little hand-drawn arc so the page opens with chrome instead of a void.
(function seed() {
  const arc = [];
  for (let i = 0; i <= 22; i++) {
    const t = i / 22;
    const a = -Math.PI * 0.62 + t * Math.PI * 1.24;
    arc.push([Math.cos(a) * 0.75, Math.sin(a) * 0.75 - 0.1]);
  }
  strokes.push(arc);
  refreshGuides();
  rebuild();
})();

// ------------------------------------------------------------------ loop -----
addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
