/**
 * Photon trace rig — GPU caustics thrown off a committed sigil mesh onto a black
 * backdrop wall behind it. Shared by Drawing's freehand and CV tools, which
 * hand the rig their committed `sigilMesh` and drive the lifecycle hooks below.
 *
 * The emitter casts photons off the real 3D sigil (speedball-gi/caustics); the
 * receiver is a flat analytic wall at z=WALL.z. The sigil is drawn on the z=0
 * plane facing +Z, so reflected photons travel toward -Z — a floor under the
 * sigil caught almost nothing, hence a wall behind it. Wall distance sets the
 * throw: landings scale with the sigil->wall gap, so a close wall keeps the
 * photons hugging the silhouette.
 */

import { createCausticEngine, causticReceiverWall } from 'speedball-gi/caustics';
import { sigilCasterShaper } from './sigilCasterShaper.js';
import { mountControlPanel, syncControlPanelToState } from './controlPanel.js';

const WALL = { z: -0.5, y: 0, width: 16, height: 9 };
const CAUSTIC_GRID = 1536;

// The photon light lives on a sphere around the sigil's centre: orbit swings it
// across the front, lift raises it, range pulls it away. Opacity drives both the
// caustic strength and the key light so the backdrop follows the beam. Defaults
// rake the light from the side: a head-on light reflects FORWARD off the sigil
// (away from the back wall) — only steep slopes and stroke side walls throw
// photons backward, so grazing angles are what read on the wall.
const BLOOM = 0.25; // fixed on purpose — no slider

const PHOTON_DEFAULTS = {
  lightOrbit: 58, lightLift: 10, lightRange: 3.4,
  reach: 4, opacity: 4, beamWidth: 0.7,
  followCamera: true,
};
const PHOTON_CONTROL_SPECS = [
  { type: 'section', label: 'Photon light' },
  { key: 'followCamera', label: 'Cam lock', type: 'check', live: true },
  { key: 'lightOrbit', label: 'Orbit', type: 'range', min: -80, max: 80, step: 1, int: true, live: true },
  { key: 'lightLift', label: 'Lift', type: 'range', min: -8, max: 70, step: 1, int: true, live: true },
  { key: 'lightRange', label: 'Range', type: 'range', min: 1.8, max: 6, step: 0.05, live: true },
  { key: 'reach', label: 'Reach', type: 'range', min: 0.3, max: 6, step: 0.05, live: true },
  { key: 'opacity', label: 'Opacity', type: 'range', min: 0, max: 6, step: 0.05, live: true },
  { key: 'beamWidth', label: 'Width', type: 'range', min: 0.15, max: 2, step: 0.05, live: true },
];

/**
 * @param {object}      ctx       demo context ({ THREE, renderer, scene })
 * @param {object}      opts
 * @param {THREE.Mesh}  opts.sigilMesh  committed sigil mesh photons cast off
 * @param {object}      opts.state      draw state (reads `roughness`)
 * @param {HTMLElement} opts.button     the "Photon trace" toggle button
 * @param {HTMLElement} opts.panel      container the photon control panel mounts into
 * @param {() => THREE.Camera} opts.getCamera  live camera accessor (for Cam lock)
 * @param {(msg: string) => void} [opts.setStatus] status-line setter for hints
 * @param {(on: boolean) => void} [opts.onToggle]  fires after every arm/disarm (mutual exclusion hook)
 * @param {AbortSignal} opts.signal     tears down listeners on unmount
 * @returns rig handle with lifecycle hooks (see below)
 */
