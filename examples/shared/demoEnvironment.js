/**
 * Shared viewer environment: RoomEnvironment by default, optional custom HDRI
 * for both raster (PMREM) and path tracing (equirect).
 */

import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { PT_ENV_DATA_URI } from './ptEnvMap.js';

/**
 * Procedural studio fallback used until the embedded PT panorama loads —
 * same recipe as the previous path-trace-only helper.
 */
function makeStudioEnvTexture(THREE) {
  const W = 512;
  const H = 256;
  const data = new Float32Array(W * H * 4);
  const panels = [];
  for (let k = 0; k < 5; k++) {
    const az = -Math.PI + ((k + 0.5) / 5) * 2 * Math.PI;
    panels.push({
      az, el: 0.28, halfAz: 0.30, halfEl: 0.42,
      gain: k % 2 === 0 ? 13 : 5,
    });
  }
  for (let y = 0; y < H; y++) {
    const el = ((y + 0.5) / H - 0.5) * Math.PI;
    const floorToWall = Math.min(1, Math.max(0, (el + 0.42) / 0.05));
    const wallToCeil = Math.min(1, Math.max(0, (el - 0.9) / 0.06));
    const base = 0.015 + (0.07 - 0.015) * floorToWall + (0.16 - 0.07) * wallToCeil;
    const cap = el > 1.22 ? 15 : 0;
    for (let x = 0; x < W; x++) {
      const az = ((x + 0.5) / W) * 2 * Math.PI - Math.PI;
      let r = base + cap;
      let g = base + cap;
      let b = base + cap;
      for (const p of panels) {
        let dAz = Math.abs(az - p.az);
        dAz = Math.min(dAz, 2 * Math.PI - dAz);
        const edge = 1 - Math.max(dAz / p.halfAz, Math.abs(el - p.el) / p.halfEl);
        if (edge <= 0) continue;
        const add = p.gain * Math.min(1, edge * 8);
        r += add;
        g += add;
        b += add;
      }
      const i = (y * W + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  configureEquirect(tex, THREE);
  return tex;
}

function configureEquirect(tex, THREE) {
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
}

async function loadEquirectFile(file, THREE) {
  const url = URL.createObjectURL(file);
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.hdr')) {
      const tex = await new RGBELoader().loadAsync(url);
      configureEquirect(tex, THREE);
      return tex;
    }
    if (name.endsWith('.exr')) {
      const tex = await new EXRLoader().loadAsync(url);
      configureEquirect(tex, THREE);
      return tex;
    }
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    configureEquirect(tex, THREE);
    return tex;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function createDemoEnvironment({ THREE, renderer, scene, pmrem }) {
  const defaultRoom = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = defaultRoom;

  let equirect = null;
  let customPmrem = null;
  let custom = false;
  let defaultUpgradeToken = 0;
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) {
      try { fn({ custom }); } catch (error) {
        console.error('environment listener', error);
      }
    }
  }

  function disposeTex(tex) {
    if (!tex || tex === defaultRoom) return;
    try { tex.dispose?.(); } catch { /* ignore */ }
  }

  function bindPathTraceEnv(tex) {
    if (tex) scene.userData.maxjsPathTraceEnvironment = tex;
    else delete scene.userData.maxjsPathTraceEnvironment;
  }

  /** Equirect used by the spectral tracer (creates the default on first use). */
  function ensurePathTraceEnvironment() {
    if (equirect) {
      bindPathTraceEnv(equirect);
      return equirect;
    }
    equirect = makeStudioEnvTexture(THREE);
    bindPathTraceEnv(equirect);
    const token = ++defaultUpgradeToken;
    new THREE.TextureLoader().load(PT_ENV_DATA_URI, (tex) => {
      if (token !== defaultUpgradeToken || custom) {
        tex.dispose();
        return;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      configureEquirect(tex, THREE);
      disposeTex(equirect);
      equirect = tex;
      bindPathTraceEnv(equirect);
      notify();
    });
    return equirect;
  }

  async function loadFromFile(file) {
    if (!file) throw new Error('No file selected.');
    const tex = await loadEquirectFile(file, THREE);
    defaultUpgradeToken += 1; // cancel in-flight default upgrade
    if (custom) {
      disposeTex(customPmrem);
      disposeTex(equirect);
    } else {
      disposeTex(equirect);
    }
    equirect = tex;
    custom = true;
    customPmrem = pmrem.fromEquirectangular(tex).texture;
    scene.environment = customPmrem;
    bindPathTraceEnv(equirect);
    notify();
    return { name: file.name, custom: true };
  }

  function reset() {
    if (!custom) {
      ensurePathTraceEnvironment();
      return false;
    }
    defaultUpgradeToken += 1;
    disposeTex(customPmrem);
    disposeTex(equirect);
    customPmrem = null;
    equirect = null;
    custom = false;
    scene.environment = defaultRoom;
    bindPathTraceEnv(null);
    ensurePathTraceEnvironment();
    notify();
    return true;
  }

  function dispose() {
    defaultUpgradeToken += 1;
    disposeTex(customPmrem);
    disposeTex(equirect);
    customPmrem = null;
    equirect = null;
    bindPathTraceEnv(null);
    disposeTex(defaultRoom);
    if (scene.environment === defaultRoom) scene.environment = null;
  }

  return {
    get custom() { return custom; },
    ensurePathTraceEnvironment,
    loadFromFile,
    reset,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose,
  };
}
