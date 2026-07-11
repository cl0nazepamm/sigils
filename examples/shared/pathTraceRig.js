/**
 * Path-trace beauty mode — progressive spectral path tracing of the committed
 * sigil via speedball-gi/spectral-tracer.
 *
 * The TSL chrome displaces in the vertex shader only, so the tracer traces a
 * BAKED copy of the sigil (heights + normals written into real geometry —
 * the exact GLB-export bake) with a plain MeshStandardMaterial the BVH
 * builder understands. While active the rig owns the frame: render() traces
 * and presents, and the raster meshes stay hidden. The photon rig and this
 * one are mutually exclusive — the modes' onToggle hooks switch one off when
 * the other arms, so only one GPU light-transport engine runs at a time.
 *
 * Accumulation restarts automatically on camera moves; sampleLimit makes it
 * converge-and-stop so an idle traced frame costs zero GPU.
 */

import { createSpectralTracer } from 'speedball-gi/spectral-tracer';
import { bakeChromeGeometryForGlb } from './glbExport.js';
import { PT_ENV_DATA_URI } from './ptEnvMap.js';
import { mountControlPanel, syncControlPanelToState } from './controlPanel.js';
import { setOrthographicLocked } from './unsupportedUi.js';
import { chromeOptionsFromState } from '../../src/index.js';

// SPP limit: converge to this, then hold the frame with no compute.
// envIntensity/envRotation: normalized HDRI strength and azimuth for the traced
// view — synced through the scene environment properties, which the tracer
// reads per frame (no scene rebuild; a change just restarts accumulation).
// envBackground: kernel flag — when false, primary-miss rays return black
// (env still lights chrome via secondary bounces). Off by default.
// Normalized 1 preserves the previous intensity 2 look; normalized 5 reaches 10.
const ENV_INTENSITY_SCALE = 2;
const PT_DEFAULTS = { sampleLimit: 2048, envIntensity: 1, envRotation: 0, envBackground: false };
const PT_CONTROL_SPECS = [
  { type: 'section', label: 'Path trace' },
  { key: 'sampleLimit', label: 'SPP limit', type: 'range', min: 64, max: 8192, step: 64, int: true, live: true },
  { key: 'envIntensity', label: 'HDRI brightness', type: 'range', min: 0, max: 5, step: 0.05, live: true },
  { key: 'envRotation', label: 'HDRI rotation', type: 'range', min: -180, max: 180, step: 1, int: true, live: true },
  { key: 'envBackground', label: 'Background', type: 'check', live: true },
];

// While the camera is in motion every frame resets accumulation anyway, so
// tracing all of them just buys lag: dispatch every 3rd frame and let the
// canvas hold the last present in between. Input stays full-rate; the trace
// costs a third. Detection is a per-frame matrix compare at the tracer's own
// reset epsilon, so full-rate tracing resumes the exact frame motion stops.
const MOTION_TRACE_INTERVAL = 3;
const MOTION_EPSILON = 1e-6; // matches the tracer's CAMERA_MATRIX_EPSILON

/**
 * The raster env is a PMREM cube-UV atlas (RoomEnvironment) — the tracer
 * samples environments as EQUIRECT panoramas (three's equirectUV, v=1 up), so
 * feeding it the atlas shreds the reflections into patchwork. The tracer
 * checks scene.userData.maxjsPathTraceEnvironment first; hand it a procedural
 * studio panorama that reads like the room: dark floor, neutral walls,
 * brighter ceiling, and a few softbox panels for crisp chrome highlights.
 */
