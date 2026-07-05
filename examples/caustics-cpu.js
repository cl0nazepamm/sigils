import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const viewport = document.getElementById('viewport');
const statusEl = document.getElementById('status');
const samplesEl = document.getElementById('samples');
const backendEl = document.getElementById('backend');
const photonReadoutEl = document.getElementById('photonReadout');

const FLOOR = {
    width: 9,
    depth: 7,
    minX: -4.5,
    maxX: 4.5,
    minZ: -3.5,
    maxZ: 3.5,
};

const METALS = {
    chrome: { hex: 0xf4f8ff, rgb: [238, 247, 255], roughness: 0.035 },
    gold: { hex: 0xffc45a, rgb: [255, 208, 105], roughness: 0.045 },
    copper: { hex: 0xff8f61, rgb: [255, 158, 105], roughness: 0.055 },
};

const state = {
    causticStrength: 2.2,
    causticWidth: 0.9,
    causticBloom: 0.7,
    photonBudget: 8000,
    lightRake: -2.2,
    lightHeight: 3.4,
    metalRoughness: 0.035,
    exposure: 1.15,
    metal: 'chrome',
};

// Total photons to accumulate (across frames) before the caustic is "converged"
// and tracing stops. Higher = smoother/sharper cusps, longer to settle.
const CAUSTIC_TARGET_TOTAL = 1_400_000;

let renderer;
let scene;
let overlayScene;
let camera;
let controls;
let chromeMat;
let floorMat;
let doorMesh;
let wheelGroups = [];
let keyLight;
let lightMarker;
let causticTexture;
let causticMaterial;
let causticCanvas;
let causticCtx;
let causticImage;
let densityBuf;   // Float32 photon energy deposited on the floor (point splats)
let sharpBuf;     // density estimate (tight kernel) -> crisp caustic cusps
let brightBuf;    // thresholded bright cores -> bloom source
let bloomBuf;     // wide kernel of the bright cores -> hot-cusp glow
let tmpBuf;       // scratch for separable blur
let photonNorm = 1;
let causticDirty = true;      // restart photon accumulation next frame
let causticPhotonsAccum = 0;  // photons accumulated since last reset
let causticConverged = false; // stop tracing once the target total is reached
let causticVisible = true;    // overlay on/off (A/B the caustic pass)
let rngSeed = 1;
let frameCounter = 0;

const tmpV0 = new THREE.Vector3();
const tmpV1 = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const photonIncident = new THREE.Vector3();
const photonReflected = new THREE.Vector3();
const photonHit = new THREE.Vector3();
const tmpM3 = new THREE.Matrix3();

function setStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.classList.toggle('error', isError);
}

function seededRandom() {
    rngSeed = (rngSeed * 1664525 + 1013904223) >>> 0;
    return rngSeed / 4294967296;
}

function makeStudioEnvironment() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, '#28313a');
    grad.addColorStop(0.45, '#080909');
    grad.addColorStop(1, '#1b140d');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255, 232, 178, 0.95)';
    ctx.fillRect(88, 92, 310, 34);
    ctx.fillStyle = 'rgba(148, 199, 255, 0.58)';
    ctx.fillRect(690, 135, 210, 26);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fillRect(40, 238, 420, 16);
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
        const x = pos.getX(i);
        const y = pos.getY(i);
        const shoulder = Math.cos((x / 2.7) * Math.PI * 0.5) * 0.18;
        const crease = Math.sin(x * 2.25 + y * 0.55) * 0.035;
        const crown = 0.05 * x * x;
        pos.setZ(i, shoulder + crease + crown);
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'pure metal side door caustic caster';
    mesh.position.set(0.25, 1.12, 0.34);
    mesh.rotation.set(0.03, -0.19, 0.0);
    scene.add(mesh);
    return mesh;
}

