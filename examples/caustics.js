// caustic_gpu.js — standalone, pure-WebGPU realtime metal-caustic engine.
//
// A separate-project experiment: NO maxjs runtime coupling. The whole photon
// caustic is computed on the GPU with TSL compute passes on THREE.WebGPURenderer
// (r185, vendored). It reproduces the "sharp true metallic caustic" LOOK of the
// CPU web/js/metal_caustic_playground.js bit-for-bit (same energy weighting,
// anisotropic streak deposit, density-estimation blur, auto-exposure, gamma-2.6
// contrast crush, thresholded bloom, tint + HDR tonemap, progressive accumulation)
// but swaps the CPU canvas for a GPU pipeline:
//
//   emit  : one compute thread per photon; samples the analytic metal, reflects
//           off the light, hits the floor, atomic-splats fixed-point energy into
//           a u32 density grid (WGSL has no float atomics -> u32 fixed point).
//   convert: u32 grid -> float density buffer.
//   blur  : separable Gaussian density estimation (crisp cusps).
//   max   : atomicMax reduction of the blurred peak -> auto-exposure.
//   bloom : threshold the bright cores, wide Gaussian -> hot-cusp halo.
//   resolve: gamma crush + bloom + metal tint + HDR tonemap + sRGB -> StorageTexture.
//   overlay: a floor plane samples that StorageTexture, additively over the beauty.
//
// Analytic door/wheel emission is used here so the GPU look can be A/B-validated
// against the CPU original; buildTraversal/buildSpectralScene can later drop in
// to trace real BVH geometry (they are already maxjs-decoupled).

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    Fn, If, Loop, Return, instanceIndex, uniform, storage, textureStore, texture, uv,
    atomicAdd, atomicLoad, atomicMax, atomicStore,
    float, int, uint, vec3, vec4, uvec2,
    select, max, min, abs, sqrt, sin, cos, exp, pow, floor, ceil,
    dot, normalize, reflect, clamp,
} from 'three/tsl';

const PI = Math.PI;
const GRID = 768;                 // caustic grid resolution (matches CPU canvas)
const W = GRID, H = GRID;
const SCALE = 256.0;              // fixed-point scale for atomic energy deposit
const MAXSCALE = 64.0;            // fixed-point scale for the atomicMax auto-exposure
const U32_MAX = 4.2e9;           // clamp ceiling below 2^32 to avoid atomic wrap
const CAUSTIC_TARGET_TOTAL = 3_000_000; // photons accumulated before "converged"

const FLOOR = { width: 9, depth: 7, minX: -4.5, maxX: 4.5, minZ: -3.5, maxZ: 3.5 };

const METALS = {
    chrome: { hex: 0xf4f8ff, rgb: [238, 247, 255], roughness: 0.035 },
    gold: { hex: 0xffc45a, rgb: [255, 208, 105], roughness: 0.045 },
    copper: { hex: 0xff8f61, rgb: [255, 158, 105], roughness: 0.055 },
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
let caustic = null;              // GPU pipeline handle
let causticDirty = true;
let causticPhotonsAccum = 0;
let causticConverged = false;
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
}

// ── GPU caustic pipeline ─────────────────────────────────────────────
function makeStorage(array) { return new THREE.StorageBufferAttribute(array, 1); }

