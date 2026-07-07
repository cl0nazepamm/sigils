// sigil-caustics.js — throw GPU photon caustics off a real chrome sigil.
//
// Builds a sigil mesh with the sigils library, then hands its geometry to the
// speedball caustic engine (speedball-gi/caustics) in MESH-emission mode:
// photons are emitted off the actual sigil surface, reflected off the raking
// light, and splatted onto the floor. Same engine as caustics.html, different
// caster.

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSigil, spirograph } from '../src/index.js';
import { createCausticEngine } from 'speedball-gi/caustics';
import { sigilCasterShaper } from './shared/sigilCasterShaper.js';

const FLOOR = { width: 9, depth: 7 };

const state = {
    causticStrength: 2.2,
    causticWidth: 0.9,
    causticBloom: 0.7,
    photonBudget: 400000,
    lightRake: -2.2,
    lightHeight: 3.4,
    metalRoughness: 0.035,
    exposure: 1.15,
    metal: 'chrome',
};

// Sigil placement (tweak to aim reflections at the floor).
const SIGIL = { y: 1.35, z: 0.2, tiltX: -0.3, spinY: 0.0, size: 2.7 };

const viewport = document.getElementById('viewport');
const statusEl = document.getElementById('status');
const samplesEl = document.getElementById('samples');
const backendEl = document.getElementById('backend');
const photonReadoutEl = document.getElementById('photonReadout');

let renderer, scene, overlayScene, camera, controls;
let sigilMesh, keyLight, lightMarker;
let caustic = null;
let causticVisible = true;
let frameCounter = 0;

function setStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.classList.toggle('error', isError);
}

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

function buildSigil() {
    const path = spirograph({ R: 5, r: 3, d: 4, radius: 1.4, steps: 1400 });
    const mesh = createSigil(path, {
        symmetry: 4, mirror: true, thickness: 0.24, resolution: 220, taper: 1,
    });
    // normalize + recenter the geometry, then place/tilt above the floor
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    const size = new THREE.Vector3(); bb.getSize(size);
    const center = new THREE.Vector3(); bb.getCenter(center);
    mesh.geometry.translate(-center.x, -center.y, -center.z);
    const s = SIGIL.size / Math.max(size.x, size.y, size.z, 1e-3);
    mesh.scale.setScalar(s);
    mesh.position.set(0, SIGIL.y, SIGIL.z);
    mesh.rotation.set(SIGIL.tiltX, SIGIL.spinY, 0);
    mesh.updateMatrixWorld(true);
    scene.add(mesh);
    return mesh;
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

    sigilMesh = buildSigil();

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
    keyLight.position.set(state.lightRake, state.lightHeight, 1.6);
    lightMarker?.position.copy(keyLight.position);
    caustic?.setLight(state.lightRake, state.lightHeight, 1.6);
}

// ── controls ─────────────────────────────────────────────────────────
function updateOutput(id, value, precision = 2) {
    const out = document.getElementById(`${id}Value`);
    if (out) out.textContent = Number(value).toFixed(precision);
}
function bindRange(id, key, precision, onChange) {
    const input = document.getElementById(id);
    if (!input) return;
    updateOutput(id, input.value, precision);
    input.addEventListener('input', () => {
        const value = Number(input.value);
        state[key] = value;
        updateOutput(id, value, precision);
        onChange?.(value);
    });
}

function bindControls() {
    bindRange('causticStrength', 'causticStrength', 2, (v) => caustic?.setStrength(v));
    bindRange('causticWidth', 'causticWidth', 2, (v) => caustic?.setSoftness(v));
    bindRange('causticBloom', 'causticBloom', 2, (v) => { caustic?.setBloom(v); caustic?.markDirty(); });
    bindRange('photonBudget', 'photonBudget', 0, (v) => caustic?.setPhotonBudget(v));
    bindRange('lightRake', 'lightRake', 2, updateLight);
    bindRange('lightHeight', 'lightHeight', 2, updateLight);
    bindRange('metalRoughness', 'metalRoughness', 3, (v) => caustic?.setRoughness(v));
    bindRange('exposure', 'exposure', 2, (v) => { renderer.toneMappingExposure = v; });

    document.querySelectorAll('[data-metal]').forEach((button) => {
        button.addEventListener('click', () => {
            state.metal = button.dataset.metal;
            document.querySelectorAll('[data-metal]').forEach((b) => b.classList.toggle('active', b === button));
            caustic?.setMetal(state.metal); // tints the caustic
        });
    });
    document.getElementById('resetAccum')?.addEventListener('click', () => {
        caustic?.markDirty();
        setStatus('Rebaking sigil caustic photons...');
    });
    document.getElementById('pauseTrace')?.addEventListener('click', (event) => {
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
    camera.position.set(3.9, 2.6, 5.6);
    camera.lookAt(0.1, 0.9, 0.05);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0.0, 0.7, 0.1);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 2.2;
    controls.maxDistance = 12;
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

    caustic = createCausticEngine({ THREE, renderer });
    caustic.setCasterMesh(sigilMesh, { shaper: sigilCasterShaper(sigilMesh) }); // MESH emission off the real sigil geometry
    caustic.setMetal(state.metal);
    caustic.setLight(state.lightRake, state.lightHeight, 1.6);
    caustic.setSoftness(state.causticWidth);
    caustic.setBloom(state.causticBloom);
    caustic.setStrength(state.causticStrength);
    caustic.setPhotonBudget(state.photonBudget);

    overlayScene = new THREE.Scene();
    overlayScene.add(caustic.overlayMesh);

    const observer = new ResizeObserver(() => resize());
    observer.observe(viewport);

    setStatus('Sigil caustics: photons emitted off the real chrome sigil, GPU-splatted onto the floor.');
    renderer.setAnimationLoop(animate);
}

main().catch((error) => {
    console.error(error);
    setStatus(error?.message || String(error), true);
});