function createWheel(x, material) {
    const group = new THREE.Group();
    group.name = `pure metal rim ${x < 0 ? 'left' : 'right'}`;
    group.position.set(x, 0.72, 0.86);
    group.rotation.y = x < 0 ? 0.08 : -0.08;

    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.072, 28, 128), material);
    rim.name = 'mirror rim lip';
    group.add(rim);

    const inner = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.035, 20, 96), material);
    inner.name = 'mirror inner lip';
    group.add(inner);

    const spokeGeo = new THREE.BoxGeometry(0.056, 0.86, 0.055);
    for (let i = 0; i < 10; i++) {
        const spoke = new THREE.Mesh(spokeGeo, material);
        spoke.name = 'mirror rim spoke';
        spoke.rotation.z = (i / 10) * Math.PI * 2;
        group.add(spoke);
    }

    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.16, 32, 16), material);
    hub.name = 'mirror rim hub';
    hub.scale.z = 0.42;
    group.add(hub);

    scene.add(group);
    return group;
}

function createScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080806);
    scene.environment = makeStudioEnvironment();
    scene.environmentIntensity = 0.55;
    scene.environmentRotation = new THREE.Euler(0, -0.35, 0);

    floorMat = new THREE.MeshStandardMaterial({
        name: 'warm graphite caustic receiver',
        color: 0x211c15,
        roughness: 0.44,
        metalness: 0.0,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR.width, FLOOR.depth, 1, 1), floorMat);
    floor.name = 'floor caustic receiver';
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    scene.add(floor);

    chromeMat = new THREE.MeshPhysicalMaterial({
        name: 'pure chrome caustic caster',
        color: METALS.chrome.hex,
        metalness: 1.0,
        roughness: state.metalRoughness,
        envMapIntensity: 2.2,
    });

    doorMesh = createCurvedDoor(chromeMat);
    wheelGroups = [createWheel(-1.55, chromeMat), createWheel(1.45, chromeMat)];

    keyLight = new THREE.PointLight(0xffffff, 64, 12, 1.6);
    keyLight.name = 'hard caustic key light';
    scene.add(keyLight);

    lightMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 16, 8),
        new THREE.MeshBasicMaterial({ color: 0xffd46a, toneMapped: false }),
    );
    lightMarker.name = 'visible key light marker';
    scene.add(lightMarker);

    const fill = new THREE.DirectionalLight(0x8fbfff, 0.35);
    fill.name = 'cool studio fill';
    fill.position.set(3, 5, 4);
    scene.add(fill);

    updateLight();
}

function createOverlay() {
    overlayScene = new THREE.Scene();
    causticCanvas = document.createElement('canvas');
    causticCanvas.width = 768;
    causticCanvas.height = 768;
    causticCtx = causticCanvas.getContext('2d', { willReadFrequently: true });
    causticImage = causticCtx.createImageData(causticCanvas.width, causticCanvas.height);
    const texels = causticCanvas.width * causticCanvas.height;
    densityBuf = new Float32Array(texels);
    sharpBuf = new Float32Array(texels);
    brightBuf = new Float32Array(texels);
    bloomBuf = new Float32Array(texels);
    tmpBuf = new Float32Array(texels);
    causticTexture = new THREE.CanvasTexture(causticCanvas);
    causticTexture.colorSpace = THREE.SRGBColorSpace;
    causticTexture.needsUpdate = true;

    causticMaterial = new THREE.MeshBasicMaterial({
        map: causticTexture,
        transparent: true,
        opacity: state.causticStrength,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
    });

    const plane = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR.width, FLOOR.depth), causticMaterial);
    plane.name = 'artistic reflective metal caustic buffer';
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0.012;
    plane.renderOrder = 1000;
    overlayScene.add(plane);
}

function updateLight() {
    if (!keyLight) return;
    keyLight.position.set(state.lightRake, state.lightHeight, -1.45);
    lightMarker?.position.copy(keyLight.position);
}

function applyMetalPreset(name) {
    const preset = METALS[name] || METALS.chrome;
    state.metal = name;
    state.metalRoughness = preset.roughness;
    chromeMat.color.setHex(preset.hex);
    chromeMat.roughness = state.metalRoughness;
    chromeMat.needsUpdate = true;
    const roughnessInput = document.getElementById('metalRoughness');
    roughnessInput.value = String(state.metalRoughness);
    updateOutput('metalRoughness', state.metalRoughness, 3);
    document.querySelectorAll('[data-metal]').forEach((button) => {
        button.classList.toggle('active', button.dataset.metal === name);
    });
    markCausticsDirty();
}