function buildCaustic() {
    const cells = W * H;

    // storage buffers
    const grid = storage(makeStorage(new Uint32Array(cells)), 'uint', cells).toAtomic();
    const maxB = storage(makeStorage(new Uint32Array(1)), 'uint', 1).toAtomic();
    const densF = storage(makeStorage(new Float32Array(cells)), 'float', cells);
    const tmpB = storage(makeStorage(new Float32Array(cells)), 'float', cells);
    const sharpB = storage(makeStorage(new Float32Array(cells)), 'float', cells);
    const brightB = storage(makeStorage(new Float32Array(cells)), 'float', cells);
    const bloomB = storage(makeStorage(new Float32Array(cells)), 'float', cells);

    // output storage texture (compute-writable + sampler-readable, no readback).
    // RGBA16F: storage-capable + HDR. sRGB formats are NOT storage-capable in
    // WebGPU, so we keep it LINEAR and store linear values directly (the CPU's
    // sRGB encode->decode round-trip nets out to the same linear contribution).
    const causticTex = new THREE.StorageTexture(W, H);
    causticTex.format = THREE.RGBAFormat;
    causticTex.type = THREE.HalfFloatType;
    causticTex.colorSpace = THREE.NoColorSpace;

    const U = {
        frameSeed: uniform(1, 'uint'),
        lightPos: uniform(new THREE.Vector3(state.lightRake, state.lightHeight, -1.45)),
        doorMat: uniform(new THREE.Matrix4()),
        wheel0Mat: uniform(new THREE.Matrix4()),
        wheel1Mat: uniform(new THREE.Matrix4()),
        metalRoughness: uniform(state.metalRoughness),
        causticWidth: uniform(state.causticWidth),
        sharpSigma: uniform(1.0),
        bloomSigma: uniform(12.0),
        bloomGain: uniform(state.causticBloom * 2.0),
        tint: uniform(new THREE.Vector3(1, 1, 1)),
    };

    const INV_U32 = 1.0 / 4294967296.0;
    const pcgHash = (x) => {
        const st = x.mul(uint(747796405)).add(uint(2891336453));
        const word = st.shiftRight(st.shiftRight(uint(28)).add(uint(4))).bitXor(st).mul(uint(277803737));
        return word.shiftRight(uint(22)).bitXor(word);
    };
    const rngState = { node: null };
    const nextRand = () => {
        const s = rngState.node;
        const ns = s.mul(uint(747796405)).add(uint(2891336453));
        s.assign(ns);
        const word = ns.shiftRight(ns.shiftRight(uint(28)).add(uint(4))).bitXor(ns).mul(uint(277803737));
        const res = word.shiftRight(uint(22)).bitXor(word);
        return float(res).mul(INV_U32);
    };

    // bilinear 4-tap atomic deposit
    const addTap = (ix, iy, amt) => {
        const inb = ix.greaterThanEqual(int(0)).and(ix.lessThan(int(W)))
            .and(iy.greaterThanEqual(int(0))).and(iy.lessThan(int(H)));
        If(inb, () => {
            const cell = uint(iy).mul(uint(W)).add(uint(ix));
            const q = uint(clamp(amt.mul(float(SCALE)), float(0), float(U32_MAX)));
            atomicAdd(grid.element(cell), q);
        });
    };

    function buildEmit(count) {
        return Fn(() => {
            const pid = instanceIndex.toVar();
            If(pid.greaterThanEqual(uint(count)), () => { Return(); });
            rngState.node = pcgHash(pid.bitXor(pcgHash(U.frameSeed))).toVar();

            const pick = nextRand();
            const wp = vec3(0, 0, 0).toVar();
            const wn = vec3(0, 0, 1).toVar();
            const sourceGain = float(1).toVar();

            // 44% door
            If(pick.lessThan(float(0.44)), () => {
                const u = nextRand(); const v = nextRand();
                const x = u.mul(2).sub(1).mul(2.7);
                const y = v.mul(2).sub(1).mul(0.86);
                const arg = x.mul(2.25).add(y.mul(0.55));
                const shoulderAng = x.div(2.7).mul(PI * 0.5);
                const shoulder = cos(shoulderAng).mul(0.18);
                const crease = sin(arg).mul(0.035);
                const crown = x.mul(x).mul(0.05);
                const z = shoulder.add(crease).add(crown);
                const CREASE = 0.12;
                const dzdx = sin(shoulderAng).mul(-(PI * 0.5 / 2.7) * 0.18)
                    .add(cos(arg).mul(2.25 * 0.035 * CREASE)).add(x.mul(0.1));
                const dzdy = cos(arg).mul(0.55 * 0.035 * CREASE);
                const lp = vec3(x, y, z);
                const ln = normalize(vec3(dzdx.mul(-1), dzdy.mul(-1), float(1)));
                wp.assign(U.doorMat.mul(vec4(lp, 1)).xyz);
                wn.assign(normalize(U.doorMat.mul(vec4(ln, 0)).xyz));
            });
            // 56% wheels
            If(pick.greaterThanEqual(float(0.44)), () => {
                const major = select(nextRand().lessThan(float(0.72)), float(0.56), float(0.31));
                const minor = select(major.greaterThan(float(0.4)), float(0.072), float(0.035));
                const theta = nextRand().mul(2 * PI);
                const phi = nextRand().mul(2 * PI);
                const tube = major.add(minor.mul(cos(phi)));
                const lp = vec3(tube.mul(cos(theta)), tube.mul(sin(theta)), minor.mul(sin(phi)));
                const ln = normalize(vec3(cos(phi).mul(cos(theta)), cos(phi).mul(sin(theta)), sin(phi)));
                const which = nextRand();
                If(which.lessThan(float(0.5)), () => {
                    wp.assign(U.wheel0Mat.mul(vec4(lp, 1)).xyz);
                    wn.assign(normalize(U.wheel0Mat.mul(vec4(ln, 0)).xyz));
                });
                If(which.greaterThanEqual(float(0.5)), () => {
                    wp.assign(U.wheel1Mat.mul(vec4(lp, 1)).xyz);
                    wn.assign(normalize(U.wheel1Mat.mul(vec4(ln, 0)).xyz));
                });
                sourceGain.assign(float(1.55));
            });

            // reflect off metal, hit the floor plane
            const toP = wp.sub(U.lightPos);
            const distSq = max(float(0.5), dot(toP, toP));
            const incident = normalize(toP);
            const ndl = max(float(0), dot(incident, wn).mul(-1));
            If(ndl.lessThanEqual(float(0.0001)), () => { Return(); });
            const reflected = normalize(reflect(incident, wn));
            If(reflected.y.greaterThanEqual(float(-0.012)), () => { Return(); });
            const t = wp.y.mul(-1).div(reflected.y);
            If(t.lessThanEqual(float(0)), () => { Return(); });
            If(t.greaterThan(float(24)), () => { Return(); });
            const hit = wp.add(reflected.mul(t));
            If(hit.x.lessThan(float(FLOOR.minX)), () => { Return(); });
            If(hit.x.greaterThan(float(FLOOR.maxX)), () => { Return(); });
            If(hit.z.lessThan(float(FLOOR.minZ)), () => { Return(); });
            If(hit.z.greaterThan(float(FLOOR.maxZ)), () => { Return(); });

            const grazing = float(1).sub(min(float(1), abs(reflected.y)));
            const grazeGain = float(0.55).add(grazing.mul(1.5));
            const roughPenalty = max(float(0.12), float(1).sub(U.metalRoughness.mul(5.5)));
            const energy = ndl.mul(roughPenalty).mul(sourceGain).mul(grazeGain).mul(float(8).div(distSq));

            const cx = hit.x.sub(FLOOR.minX).div(FLOOR.width).mul(float(W));
            const cy = float(1).sub(hit.z.sub(FLOOR.minZ).div(FLOOR.depth)).mul(float(H));
            const cdx0 = reflected.x.mul(W / FLOOR.width);
            const cdy0 = reflected.z.mul(-1).mul(H / FLOOR.depth);
            const clen = max(sqrt(cdx0.mul(cdx0).add(cdy0.mul(cdy0))), float(1e-6));
            const cdx = cdx0.div(clen);
            const cdy = cdy0.div(clen);
            const streakPx = min(float(18), float(2).add(grazing.mul(15)).mul(U.causticWidth));
            const steps = uint(max(float(1), ceil(streakPx)));
            const stepsF = float(steps);
            const ePer = energy.div(stepsF);

            Loop({ start: uint(0), end: steps, type: 'uint', condition: '<' }, ({ i: s }) => {
                const tt = select(steps.equal(uint(1)), float(0),
                    float(s).div(max(stepsF.sub(1), float(1))).sub(0.5));
                const fx = cx.add(cdx.mul(streakPx).mul(tt)).sub(0.5);
                const fy = cy.add(cdy.mul(streakPx).mul(tt)).sub(0.5);
                const x0 = int(floor(fx));
                const y0 = int(floor(fy));
                const txf = fx.sub(float(x0));
                const tyf = fy.sub(float(y0));
                addTap(x0, y0, ePer.mul(float(1).sub(txf)).mul(float(1).sub(tyf)));
                addTap(x0.add(int(1)), y0, ePer.mul(txf).mul(float(1).sub(tyf)));
                addTap(x0, y0.add(int(1)), ePer.mul(float(1).sub(txf)).mul(tyf));
                addTap(x0.add(int(1)), y0.add(int(1)), ePer.mul(txf).mul(tyf));
            });
        })().compute(count);
    }

    const clearGrid = Fn(() => {
        const idx = instanceIndex.toVar();
        If(idx.greaterThanEqual(uint(cells)), () => { Return(); });
        atomicStore(grid.element(idx), uint(0));
    })().compute(cells);

    const convert = Fn(() => {
        const idx = instanceIndex.toVar();
        If(idx.greaterThanEqual(uint(cells)), () => { Return(); });
        densF.element(idx).assign(float(atomicLoad(grid.element(idx))).div(float(SCALE)));
    })().compute(cells);

    const makeBlur = (src, dst, horizontal, sigmaU) => Fn(() => {
        const idx = instanceIndex.toVar();
        If(idx.greaterThanEqual(uint(cells)), () => { Return(); });
        const x = int(idx.mod(uint(W)));
        const y = int(idx.div(uint(W)));
        const sigma = max(sigmaU, float(0.35));
        const R = int(clamp(ceil(sigma.mul(3)), float(1), float(64)));
        const inv2s2 = float(-0.5).div(sigma.mul(sigma));
        const span = R.mul(int(2)).add(int(1));
        const sum = float(0).toVar();
        const wsum = float(0).toVar();
        Loop({ start: uint(0), end: uint(span), type: 'uint', condition: '<' }, ({ i: tstep }) => {
            const k = int(tstep).sub(R);
            const w = exp(float(k).mul(float(k)).mul(inv2s2));
            const sx = horizontal ? clamp(x.add(k), int(0), int(W - 1)) : x;
            const sy = horizontal ? y : clamp(y.add(k), int(0), int(H - 1));
            const sidx = uint(sy).mul(uint(W)).add(uint(sx));
            sum.addAssign(src.element(sidx).mul(w));
            wsum.addAssign(w);
        });
        dst.element(idx).assign(sum.div(max(wsum, float(1e-6))));
    })().compute(cells);

    const sharpH = makeBlur(densF, tmpB, true, U.sharpSigma);
    const sharpV = makeBlur(tmpB, sharpB, false, U.sharpSigma);
    const bloomH = makeBlur(brightB, tmpB, true, U.bloomSigma);
    const bloomV = makeBlur(tmpB, bloomB, false, U.bloomSigma);

    const clearMax = Fn(() => { atomicStore(maxB.element(uint(0)), uint(0)); })().compute(1);

    const reduceMax = Fn(() => {
        const idx = instanceIndex.toVar();
        If(idx.greaterThanEqual(uint(cells)), () => { Return(); });
        const q = uint(clamp(sharpB.element(idx).mul(float(MAXSCALE)), float(0), float(U32_MAX)));
        atomicMax(maxB.element(uint(0)), q);
    })().compute(cells);

    const threshold = Fn(() => {
        const idx = instanceIndex.toVar();
        If(idx.greaterThanEqual(uint(cells)), () => { Return(); });
        const invMax = float(MAXSCALE).div(max(float(atomicLoad(maxB.element(uint(0)))), float(1)));
        const nd = sharpB.element(idx).mul(invMax);
        brightB.element(idx).assign(max(float(0), nd.sub(float(0.4))));
    })().compute(cells);

    const resolve = Fn(() => {
        const idx = instanceIndex.toVar();
        If(idx.greaterThanEqual(uint(cells)), () => { Return(); });
        const px = idx.mod(uint(W));
        const py = idx.div(uint(W));
        const invMax = float(MAXSCALE).div(max(float(atomicLoad(maxB.element(uint(0)))), float(1)));
        const nd = max(sharpB.element(idx).mul(invMax), float(0));
        const core = pow(nd, float(2.6));
        const I = core.add(bloomB.element(idx).mul(U.bloomGain));
        const v = float(1).sub(exp(I.mul(-1.6)));
        const hot = max(float(0), v.sub(float(0.75)).div(float(0.25)));
        const rr = v.mul(U.tint.x.add(float(1).sub(U.tint.x).mul(hot)));
        const gg = v.mul(U.tint.y.add(float(1).sub(U.tint.y).mul(hot)));
        const bb = v.mul(U.tint.z.add(float(1).sub(U.tint.z).mul(hot)));
        textureStore(causticTex, uvec2(px, py), vec4(rr, gg, bb, float(1)));
    })().compute(cells);

    // overlay plane samples the storage texture, additive over the beauty
    const overlayMat = new THREE.MeshBasicNodeMaterial();
    overlayMat.colorNode = texture(causticTex, uv());
    overlayMat.transparent = true;
    overlayMat.blending = THREE.AdditiveBlending;
    overlayMat.depthTest = false;
    overlayMat.depthWrite = false;
    overlayMat.toneMapped = false;
    overlayMat.opacity = state.causticStrength;
    const overlayMesh = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR.width, FLOOR.depth), overlayMat);
    overlayMesh.rotation.x = -Math.PI / 2;
    overlayMesh.position.y = 0.012;
    overlayMesh.renderOrder = 1000;

    // static caster matrices
    U.doorMat.value.copy(doorMesh.matrixWorld);
    U.wheel0Mat.value.copy(wheelGroups[0].matrixWorld);
    U.wheel1Mat.value.copy(wheelGroups[1].matrixWorld);

    return {
        U, causticTex, overlayMat, overlayMesh,
        passes: { clearGrid, convert, sharpH, sharpV, clearMax, reduceMax, threshold, bloomH, bloomV, resolve },
        buildEmit,
        emit: null,
        emitCount: 0,
    };
}

