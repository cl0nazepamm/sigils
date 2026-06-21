import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { createSigil, updateChromeMaterial, spirograph } from '../src/index.js';

// ---------------------------------------------------------------- renderer ---
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.body.appendChild(renderer.domElement);
await renderer.init();

// ------------------------------------------------------------------- scene ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0b0d);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
camera.up.set(0, 0, 1); // sigil lies in the XY plane, bulges toward +Z
camera.position.set(0, -2.6, 3.6); // 3/4 top-down

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0.15);

// studio reflections for the chrome
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// ------------------------------------------------------------------ glyphs ---
// Arbitrary curves -> sharp chrome sigils. The point of the package is the
// conversion math: open strokes taper to points, corners and crossings stay
// crisp. Mix of hand-authored glyphs + one spirograph for variety.
function star(points, step, radius = 1) {
  const p = [];
  for (let k = 0; k <= points; k++) {
    const a = -Math.PI / 2 + (k * step * 2 * Math.PI) / points;
    p.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return p;
}

const GLYPHS = [
  { name: 'rune', paths: [[-0.95, -0.2], [-0.25, 0.9], [-0.55, -0.65], [0.5, 0.25], [-0.1, -0.9], [0.95, 0.6], [1.0, -0.45]] },
  { name: 'pentagram', paths: star(5, 2) },          // {5/2} star: sharp points + crossings
  { name: 'asterisk', paths: [[[-1, 0], [1, 0]], [[-0.5, -0.87], [0.5, 0.87]], [[-0.5, 0.87], [0.5, -0.87]]] },
  { name: 'septagram', paths: star(7, 3) },          // {7/3} star
  { name: 'spiro', paths: spirograph({ R: 7, r: 4, d: 6, radius: 1.15, steps: 2400 }) },
];

const state = {
  glyph: 0,
  thickness: 0.16,
  smooth: 3,
  taperPower: 1.05,
  edgeFalloff: 0.5,
  sigilize: 36,
  sigilizeWeight: 0.75,
  heightSmooth: 2,
  base: 0,
  peak: 0.13,
  roughness: 0.05,
};
let sigil = null;
let rebuildTimer = 0;
let controlsReady = false;
const controlInputs = new Map();

const CONTROL_GROUPS = [
  {
    title: 'Shape',
    controls: [
      { key: 'glyph', label: 'Glyph', type: 'select', options: GLYPHS.map((g, i) => [String(i), g.name]) },
      { key: 'thickness', label: 'Width', min: 0.04, max: 0.32, step: 0.005 },
      { key: 'smooth', label: 'Field blur', min: 0, max: 8, step: 1 },
      { key: 'taperPower', label: 'Tip taper', min: 0.35, max: 2.4, step: 0.01 },
      { key: 'base', label: 'Base', min: 0, max: 0.16, step: 0.005 },
    ],
  },
  {
    title: 'Smoothing',
    controls: [
      { key: 'sigilize', label: 'Smooth', min: 0, max: 70, step: 1 },
      { key: 'sigilizeWeight', label: 'Melt', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: 'Surface',
    controls: [
      { key: 'edgeFalloff', label: 'Falloff', min: 0.18, max: 1.2, step: 0.01 },
      { key: 'heightSmooth', label: 'Height blur', min: 0, max: 8, step: 1 },
      { key: 'peak', label: 'Peak', min: 0, max: 0.45, step: 0.005, live: true },
      { key: 'roughness', label: 'Rough', min: 0, max: 0.35, step: 0.005, live: true },
    ],
  },
];

function rebuild() {
  if (sigil) {
    scene.remove(sigil);
    sigil.geometry.dispose();
    sigil.material.dispose();
  }
  sigil = createSigil(GLYPHS[state.glyph].paths, {
    thickness: state.thickness,
    resolution: 460,
    smooth: state.smooth,
    taper: 1,         // open ends resolve to sharp points
    taperPower: state.taperPower,
    depthMode: 'boundary',
    edgeFalloff: state.thickness * state.edgeFalloff,
    sigilize: state.sigilize,
    sigilizeWeight: state.sigilizeWeight,
    heightSmooth: state.heightSmooth,
    base: state.base,
    peakHeight: state.peak,
    profile: 'linear',
    roughness: state.roughness,
    color: 0xffffff,
    envMapIntensity: 1.6,
  });
  scene.add(sigil);
}
rebuild();

function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 140);
}

function buildControls() {
  const root = document.getElementById('controls');
  if (!root) return;
  controlsReady = false;
  root.closest('form')?.addEventListener('submit', (event) => event.preventDefault());
  root.textContent = '';

  for (const group of CONTROL_GROUPS) {
    const section = document.createElement('section');
    section.className = 'control-section';
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = group.title;
    section.appendChild(title);

    for (const spec of group.controls) {
      const row = document.createElement('div');
      row.className = 'control-row';

      const label = document.createElement('label');
      label.htmlFor = `ctrl-${spec.key}`;
      label.textContent = spec.label;
      row.appendChild(label);

      if (spec.type === 'select') {
        const select = document.createElement('select');
        select.id = `ctrl-${spec.key}`;
        select.name = spec.key;
        select.autocomplete = 'off';
        for (const [value, text] of spec.options) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = text;
          select.appendChild(option);
        }
        select.value = String(state[spec.key]);
        select.addEventListener('change', () => {
          if (!controlsReady) return;
          state[spec.key] = Number(select.value);
          rebuild();
        });
        row.appendChild(select);
        controlInputs.set(spec.key, { slider: select });
      } else {
        const slider = document.createElement('input');
        slider.id = `ctrl-${spec.key}`;
        slider.name = spec.key;
        slider.autocomplete = 'off';
        slider.type = 'range';
        slider.min = spec.min;
        slider.max = spec.max;
        slider.step = spec.step;
        slider.value = state[spec.key];

        const number = document.createElement('input');
        number.type = 'number';
        number.id = `ctrl-${spec.key}-value`;
        number.name = `${spec.key}Value`;
        number.autocomplete = 'off';
        number.min = spec.min;
        number.max = spec.max;
        number.step = spec.step;
        number.value = formatValue(state[spec.key], spec.step);

        const setValue = (raw, immediate = false) => {
          const next = clamp(Number(raw), Number(spec.min), Number(spec.max));
          state[spec.key] = next;
          slider.value = String(next);
          number.value = formatValue(next, spec.step);
          if (spec.live) live();
          else if (immediate) rebuild();
          else scheduleRebuild();
        };

        slider.addEventListener('input', () => { if (controlsReady) setValue(slider.value); });
        number.addEventListener('change', () => { if (controlsReady) setValue(number.value, true); });
        row.append(slider, number);
        controlInputs.set(spec.key, { slider, number, spec });
      }

      section.appendChild(row);
    }

    root.appendChild(section);
  }
}