function sampleDoor(point, normal) {
    const u = seededRandom();
    const v = seededRandom();
    const x = (u * 2 - 1) * 2.7;
    const y = (v * 2 - 1) * 0.86;
    const shoulder = Math.cos((x / 2.7) * Math.PI * 0.5) * 0.18;
    const crease = Math.sin(x * 2.25 + y * 0.55) * 0.035;
    const crown = 0.05 * x * x;
    const z = shoulder + crease + crown;
    // The caustic caster normal is LOW-PASSED vs the beauty geometry: the shoulder
    // sweep + parabolic crown focus light into cusp curves, while the sharp crease
    // ripple is damped (CREASE) so nearby photons converge instead of spraying.
    const CREASE = 0.12;
    const dzdx = -Math.sin((x / 2.7) * Math.PI * 0.5) * (Math.PI * 0.5 / 2.7) * 0.18
        + Math.cos(x * 2.25 + y * 0.55) * 2.25 * 0.035 * CREASE
        + 0.1 * x;
    const dzdy = Math.cos(x * 2.25 + y * 0.55) * 0.55 * 0.035 * CREASE;

    point.set(x, y, z).applyMatrix4(doorMesh.matrixWorld);
    normal.set(-dzdx, -dzdy, 1).normalize();
    tmpM3.getNormalMatrix(doorMesh.matrixWorld);
    normal.applyMatrix3(tmpM3).normalize();
}

function sampleWheel(group, point, normal) {
    const major = seededRandom() < 0.72 ? 0.56 : 0.31;
    const minor = major > 0.4 ? 0.072 : 0.035;
    const theta = seededRandom() * Math.PI * 2;
    const phi = seededRandom() * Math.PI * 2;
    const tube = major + minor * Math.cos(phi);
    point.set(
        tube * Math.cos(theta),
        tube * Math.sin(theta),
        minor * Math.sin(phi),
    ).applyMatrix4(group.matrixWorld);
    normal.set(
        Math.cos(phi) * Math.cos(theta),
        Math.cos(phi) * Math.sin(theta),
        Math.sin(phi),
    ).normalize();
    tmpM3.getNormalMatrix(group.matrixWorld);
    normal.applyMatrix3(tmpM3).normalize();
}

function floorToCanvas(hit) {
    if (hit.x < FLOOR.minX || hit.x > FLOOR.maxX || hit.z < FLOOR.minZ || hit.z > FLOOR.maxZ) return null;
    return {
        x: ((hit.x - FLOOR.minX) / FLOOR.width) * causticCanvas.width,
        y: (1 - ((hit.z - FLOOR.minZ) / FLOOR.depth)) * causticCanvas.height,
    };
}

// Deposit one photon as a short anisotropic footprint stretched along its floor
// flow direction. The elongated footprint fills the caustic sheet continuously
// (point splats leave bokeh gaps); the CUSPS come from where many footprints
// pile up, which only happens if the caster normals focus (see sampleDoor).
function depositPhoton(px, py, energy, dirx, diry, lengthPx) {
    const steps = Math.max(1, Math.ceil(lengthPx));
    const e = energy / steps;
    for (let s = 0; s < steps; s++) {
        const tt = steps === 1 ? 0 : (s / (steps - 1) - 0.5);
        depositPoint(px + dirx * lengthPx * tt, py + diry * lengthPx * tt, e);
    }
}

function depositPoint(px, py, e) {
    const W = causticCanvas.width;
    const H = causticCanvas.height;
    const fx = px - 0.5;
    const fy = py - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    accumulate(x0, y0, e * (1 - tx) * (1 - ty), W, H);
    accumulate(x0 + 1, y0, e * tx * (1 - ty), W, H);
    accumulate(x0, y0 + 1, e * (1 - tx) * ty, W, H);
    accumulate(x0 + 1, y0 + 1, e * tx * ty, W, H);
}

function accumulate(x, y, e, W, H) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    densityBuf[y * W + x] += e;
}