function ensureEmit(count) {
    if (caustic.emitCount !== count) {
        caustic.emit = caustic.buildEmit(count);
        caustic.emitCount = count;
    }
    return caustic.emit;
}

function syncCausticUniforms() {
    const U = caustic.U;
    U.lightPos.value.set(state.lightRake, state.lightHeight, -1.45);
    U.metalRoughness.value = state.metalRoughness;
    U.causticWidth.value = state.causticWidth;
    U.sharpSigma.value = Math.max(0.5, 0.5 + state.causticWidth + state.metalRoughness * 45);
    U.bloomSigma.value = 9 + state.causticWidth * 12;
    U.bloomGain.value = state.causticBloom * 2.0;
    const rgb = (METALS[state.metal] || METALS.chrome).rgb;
    U.tint.value.set(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
}

function markCausticsDirty() { causticDirty = true; }

function updateCaustics() {
    if (!caustic) return;
    const P = caustic.passes;

    if (causticDirty) {
        renderer.compute(P.clearGrid);
        causticPhotonsAccum = 0;
        causticConverged = false;
        causticDirty = false;
        caustic.U.frameSeed.value = (0x51f15e + Math.floor(state.lightRake * 1000) + Math.floor(state.lightHeight * 100)) >>> 0;
    }
    if (causticConverged) return;

    const batch = Math.max(1000, state.photonBudget | 0);
    const emit = ensureEmit(batch);
    caustic.U.frameSeed.value = (caustic.U.frameSeed.value + 1) >>> 0;

    renderer.compute(emit);
    renderer.compute(P.convert);
    renderer.compute(P.sharpH);
    renderer.compute(P.sharpV);
    renderer.compute(P.clearMax);
    renderer.compute(P.reduceMax);
    renderer.compute(P.threshold);
    renderer.compute(P.bloomH);
    renderer.compute(P.bloomV);
    renderer.compute(P.resolve);

    causticPhotonsAccum += batch;
    if (causticPhotonsAccum >= CAUSTIC_TARGET_TOTAL) causticConverged = true;
    photonReadoutEl.textContent = causticConverged ? `${causticPhotonsAccum} ✓` : String(causticPhotonsAccum);
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
    syncCausticUniforms();
    markCausticsDirty();
}

function bindControls() {
    bindRange('causticStrength', 'causticStrength', 2, () => {
        if (caustic) caustic.overlayMat.opacity = state.causticStrength;
    });
    bindRange('causticWidth', 'causticWidth', 2, () => { syncCausticUniforms(); markCausticsDirty(); });
    bindRange('causticBloom', 'causticBloom', 2, () => {
        syncCausticUniforms();
        if (caustic && causticConverged) renderer.compute(caustic.passes.resolve); // re-tonemap held frame
    });
    bindRange('photonBudget', 'photonBudget', 0);
    bindRange('lightRake', 'lightRake', 2, () => { updateLight(); syncCausticUniforms(); markCausticsDirty(); });
    bindRange('lightHeight', 'lightHeight', 2, () => { updateLight(); syncCausticUniforms(); markCausticsDirty(); });
    bindRange('metalRoughness', 'metalRoughness', 3, () => {
        chromeMat.roughness = state.metalRoughness; chromeMat.needsUpdate = true;
        syncCausticUniforms(); markCausticsDirty();
    });
    bindRange('exposure', 'exposure', 2, () => { renderer.toneMappingExposure = state.exposure; });

    document.querySelectorAll('[data-metal]').forEach((button) => {
        button.addEventListener('click', () => applyMetalPreset(button.dataset.metal));
    });
    document.getElementById('resetAccum').addEventListener('click', () => {
        markCausticsDirty();
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
    updateCaustics();
    renderer.render(scene, camera);
    if (causticVisible && caustic && caustic.overlayMat.opacity > 0.001) {
        renderer.autoClear = false;
        renderer.render(overlayScene, camera);
        renderer.autoClear = true;
    }
    frameCounter++;
    if ((frameCounter & 31) === 0) samplesEl.textContent = causticConverged ? 'converged' : 'baking';
}

async function main() {
    bindControls();
    await initRenderer();
    initCamera();
    createScene();

    caustic = buildCaustic();
    syncCausticUniforms();
    overlayScene = new THREE.Scene();
    overlayScene.add(caustic.overlayMesh);
    markCausticsDirty();

    // Benchmark hook: drive the compute chain directly and force a GPU sync so
    // timing is independent of background-tab rAF throttling.
    window.__causticBench = async (batch = 500000, iters = 40) => {
        const P = caustic.passes;
        const emit = ensureEmit(batch);
        renderer.compute(P.clearGrid);
        const t0 = performance.now();
        for (let i = 0; i < iters; i++) {
            caustic.U.frameSeed.value = (caustic.U.frameSeed.value + 1) >>> 0;
            renderer.compute(emit);
            renderer.compute(P.convert);
            renderer.compute(P.sharpH); renderer.compute(P.sharpV);
            renderer.compute(P.clearMax); renderer.compute(P.reduceMax);
            renderer.compute(P.threshold);
            renderer.compute(P.bloomH); renderer.compute(P.bloomV);
        }
        await renderer.computeAsync(P.resolve); // block until all queued GPU work drains
        const dt = performance.now() - t0;
        return { batch, iters, msPerFrame: +(dt / iters).toFixed(2), fps: Math.round(1000 / (dt / iters)) };
    };

    const observer = new ResizeObserver(() => resize());
    observer.observe(viewport);

    setStatus('Pure-WebGPU compute caustics. Orbit the camera; the caustic re-bakes on the GPU when you move the light or metal.');
    renderer.setAnimationLoop(animate);
}

main().catch((error) => {
    console.error(error);
    setStatus(error?.message || String(error), true);
});
