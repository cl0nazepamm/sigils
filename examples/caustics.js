// caustics.js — demo harness for the vendored GPU photon-caustic engine.
//
// The photon engine itself lives in the master speedball repo and is vendored
// here at ./vendor/caustic_engine.js. This file is ONLY the demo: a rasterized
// chrome beauty scene (curved door + two wheels + floor + studio env), camera,
// controls, and slider wiring. It creates the engine, feeds it the caster world
// matrices + light, adds engine.overlayMesh to an overlay scene, and calls
// engine.update() each frame.

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createCausticEngine } from './vendor/caustic_engine.js';

const FLOOR = { width: 9, depth: 7 };

// Beauty-material hex + roughness per metal (the engine owns the caustic tint).
const METALS = {
    chrome: { hex: 0xf4f8ff, roughness: 0.035 },
    gold: { hex: 0xffc45a, roughness: 0.045 },
    copper: { hex: 0xff8f61, roughness: 0.055 },
};

const state = {
    causticStrength: 2.2,
    causticWidth: 0.9,
    causticBloom: 0.7,
    photonBudget: 300000,
    lightRake: -2.2,
    lightHeight: 3.4,
    metalRoughness: 0.035,
    exposure: 1.15,
    metal: 'chrome',
};

const viewport = document.getElementById('viewport');
const statusEl = document.getElementById('status');
const samplesEl = document.getElementById('samples');
const backendEl = document.getElementById('backend');
const photonReadoutEl = document.getElementById('photonReadout');

let renderer, scene, overlayScene, camera, controls;
let chromeMat, doorMesh, wheelGroups = [], keyLight, lightMarker;
let caustic = null;          // the vendored engine handle
let causticVisible = true;
let frameCounter = 0;

function setStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.classList.toggle('error', isError);
}

// ── beauty scene (rasterized) ────────────────────────────────────────
function makeStudioEnvironment() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 512;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, '#28313a');
    grad.addColorStop(0.45, '#080909');
    grad.addColorStop(1, '#1b140d');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255, 232, 178, 0.95)'; ctx.fillRect(88, 92, 310, 34);
    ctx.fillStyle = 'rgba(148, 199, 255, 0.58)'; ctx.fillRect(690, 135, 210, 26);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'; ctx.fillRect(40, 238, 420, 16);
    const tex = new THREE.CanvasTexture(canvas);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

function createCurvedDoor(material) {
    const geometry = new THREE.PlaneGeometry(5.4, 1.72, 112, 22);
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        const shoulder = Math.cos((x / 2.7) * Math.PI * 0.5) * 0.18;
        const crease = Math.sin(x * 2.25 + y * 0.55) * 0.035;
        const crown = 0.05 * x * x;
        pos.setZ(i, shoulder + crease + crown);
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(0.25, 1.12, 0.34);
    mesh.rotation.set(0.03, -0.19, 0.0);
    mesh.updateMatrixWorld(true);
    scene.add(mesh);
    return mesh;
}

function createWheel(x, material) {
    const group = new THREE.Group();
    group.position.set(x, 0.72, 0.86);
    group.rotation.y = x < 0 ? 0.08 : -0.08;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.072, 28, 128), material);
    group.add(rim);
    const inner = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.035, 20, 96), material);
    group.add(inner);
    const spokeGeo = new THREE.BoxGeometry(0.056, 0.86, 0.055);
    for (let i = 0; i < 10; i++) {
        const spoke = new THREE.Mesh(spokeGeo, material);
        spoke.rotation.z = (i / 10) * Math.PI * 2;
        group.add(spoke);
    }
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.16, 32, 16), material);
    hub.scale.z = 0.42;
    group.add(hub);
    group.updateMatrixWorld(true);
    scene.add(group);
    return group;
}

function createScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080806);
    scene.environment = makeStudioEnvironment();
    scene.environmentIntensity = 0.55;
    scene.environmentRotation = new THREE.Euler(0, -0.35, 0);

    const floorMat = new THREE.MeshStandardMaterial({ color: 0x211c15, roughness: 0.44, metalness: 0.0 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR.width, FLOOR.depth, 1, 1), floorMat);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    chromeMat = new THREE.MeshPhysicalMaterial({
        color: METALS.chrome.hex, metalness: 1.0, roughness: state.metalRoughness, envMapIntensity: 2.2,
    });
    doorMesh = createCurvedDoor(chromeMat);
    wheelGroups = [createWheel(-1.55, chromeMat), createWheel(1.45, chromeMat)];

    keyLight = new THREE.PointLight(0xffffff, 64, 12, 1.6);
    scene.add(keyLight);
    lightMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 16, 8),
        new THREE.MeshBasicMaterial({ color: 0xffd46a, toneMapped: false }),
    );
    scene.add(lightMarker);
    const fill = new THREE.DirectionalLight(0x8fbfff, 0.35);
    fill.position.set(3, 5, 4);
    scene.add(fill);

    updateLight();
}

function updateLight() {
    if (!keyLight) return;
    keyLight.position.set(state.lightRake, state.lightHeight, -1.45);
    lightMarker?.position.copy(keyLight.position);
    caustic?.setLight(state.lightRake, state.lightHeight, -1.45);
}