function syncControls() {
  for (const [key, refs] of controlInputs) {
    if (refs.slider) refs.slider.value = String(state[key]);
    if (refs.number) refs.number.value = formatValue(state[key], refs.spec.step);
  }
}

function formatValue(value, step) {
  const decimals = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  return Number(value).toFixed(Math.min(decimals, 3));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

buildControls();
requestAnimationFrame(() => {
  syncControls();
  setTimeout(() => {
    syncControls();
    controlsReady = true;
  }, 80);
});

// ----------------------------------------------------------------- controls --
addEventListener('keydown', (e) => {
  if (e.key >= '1' && e.key <= '9') {
    const i = +e.key - 1;
    if (i < GLYPHS.length) { state.glyph = i; rebuild(); syncControls(); }
  } else if (e.key === '[') { state.peak = Math.max(0, state.peak - 0.03); live(); syncControls(); }
  else if (e.key === ']') { state.peak = Math.min(0.45, state.peak + 0.03); live(); syncControls(); }
  else if (e.key === '-') { state.roughness = Math.min(0.35, state.roughness + 0.02); live(); syncControls(); }
  else if (e.key === '=') { state.roughness = Math.max(0, state.roughness - 0.02); live(); syncControls(); }
  else if (e.key === 'r') { state.glyph = (state.glyph + 1) % GLYPHS.length; rebuild(); syncControls(); }
});

// look-only changes: update uniforms, no geometry rebuild
function live() {
  updateChromeMaterial(sigil.material, { peakHeight: state.peak, roughness: state.roughness });
}

// ------------------------------------------------------------------- loop ----
addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