function traceMetalPhoton(point, normal, sourceKind) {
    const lightPos = keyLight.position;
    const incident = photonIncident.copy(point).sub(lightPos);
    const distSq = Math.max(0.5, incident.lengthSq());
    incident.normalize();
    const ndl = Math.max(0, -incident.dot(normal));
    if (ndl <= 0.0001) return;

    const reflected = photonReflected.copy(incident).reflect(normal).normalize();
    if (reflected.y >= -0.012) return;
    const t = -point.y / reflected.y;
    if (t <= 0 || t > 24) return;

    const hit = photonHit.copy(point).addScaledVector(reflected, t);
    const uv = floorToCanvas(hit);
    if (!uv) return;

    const roughPenalty = Math.max(0.12, 1 - state.metalRoughness * 5.5);
    const sourceGain = sourceKind === 'rim' ? 1.55 : 1.0;
    // Grazing (near-horizontal) reflections throw longer and read brighter,
    // which is exactly where real chrome caustics streak across a studio floor.
    const grazing = 1 - Math.min(1, Math.abs(reflected.y));
    const grazeGain = 0.55 + grazing * 1.5;
    const energy = ndl * roughPenalty * sourceGain * grazeGain * (8.0 / distSq) * photonNorm;

    // Footprint stretched along the floor-projected reflected direction.
    // (canvas +x = world +x, canvas +y = world -z, per floorToCanvas.)
    let cdx = reflected.x * (causticCanvas.width / FLOOR.width);
    let cdy = -reflected.z * (causticCanvas.height / FLOOR.depth);
    const clen = Math.hypot(cdx, cdy) || 1;
    cdx /= clen;
    cdy /= clen;
    const streakPx = Math.min(18, (2 + grazing * 15) * state.causticWidth);
    depositPhoton(uv.x, uv.y, energy, cdx, cdy, streakPx);
}

// Separable clamp-to-edge box blur (one pass, radius r) using a running sum.
function boxBlur1D(src, dst, W, H, r, horizontal) {
    const inv = 1 / (2 * r + 1);
    if (horizontal) {
        for (let y = 0; y < H; y++) {
            const base = y * W;
            let sum = 0;
            for (let k = -r; k <= r; k++) {
                const xi = k < 0 ? 0 : (k >= W ? W - 1 : k);
                sum += src[base + xi];
            }
            for (let x = 0; x < W; x++) {
                dst[base + x] = sum * inv;
                const xin = x + r + 1 >= W ? W - 1 : x + r + 1;
                const xout = x - r < 0 ? 0 : x - r;
                sum += src[base + xin] - src[base + xout];
            }
        }
    } else {
        for (let x = 0; x < W; x++) {
            let sum = 0;
            for (let k = -r; k <= r; k++) {
                const yi = k < 0 ? 0 : (k >= H ? H - 1 : k);
                sum += src[yi * W + x];
            }
            for (let y = 0; y < H; y++) {
                dst[y * W + x] = sum * inv;
                const yin = (y + r + 1 >= H ? H - 1 : y + r + 1) * W + x;
                const yout = (y - r < 0 ? 0 : y - r) * W + x;
                sum += src[yin] - src[yout];
            }
        }
    }
}

// 3 iterations of box blur ~= Gaussian. Needs a scratch buffer distinct from src/dst.
function gaussBlur(src, dst, W, H, radius) {
    const r = Math.max(1, Math.round(radius));
    boxBlur1D(src, tmpBuf, W, H, r, true);
    boxBlur1D(tmpBuf, dst, W, H, r, false);
    boxBlur1D(dst, tmpBuf, W, H, r, true);
    boxBlur1D(tmpBuf, dst, W, H, r, false);
    boxBlur1D(dst, tmpBuf, W, H, r, true);
    boxBlur1D(tmpBuf, dst, W, H, r, false);
}