function makeStudioEnvTexture(THREE) {
  const W = 512, H = 256;
  const data = new Float32Array(W * H * 4);
  // Chrome reads as metal only when the env has hard luminance structure: a
  // mirror reflecting a smooth gradient is indistinguishable from gray
  // plastic. So: near-black floor with a hard horizon break, a ring of hot
  // rectangular panels with dark gaps between them, and a hot ceiling cap —
  // the same recipe that makes RoomEnvironment flatter metal.
  // Strictly neutral (equal-RGB) panels: any tint here reads as a color cast
  // on the chrome after the spectral round trip, and the user wants D65 white.
  const panels = [];
  for (let k = 0; k < 5; k++) {
    const az = -Math.PI + ((k + 0.5) / 5) * 2 * Math.PI;
    panels.push({
      az, el: 0.28, halfAz: 0.30, halfEl: 0.42,
      gain: k % 2 === 0 ? 13 : 5,
    });
  }
  for (let y = 0; y < H; y++) {
    const el = ((y + 0.5) / H - 0.5) * Math.PI; // -π/2 floor … +π/2 ceiling
    // hard-stepped room bands (tiny blends so they don't alias)
    const floorToWall = Math.min(1, Math.max(0, (el + 0.42) / 0.05));
    const wallToCeil = Math.min(1, Math.max(0, (el - 0.9) / 0.06));
    const base = 0.015 + (0.07 - 0.015) * floorToWall + (0.16 - 0.07) * wallToCeil;
    // hot ceiling cap straight up
    const cap = el > 1.22 ? 15 : 0;
    for (let x = 0; x < W; x++) {
      const az = ((x + 0.5) / W) * 2 * Math.PI - Math.PI;
      let r = base + cap, g = base + cap, b = base + cap;
      for (const p of panels) {
        let dAz = Math.abs(az - p.az);
        dAz = Math.min(dAz, 2 * Math.PI - dAz);
        const edge = 1 - Math.max(dAz / p.halfAz, Math.abs(el - p.el) / p.halfEl);
        if (edge <= 0) continue;
        const s = Math.min(1, edge * 8); // hard panel edge — this IS the metal look
        const add = p.gain * s;
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
  tex.wrapS = THREE.RepeatWrapping; // azimuth seam
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function createPathTraceRig(ctx, {
  sigilMesh = null,   // TSL-displaced sigil to bake for tracing…
  state = null,       // …with its chrome options (bake mode only)
  hasContent = null,  // …or, without a sigilMesh, "is there anything to trace?"
  emptyHint = 'draw a sigil first',
  controlsRoot = null, // Stroke panel — used to lock No perspective while tracing
  onCameraChange = null, // modes keep a local `camera`; notify when we force perspective
  button, panel, getCamera, setStatus, onToggle, signal,
}) {
  const { THREE, renderer, scene, controls, setRasterBackdropHidden, setOrthographicView } = ctx;
  // Bake mode (Drawing): the displaced chrome needs a baked copy.
  // Scene mode (Paint on Mesh): everything is already real geometry with
  // standard materials — the tracer ingests the live scene as-is.
  const usesBake = !!sigilMesh;
  let tracer = null;
  let bakedMesh = null;
  let lastCamera = null;
  let active = false;
  let prevDamping = null;

  // Settings persist across reloads and between Drawing's two tools.
  const PT_STORAGE_KEY = 'sigils.pathtrace.v2';
  const PT_LEGACY_STORAGE_KEY = 'sigils.pathtrace.v1';
  const ptState = { ...PT_DEFAULTS };
  try {
    const currentSaved = JSON.parse(localStorage.getItem(PT_STORAGE_KEY) ?? 'null');
    const legacySaved = currentSaved ? null : JSON.parse(localStorage.getItem(PT_LEGACY_STORAGE_KEY) ?? 'null');
    const saved = currentSaved ?? legacySaved;
    if (saved && typeof saved === 'object') {
      for (const key of Object.keys(PT_DEFAULTS)) {
        if (typeof saved[key] === typeof PT_DEFAULTS[key]) ptState[key] = saved[key];
      }
      // v1 stored the renderer intensity directly. Preserve the same look while
      // moving the control to normalized units (old 2 -> new 1, old 10 -> new 5).
      if (legacySaved && Number.isFinite(legacySaved.envIntensity)) {
        ptState.envIntensity = Math.min(5, Math.max(0, legacySaved.envIntensity / ENV_INTENSITY_SCALE));
      }
    }
  } catch {
    // Best effort — storage may be unavailable (private mode) or corrupt.
  }

  function persistPtState() {
    try {
      localStorage.setItem(PT_STORAGE_KEY, JSON.stringify(ptState));
    } catch {
      // Best effort.
    }
  }

  const ptUi = panel
    ? mountControlPanel(panel, PT_CONTROL_SPECS, ptState, {
        onLive: () => {
          tracer?.setOptions({
            sampleLimit: ptState.sampleLimit,
            envBackground: ptState.envBackground,
          });
          applyEnvironmentSettings();
          persistPtState();
        },
        defaults: { ...PT_DEFAULTS },
        signal,
      })
    : null;
  const lastMatrix = new THREE.Matrix4().makeScale(0, 0, 0); // never matches frame 1
  let motionFrames = 0;

  function cameraMoved(camera) {
    camera.updateMatrixWorld();
    const m = camera.matrixWorld.elements;
    const l = lastMatrix.elements;
    let moved = false;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(m[i] - l[i]) > MOTION_EPSILON) { moved = true; break; }
    }
    lastMatrix.copy(camera.matrixWorld);
    return moved;
  }
  function disposeBaked() {
    if (!bakedMesh) return;
    scene.remove(bakedMesh);
    bakedMesh.geometry.dispose();
    bakedMesh.material.dispose();
    bakedMesh = null;
  }

  /** Drop BVH + accum so the next enable cannot present a stale traced mesh. */
  function dropTracer() {
    if (!tracer) return;
    tracer.dispose();
    tracer = null;
    lastCamera = null;
  }

  /** Make the scene traceable; false when there is nothing to trace yet. */
  function prepare() {
    if (!usesBake) return hasContent ? hasContent() : true;
    return bakeSigil();
  }

  function bakeSigil() {
    disposeBaked();
    const src = sigilMesh.geometry;
    if ((src.getAttribute('position')?.count ?? 0) === 0) return false;
    const chrome = chromeOptionsFromState(state);
    const geometry = bakeChromeGeometryForGlb(src.clone(), chrome);
    const material = new THREE.MeshStandardMaterial({
      color: chrome.color,
      metalness: chrome.metalness ?? 1,
      roughness: chrome.roughness ?? 0, // 0 = true mirror; the kernel handles it

      side: THREE.DoubleSide,
    });
    bakedMesh = new THREE.Mesh(geometry, material);
    bakedMesh.frustumCulled = false;
    scene.add(bakedMesh);
    return true;
  }

  let envTexture = null;
  let prevEnvIntensity = null; // raster value to restore when PT disarms
  let prevEnvRotation = null;

  function applyEnvironmentSettings() {
    if (!active) return;
    scene.environmentIntensity = ptState.envIntensity * ENV_INTENSITY_SCALE;
    scene.environmentRotation.y = THREE.MathUtils.degToRad(ptState.envRotation);
  }

  function ensureTracer() {
    if (tracer) return;
    // Equirect env override for the tracer only — raster keeps its PMREM.
    // Reuse the loaded panorama across drop/recreate so HDRI isn't re-fetched
    // on every sync; only the first arm builds the studio fallback + swap-in.
    if (!envTexture) {
      envTexture = makeStudioEnvTexture(THREE);
      new THREE.TextureLoader().load(PT_ENV_DATA_URI, (tex) => {
        if (signal?.aborted || !envTexture) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace; // LDR decodes on sample
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.RepeatWrapping; // azimuth seam
        tex.wrapT = THREE.ClampToEdgeWrapping;
        envTexture.dispose();
        envTexture = tex;
        scene.userData.maxjsPathTraceEnvironment = envTexture;
        tracer?.markSceneDirty(); // env texture bakes at scene build
      });
    }
    scene.userData.maxjsPathTraceEnvironment = envTexture;
    tracer = createSpectralTracer({
      renderer,
      scene,
      camera: getCamera(),
      enabled: true,
      // envBackground false: primary-miss rays return black — the studio env
      // lights the chrome but is never the visible backdrop. Kernel-side flag
      // (free), not backdrop geometry (which cost real bounce work).
      settings: {
        sampleLimit: ptState.sampleLimit,
        envBackground: ptState.envBackground,
      },
      onStatus: (msg) => setStatus?.(msg),
      onError: (error) => console.error('path tracer', error),
    });
    lastCamera = getCamera();
    tracer.start();
  }

  function forcePerspectiveForTrace() {
    // Ortho PT framing is unreliable — drop to perspective and lock the control.
    if (state && state.orthographic) {
      state.orthographic = false;
      const input = controlsRoot?.querySelector?.('#orthographic');
      if (input) input.checked = false;
      if (typeof setOrthographicView === 'function') {
        const cam = setOrthographicView(false);
        onCameraChange?.(cam);
      }
    }
    setOrthographicLocked(controlsRoot, true);
  }

  function setActive(on) {
    if (on === active) return;
    if (on) {
      if (!prepare()) {
        setStatus?.(emptyHint);
        return;
      }
      forcePerspectiveForTrace();
      setRasterBackdropHidden?.('pathTrace', true);
      // Always start from a fresh tracer: markSceneDirty alone keeps presenting
      // the previous BVH/accum for a frame (or more) while the async rebuild
      // lands — that is the flash of the old mesh after drawing in raster.
      dropTracer();
      ensureTracer();
      // The tracer reads scene.environmentIntensity; park the raster value
      // and environment rotation, then apply the PT sliders for the traced view.
      prevEnvIntensity = scene.environmentIntensity ?? 1;
      prevEnvRotation = scene.environmentRotation.clone();
      scene.environmentIntensity = ptState.envIntensity * ENV_INTENSITY_SCALE;
      scene.environmentRotation.y = THREE.MathUtils.degToRad(ptState.envRotation);
      // Damping's inertia tail keeps nudging the camera above the tracer's
      // reset epsilon for ~a second after release — accumulation restarts
      // look random and the hold starts late. Kill it while tracing:
      // release = stopped that frame = sampling starts that frame.
      prevDamping = controls.enableDamping;
      controls.enableDamping = false;
    } else {
      setOrthographicLocked(controlsRoot, false);
      setRasterBackdropHidden?.('pathTrace', false);
      disposeBaked();
      dropTracer();
      if (prevEnvIntensity !== null) {
        scene.environmentIntensity = prevEnvIntensity;
        prevEnvIntensity = null;
      }
      if (prevEnvRotation !== null) {
        scene.environmentRotation.copy(prevEnvRotation);
        prevEnvRotation = null;
      }
      if (prevDamping !== null) {
        controls.enableDamping = prevDamping;
        prevDamping = null;
      }
    }
    active = on;
    onToggle?.(on);
    button.classList.toggle('active', on);
    button.textContent = on ? 'Raster' : 'Path trace';
    if (panel) panel.hidden = !on;
  }

  button.addEventListener('click', () => setActive(!active), { signal });

  return {
    get active() { return active; },
    /** Enable/disable programmatically (mutual exclusion with the photon rig). */
    setActive,
    /**
     * Hold while the user draws: pause the tracer (zero compute, re-presents
     * the converged frame) so the live raster strip can be composited on top.
     * Idempotent — safe to call every frame with the current drawing state.
     */
    setHold(on) {
      if (!active || !tracer) return;
      tracer.setPaused(on === true);
    },
    /** "Reset all": path-trace settings back to stock defaults, persisted. */
    resetDefaults() {
      Object.assign(ptState, PT_DEFAULTS);
      if (ptUi && panel) syncControlPanelToState(ptUi, ptState, panel);
      tracer?.setOptions({
        sampleLimit: ptState.sampleLimit,
        envBackground: ptState.envBackground,
      });
      applyEnvironmentSettings();
      persistPtState();
    },
    /** Committed content changed: re-prepare (re-bake in bake mode) and restart. */
    syncSigil() {
      if (!active) return;
      if (!prepare()) {
        setActive(false);
        return;
      }
      // Keep the live tracer — dropping it forces a raster fallback frame and
      // flickers while drawing under an active path-trace hold.
      tracer?.markSceneDirty();
    },
    /** Live chrome edits: update the PT bake without rebuilding the sigil field. */
    handleLive(key) {
      if (!active || !bakedMesh) return;
      if (key === 'peak') {
        if (bakeSigil()) tracer?.markSceneDirty();
      } else if (key === 'roughness') {
        bakedMesh.material.roughness = state.roughness ?? 0;
        tracer?.markSceneDirty();
      }
    },
    /**
     * Bracket the raster overlay pass (live strip over the held frame): the
     * baked sigil must not raster-draw over the traced image.
     */
    beginComposite() {
      if (bakedMesh) bakedMesh.visible = false;
    },
    endComposite() {
      if (bakedMesh) bakedMesh.visible = true;
    },
    /** True when the tracer owned this frame (skip the raster render). */
    render() {
      if (!active || !tracer) return false;
      const camera = getCamera();
      if (camera !== lastCamera) {
        lastCamera = camera;
        tracer.setCamera(camera);
      }
      // Only after a fresh arm (dropTracer on setActive) is the scene unbuilt.
      // Fall back to raster until the BVH lands so Raster→draw→PT never shows
      // the previous traced mesh. Do not use this path for in-session syncs.
      if (!tracer.isSceneBuilt()) {
        if (bakedMesh) bakedMesh.visible = false;
        if (sigilMesh) {
          sigilMesh.visible = (sigilMesh.geometry.getAttribute('position')?.count ?? 0) > 0;
        }
        tracer.prebuild();
        return false;
      }
      if (sigilMesh) sigilMesh.visible = false;
      if (bakedMesh) bakedMesh.visible = true;
      if (cameraMoved(camera)) {
        motionFrames++;
        // Skipped motion frame: draw nothing — the canvas holds the last
        // present, and claiming the frame keeps the raster path off it.
        if (motionFrames % MOTION_TRACE_INTERVAL !== 0) return true;
      } else {
        motionFrames = 0;
      }
      return tracer.render();
    },
    samples() {
      return tracer?.getSampleCount() ?? 0;
    },
    dispose() {
      // Inert from here: an async rebuild landing after unmount must not
      // re-bake a zombie mesh into the shared scene via syncSigil().
      active = false;
      setOrthographicLocked(controlsRoot, false);
      setRasterBackdropHidden?.('pathTrace', false);
      disposeBaked();
      dropTracer();
      if (scene.userData.maxjsPathTraceEnvironment === envTexture) {
        delete scene.userData.maxjsPathTraceEnvironment;
      }
      envTexture?.dispose();
      envTexture = null;
      if (prevEnvIntensity !== null) {
        scene.environmentIntensity = prevEnvIntensity;
        prevEnvIntensity = null;
      }
      if (prevEnvRotation !== null) {
        scene.environmentRotation.copy(prevEnvRotation);
        prevEnvRotation = null;
      }
      if (prevDamping !== null) {
        controls.enableDamping = prevDamping;
        prevDamping = null;
      }
    },
  };
}