export function createPhotonRig(ctx, { sigilMesh, state, button, panel, getCamera, setStatus, signal, onToggle }) {
  const { THREE, renderer, scene, setRasterBackdropHidden } = ctx;
  let caustic = null, causticWall = null, keyLight = null, active = false;

  // Photon settings persist across reloads and between Drawing's two tools.
  const PHOTON_STORAGE_KEY = 'sigils.photon.v1';
  const photonState = { ...PHOTON_DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(PHOTON_STORAGE_KEY) ?? 'null');
    if (saved && typeof saved === 'object') {
      for (const key of Object.keys(PHOTON_DEFAULTS)) {
        if (typeof saved[key] === typeof PHOTON_DEFAULTS[key]) photonState[key] = saved[key];
      }
    }
  } catch {
    // Best effort — storage may be unavailable (private mode) or corrupt.
  }

  function persistPhotonState() {
    try {
      localStorage.setItem(PHOTON_STORAGE_KEY, JSON.stringify(photonState));
    } catch {
      // Best effort.
    }
  }

  const photonUi = mountControlPanel(panel, PHOTON_CONTROL_SPECS, photonState, {
    onLive: () => {
      // Any live edit can change the locked placement (orbit/lift/range are
      // view-relative under Cam lock) — invalidate so the next update re-sends.
      lastCamPos.set(Infinity, Infinity, Infinity);
      applyPhotonState();
      persistPhotonState();
    },
    defaults: { ...PHOTON_DEFAULTS },
    signal,
  });

  function applyPhotonState() {
    if (!caustic) return;
    if (!photonState.followCamera) {
      const az = THREE.MathUtils.degToRad(photonState.lightOrbit);
      const el = THREE.MathUtils.degToRad(photonState.lightLift);
      const r = photonState.lightRange;
      const x = Math.sin(az) * Math.cos(el) * r;
      const y = Math.sin(el) * r;
      const z = Math.cos(az) * Math.cos(el) * r; // always in front of the sigil
      caustic.setLight(x, y, z);
      keyLight.position.set(x, y, z);
    }
    caustic.setStrength(photonState.opacity);
    caustic.setSoftness(photonState.beamWidth);
    caustic.setBloom(BLOOM);
    // Reach = throw distance (world units) where a photon's weight halves;
    // photons landing much farther than the reach fade out instead of smearing.
    caustic.setThrowFalloff(1 / (photonState.reach * photonState.reach));
    keyLight.intensity = 12 * photonState.opacity;
  }

  // Cam lock: the light is constrained to the camera RIG — position + lookAt —
  // not glued to the lens. The orbit/lift caustic angles are re-applied in the
  // camera's frame around its look-at target, so the blast keeps its raking
  // angle while it follows the view. (A light exactly ON the camera is the
  // degenerate head-on case: photons reflect forward, away from the wall, and
  // the caustic all but vanishes.) Only push when the rig actually moved —
  // every setLight() restarts the accumulation, and OrbitControls damping
  // micro-motion would otherwise pin it at frame zero forever.
  const lastCamPos = new THREE.Vector3(Infinity, Infinity, Infinity);
  const lastCamTarget = new THREE.Vector3(Infinity, Infinity, Infinity);
  const camFwd = new THREE.Vector3();   // target -> camera (the "front" axis)
  const camRight = new THREE.Vector3();
  const camUp = new THREE.Vector3();
  const lightPos = new THREE.Vector3();
  function followCameraLight() {
    if (!photonState.followCamera || !caustic || !keyLight) return;
    const camera = getCamera?.();
    if (!camera) return;
    const target = ctx.controls.target;
    if (
      lastCamPos.distanceToSquared(camera.position) < 1e-6 &&
      lastCamTarget.distanceToSquared(target) < 1e-6
    ) return;
    lastCamPos.copy(camera.position);
    lastCamTarget.copy(target);

    // View basis around the look-at target. With the camera at home on +Z this
    // matches the unlocked world-space placement exactly.
    camFwd.subVectors(camera.position, target);
    if (camFwd.lengthSq() < 1e-8) camFwd.set(0, 0, 1);
    else camFwd.normalize();
    camRight.crossVectors(camera.up, camFwd);
    if (camRight.lengthSq() < 1e-8) camRight.set(1, 0, 0);
    else camRight.normalize();
    camUp.crossVectors(camFwd, camRight);

    const az = THREE.MathUtils.degToRad(photonState.lightOrbit);
    const el = THREE.MathUtils.degToRad(photonState.lightLift);
    const r = photonState.lightRange;
    lightPos.copy(target)
      .addScaledVector(camRight, Math.sin(az) * Math.cos(el) * r)
      .addScaledVector(camUp, Math.sin(el) * r)
      .addScaledVector(camFwd, Math.cos(az) * Math.cos(el) * r);
    keyLight.position.copy(lightPos);
    caustic.setLight(lightPos.x, lightPos.y, lightPos.z);
  }

  function ensureRig() {
    if (caustic) return;
    caustic = createCausticEngine({
      THREE, renderer,
      // A denser accumulation grid plus a tighter invisible receiver gives
      // roughly 3x the old wall-space texel density. The receiver still spans
      // well beyond the default view, while avoiding the 4x pass cost of 2048.
      grid: CAUSTIC_GRID,
      // Photon count is independent of the wall size: landings concentrate in
      // the throw footprint near the sigil, so the wall is just canvas. 200M
      // total (vs the engine's 3M default) is what makes the beam read dense
      // and smooth; emit is sub-ms per frame. Fixed-point headroom is fine —
      // the u32 grid saturates around ~1e9 photons into one hot cell.
      targetPhotons: 200_000_000,
      receiver: causticReceiverWall({ z: WALL.z, y: WALL.y, width: WALL.width, height: WALL.height }),
    });
    caustic.setRoughness(state.roughness);
    caustic.setPhotonBudget(2_000_000);
    // The wall sits behind the sigil in view: keep the additive overlay
    // depth-tested so the sigil occludes it instead of the caustic glowing through.
    caustic.overlayMesh.material.depthTest = true;
    caustic.overlayMesh.visible = false; // renderOrder 1000 -> composites last in-scene
    scene.add(caustic.overlayMesh);

    // Unlit pure black: the wall is a canvas for the additive caustic overlay,
    // not a lit surface — env/key light must not wash it grey.
    causticWall = new THREE.Mesh(
      new THREE.PlaneGeometry(WALL.width, WALL.height),
      new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide }),
    );
    causticWall.position.set(0, WALL.y, WALL.z - 0.01);
    causticWall.visible = false;
    scene.add(causticWall);

    keyLight = new THREE.PointLight(0xffffff, 40, 40, 1.4);
    keyLight.visible = false;
    scene.add(keyLight);

    applyPhotonState();
    if (typeof window !== 'undefined') { window.__caustic = caustic; window.__keyLight = keyLight; window.__causticWall = causticWall; }
  }

  function hasCaster() {
    return (sigilMesh.geometry.getAttribute('position')?.count ?? 0) > 0;
  }

  function uploadCaster() {
    if (!caustic || !hasCaster()) return false;
    sigilMesh.updateMatrixWorld(true);
    // The shaper bakes the TSL height displacement into photon emission so
    // photons leave the same surface the chrome material renders.
    caustic.setCasterMesh(sigilMesh, { shaper: sigilCasterShaper(sigilMesh) });
    caustic.markDirty();
    return true;
  }

  // Photon stays ARMED across a clear (`active` = user intent from the button)
  // but the rig only shows when there is a committed sigil to cast off, so
  // clearing leaves a clean black wall rather than a ghost caustic.
  function refreshVisuals() {
    if (!caustic) return;
    const show = active && hasCaster();
    caustic.overlayMesh.visible = causticWall.visible = keyLight.visible = show;
  }

  function setActive(on) {
    if (on) {
      // Arm even without a committed sigil, but create the engine LAZILY —
      // no GPU buffers or compute until there is actually a caster to shoot.
      if (hasCaster()) {
        ensureRig();
        uploadCaster();
      } else {
        setStatus?.('draw a sigil to throw the blast');
      }
    }
    active = on;
    setRasterBackdropHidden?.('photonTrace', on);
    refreshVisuals();
    panel.hidden = !on;
    button.classList.toggle('active', on);
    button.textContent = on ? 'Photon off' : 'Photon trace';
    onToggle?.(on);
  }

  button.addEventListener('click', () => setActive(!active), { signal });
  setActive(false); // launch disarmed — the blast is opt-in via the button

  return {
    get active() { return active; },
    /** Arm/disarm programmatically (mutual exclusion with the path tracer). */
    setActive,
    /** "Reset all": photon settings back to the stock defaults, persisted. */
    resetDefaults() {
      Object.assign(photonState, PHOTON_DEFAULTS);
      syncControlPanelToState(photonUi, photonState, panel);
      lastCamPos.set(Infinity, Infinity, Infinity);
      applyPhotonState();
      persistPhotonState();
    },
    /** Re-bake the caster if armed (no-op when no committed geometry). */
    refreshCaster() { if (active) uploadCaster(); },
    /** After the committed sigil geometry changes: re-bake + show/hide to match. */
    syncCaster() {
      if (active && !caustic && hasCaster()) ensureRig(); // armed-before-drawn: engine starts here
      if (active) uploadCaster();
      refreshVisuals();
    },
    /** Route a live control edit: peak re-bakes the caster, roughness retints. */
    handleLive(key) {
      if (!active || !caustic) return;
      if (key === 'peak') uploadCaster();
      else if (key === 'roughness') caustic.setRoughness(state.roughness);
    },
    /** GPU compute passes; call once per frame before rendering the scene. */
    update() {
      if (!active || !caustic) return;
      // Hidden rig (armed but no caster after a clear) must cost nothing.
      if (!caustic.overlayMesh.visible) return;
      followCameraLight();
      caustic.update();
    },
    dispose() {
      if (caustic) { scene.remove(caustic.overlayMesh); caustic.dispose(); }
      if (causticWall) { scene.remove(causticWall); causticWall.geometry.dispose(); causticWall.material.dispose(); }
      if (keyLight) scene.remove(keyLight);
      // Inert from here: an async rebuild landing after unmount must not be
      // able to resurrect the engine into the shared scene via syncCaster().
      caustic = null;
      causticWall = null;
      keyLight = null;
      active = false;
      setRasterBackdropHidden?.('photonTrace', false);
    },
  };
}