// ── controls ─────────────────────────────────────────────────────────
function updateOutput(id, value, precision = 2) {
    const out = document.getElementById(`${id}Value`);
    if (out) out.textContent = Number(value).toFixed(precision);
}
function bindRange(id, key, precision, onChange) {
    const input = document.getElementById(id);
    updateOutput(id, input.value, precision);
    input.addEventListener('input', () => {
        const value = Number(input.value);
        state[key] = value;
        updateOutput(id, value, precision);
        onChange?.(value);
    });
}

function applyMetalPreset(name) {
    const preset = METALS[name] || METALS.chrome;
    state.metal = name;
    state.metalRoughness = preset.roughness;
    chromeMat.color.setHex(preset.hex);
    chromeMat.roughness = state.metalRoughness;
    chromeMat.needsUpdate = true;
    document.getElementById('metalRoughness').value = String(state.metalRoughness);
    updateOutput('metalRoughness', state.metalRoughness, 3);
    document.querySelectorAll('[data-metal]').forEach((b) => b.classList.toggle('active', b.dataset.metal === name));
    caustic?.setMetal(name); // tint + roughness + rebake
}

function bindControls() {
    bindRange('causticStrength', 'causticStrength', 2, (v) => caustic?.setStrength(v));
    bindRange('causticWidth', 'causticWidth', 2, (v) => caustic?.setSoftness(v));
    bindRange('causticBloom', 'causticBloom', 2, (v) => { caustic?.setBloom(v); caustic?.markDirty(); });
    bindRange('photonBudget', 'photonBudget', 0, (v) => caustic?.setPhotonBudget(v));
    bindRange('lightRake', 'lightRake', 2, updateLight);
    bindRange('lightHeight', 'lightHeight', 2, updateLight);
    bindRange('metalRoughness', 'metalRoughness', 3, (v) => {
        chromeMat.roughness = v; chromeMat.needsUpdate = true;
        caustic?.setRoughness(v);
    });
    bindRange('exposure', 'exposure', 2, (v) => { renderer.toneMappingExposure = v; });

    document.querySelectorAll('[data-metal]').forEach((button) => {
        button.addEventListener('click', () => applyMetalPreset(button.dataset.metal));
    });
    document.getElementById('resetAccum').addEventListener('click', () => {
        caustic?.markDirty();
        setStatus('Rebaking GPU caustic photons...');
    });
    document.getElementById('pauseTrace').addEventListener('click', (event) => {
        causticVisible = !causticVisible;
        event.currentTarget.classList.toggle('active', !causticVisible);
        event.currentTarget.textContent = causticVisible ? 'Hide caustics' : 'Show caustics';
    });
}

// ── renderer / camera / loop ─────────────────────────────────────────
function resize() {
    if (!renderer || !camera) return;
    const rect = viewport.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
}

async function initRenderer() {
    if (!navigator.gpu) throw new Error('WebGPU is required. Use Chrome/Edge with WebGPU enabled.');
    renderer = new THREE.WebGPURenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = state.exposure;
    viewport.appendChild(renderer.domElement);
    resize();
    await renderer.init();
    backendEl.textContent = 'WebGPU compute';
}

function initCamera() {
    const rect = viewport.getBoundingClientRect();
    camera = new THREE.PerspectiveCamera(44, Math.max(1, rect.width) / Math.max(1, rect.height), 0.03, 60);
    camera.position.set(3.75, 2.45, 5.35);
    camera.lookAt(0.1, 0.72, 0.05);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0.05, 0.66, 0.18);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 2.2;
    controls.maxDistance = 10;
}

function animate() {
    controls.update();
    const st = caustic.update();
    renderer.render(scene, camera);
    if (causticVisible && state.causticStrength > 0.001) {
        renderer.autoClear = false;
        renderer.render(overlayScene, camera);
        renderer.autoClear = true;
    }
    frameCounter++;
    if ((frameCounter & 15) === 0) {
        samplesEl.textContent = st.converged ? 'converged' : 'baking';
        photonReadoutEl.textContent = st.converged ? `${st.accum} ✓` : String(st.accum);
    }
}

async function main() {
    bindControls();
    await initRenderer();
    initCamera();
    createScene();

    // Vendored engine from speedball. Feed it the caster world matrices + light,
    // then just call update() each frame and render its overlay mesh.
    caustic = createCausticEngine({ THREE, renderer });
    caustic.setCasterMatrices(doorMesh.matrixWorld, wheelGroups[0].matrixWorld, wheelGroups[1].matrixWorld);
    caustic.setMetal(state.metal);
    caustic.setLight(state.lightRake, state.lightHeight, -1.45);
    caustic.setSoftness(state.causticWidth);
    caustic.setBloom(state.causticBloom);
    caustic.setStrength(state.causticStrength);
    caustic.setPhotonBudget(state.photonBudget);

    overlayScene = new THREE.Scene();
    overlayScene.add(caustic.overlayMesh);

    const observer = new ResizeObserver(() => resize());
    observer.observe(viewport);

    setStatus('Pure-WebGPU compute caustics (engine vendored from speedball). Orbit the camera; the caustic re-bakes on the GPU when you move the light or metal.');
    renderer.setAnimationLoop(animate);
}

main().catch((error) => {
    console.error(error);
    setStatus(error?.message || String(error), true);
});