function encodeSRGB(c) {
    if (c <= 0) return 0;
    if (c >= 1) return 1;
    return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

// Turn the raw photon energy field into a tone-mapped, tinted, blooming caustic.
// The key to a car-render look is CONTRAST: crush the broad low-density reflection
// pool to black and let only the concentrated fold cusps light up + bloom.
function resolveCaustics() {
    const W = causticCanvas.width;
    const H = causticCanvas.height;
    const preset = METALS[state.metal] || METALS.chrome;
    const tintR = preset.rgb[0] / 255;
    const tintG = preset.rgb[1] / 255;
    const tintB = preset.rgb[2] / 255;

    // Density-estimation bandwidth: rougher metal / wider softness = fuzzier caustic.
    const sharpR = Math.max(1, Math.round(0.5 + state.causticWidth * 1.0 + state.metalRoughness * 45));
    gaussBlur(densityBuf, sharpBuf, W, H, sharpR);

    let maxV = 1e-6;
    for (let i = 0; i < sharpBuf.length; i++) if (sharpBuf[i] > maxV) maxV = sharpBuf[i];
    const invMax = 1 / maxV;

    // Contrast crush: normalized density^gamma leaves the diffuse wash near black and
    // keeps only the tightly-focused cusps. Then bloom ONLY the bright cores so the
    // glow is a hot-cusp halo, not a smeared flood.
    const gamma = 2.6;
    const bloomThresh = 0.4;
    for (let i = 0; i < sharpBuf.length; i++) {
        const nd = sharpBuf[i] * invMax;
        brightBuf[i] = Math.max(0, nd - bloomThresh);
    }
    const bloomR = Math.round(9 + state.causticWidth * 12);
    gaussBlur(brightBuf, bloomBuf, W, H, bloomR);

    const bloomGain = state.causticBloom * 2.0;
    const data = causticImage.data;
    for (let i = 0; i < sharpBuf.length; i++) {
        const nd = sharpBuf[i] * invMax;
        const core = Math.pow(nd, gamma);           // crisp caustic, dark wash
        const I = core + bloomBuf[i] * bloomGain;   // add hot-cusp bloom
        const v = 1 - Math.exp(-I * 1.6);           // soft HDR saturation -> white cusps
        const hot = Math.max(0, (v - 0.75) / 0.25); // hottest cores desaturate to white
        const o = i << 2;
        data[o] = 255 * encodeSRGB(v * (tintR + (1 - tintR) * hot));
        data[o + 1] = 255 * encodeSRGB(v * (tintG + (1 - tintG) * hot));
        data[o + 2] = 255 * encodeSRGB(v * (tintB + (1 - tintB) * hot));
        data[o + 3] = 255;
    }
    causticCtx.putImageData(causticImage, 0, 0);
    causticTexture.needsUpdate = true;
}

function traceCausticBatch(count) {
    const doorCount = Math.floor(count * 0.44);
    const rimCount = count - doorCount;
    for (let i = 0; i < doorCount; i++) {
        sampleDoor(tmpV0, tmpV1);
        traceMetalPhoton(tmpV0, tmpV1, 'door');
    }
    for (let i = 0; i < rimCount; i++) {
        const wheel = wheelGroups[i % wheelGroups.length];
        sampleWheel(wheel, tmpV0, tmpV1);
        traceMetalPhoton(tmpV0, tmpV1, 'rim');
    }
}

// Force the caustic to restart accumulating (call when light / metal / caster geo changes).
function markCausticsDirty() {
    causticDirty = true;
}

// Progressive photon mapping: every frame trace a fresh batch (new seed, never
// reset), ACCUMULATE into densityBuf, and re-resolve. The field converges from
// noisy blobs to sharp cusps over ~2s — exactly like the PT beauty accumulates.
function updateCaustics() {
    if (!densityBuf || !doorMesh || wheelGroups.length === 0) return;

    if (causticDirty) {
        densityBuf.fill(0);
        causticPhotonsAccum = 0;
        causticConverged = false;
        causticDirty = false;
        // Seed from the light so the sequence is reproducible per configuration,
        // but we never re-seed again — each frame advances the RNG so new photons
        // land in new places and the estimate keeps refining.
        rngSeed = (0x51f15e + Math.floor(state.lightRake * 1000) + Math.floor(state.lightHeight * 100)) >>> 0;
    }

    if (!causticConverged) {
        doorMesh.updateMatrixWorld(true);
        for (const wheel of wheelGroups) wheel.updateMatrixWorld(true);
        photonNorm = 1; // brightness handled by resolve auto-exposure over the accumulated buffer
        const batch = Math.min(20000, Math.max(500, state.photonBudget | 0));
        traceCausticBatch(batch);
        causticPhotonsAccum += batch;
        if (causticPhotonsAccum >= CAUSTIC_TARGET_TOTAL) causticConverged = true;
        resolveCaustics();
        causticMaterial.opacity = state.causticStrength;
        photonReadoutEl.textContent = causticConverged
            ? `${causticPhotonsAccum} ✓`
            : String(causticPhotonsAccum);
    }
}

function updateOutput(id, value, precision = 2) {
    const out = document.getElementById(`${id}Value`);
    if (!out) return;
    out.textContent = Number(value).toFixed(precision);
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

function bindControls() {
    bindRange('causticStrength', 'causticStrength', 2, () => {
        if (causticMaterial) causticMaterial.opacity = state.causticStrength;
    });
    // Softness changes the streak footprint (trace) + estimate bandwidth, so restart.
    bindRange('causticWidth', 'causticWidth', 2, markCausticsDirty);
    // Bloom is resolve-only: re-tonemap the already-accumulated buffer immediately.
    bindRange('causticBloom', 'causticBloom', 2, () => resolveCaustics());
    // Photons/frame just changes the accumulation rate; no restart needed.
    bindRange('photonBudget', 'photonBudget', 0);
    bindRange('lightRake', 'lightRake', 2, () => {
        updateLight();
        markCausticsDirty();
    });
    bindRange('lightHeight', 'lightHeight', 2, () => {
        updateLight();
        markCausticsDirty();
    });
    bindRange('metalRoughness', 'metalRoughness', 3, () => {
        chromeMat.roughness = state.metalRoughness;
        chromeMat.needsUpdate = true;
        markCausticsDirty();
    });
    bindRange('exposure', 'exposure', 2, () => {
        renderer.toneMappingExposure = state.exposure;
    });

    document.querySelectorAll('[data-metal]').forEach((button) => {
        button.addEventListener('click', () => applyMetalPreset(button.dataset.metal));
    });

    document.getElementById('resetAccum').addEventListener('click', () => {
        markCausticsDirty();
        setStatus('Rebaking caustic photons...');
    });

    document.getElementById('pauseTrace').addEventListener('click', (event) => {
        causticVisible = !causticVisible;
        event.currentTarget.classList.toggle('active', !causticVisible);
        event.currentTarget.textContent = causticVisible ? 'Hide caustics' : 'Show caustics';
    });
}

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
    if (!navigator.gpu) {
        throw new Error('WebGPU is required for this renderer. Use Chrome/Edge with WebGPU enabled.');
    }

    renderer = new THREE.WebGPURenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = state.exposure;
    viewport.appendChild(renderer.domElement);
    resize();
    await renderer.init();
    backendEl.textContent = 'WebGPU active';
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

    updateCaustics(); // progressively accumulate the photon caustic each frame

    // Fast rasterized beauty (chrome reflects the studio env) + additive caustic overlay.
    renderer.render(scene, camera);
    if (causticVisible && causticMaterial.opacity > 0.001) {
        renderer.autoClear = false;
        renderer.render(overlayScene, camera);
        renderer.autoClear = true;
    }

    frameCounter++;
    if ((frameCounter & 31) === 0) {
        samplesEl.textContent = causticConverged ? 'converged' : 'baking';
    }
}

async function main() {
    bindControls();
    await initRenderer();
    initCamera();
    createScene();
    createOverlay();
    markCausticsDirty(); // first animate frame starts photon accumulation

    const observer = new ResizeObserver(() => resize());
    observer.observe(viewport);

    setStatus('Realtime rasterized beauty + progressive photon caustics. Orbit the camera; the caustic re-bakes when you move the light or metal.');
    renderer.setAnimationLoop(animate);
}

main().catch((error) => {
    console.error(error);
    setStatus(error?.message || String(error), true);
});
