import {
  createChromeMaterial,
  createSigilState,
  createDrawDemoState,
  shapeOptionsFromState,
  chromeOptionsFromState,
  updateChromeMaterial,
} from '../../src/index.js';
import { buildResidentField } from '../../src/meshlessField.js';
import {
  createRaymarchSigilMaterial,
  updateRaymarchSigilMaterial,
  updateRaymarchFieldUniforms,
  buildProxyBoxGeometry,
  RAYMARCH_STEPS,
} from '../../src/tsl/raymarchSigilMaterial.js';
import { createDrawPlane } from '../shared/demoContext.js';
import { mountControlPanel, syncControlPanelToState } from '../shared/controlPanel.js';
import { DEMO_CONTROL_SPECS } from '../shared/demoControlSpecs.js';

export const meta = {
  id: 'meshless',
  label: 'Raymarch',
  hint: 'Meshless SDF raymarch · field stays on the GPU, no mesh build',
};

// Field resolution used for the cheap live rebuilds while dragging; the release
// rebuild uses the full state.resolution. Lower = faster live redraw, coarser
// silhouette mid-stroke (it sharpens on release).
const DRAFT_RESOLUTION = 140;

export function mount(ctx, { panelRoot, infoRoot }) {
  const { THREE, renderer, scene, camera, controls } = ctx;
  const abort = new AbortController();
  const { signal } = abort;
  const { planePoint } = createDrawPlane(camera);

  // ctx is shared between modes and realtime does not restore these, so re-set
  // camera/controls/cursor on mount; remember the button map to restore later.
  const prevMouseButtons = controls.mouseButtons;
  camera.up.set(0, 1, 0);
  camera.position.set(0, -0.85, 3.7);
  controls.target.set(0, 0, 0);
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: null };
  renderer.domElement.style.cursor = 'crosshair';

  const state = createSigilState();

  panelRoot.innerHTML = `
    <div class="mode-head">
      <h2>Raymarch</h2>
      <p class="sub">${meta.hint}</p>
    </div>
    <div id="controls"></div>
    <div class="buttons">
      <button id="defaults" type="button">Draw defaults</button>
      <button id="undo" type="button">Undo</button>
      <button id="clear" type="button">Clear</button>
    </div>
    <div class="note">Left-drag to draw. Right-drag orbits, scroll zooms. The committed sigil is raymarched — no mesh.</div>
  `;
  infoRoot.innerHTML = `<b>raymarch</b><br /><span id="stats">—</span>`;

  const statsEl = infoRoot.querySelector('#stats');
  const controlsRoot = panelRoot.querySelector('#controls');

  // The drag preview is the same sparse chrome strip as realtime (a real mesh);
  // the committed surface is the meshless raymarch proxy box.
  const previewMaterial = createChromeMaterial(chromeOptionsFromState(state));

  // Raymarch material is created lazily on the first resident field (it binds
  // that field's storage buffers); meanwhile the hidden box reuses previewMaterial.
  let sigilMaterial = null;
  let builtRaw = null;
  let builtSmooth = null;
  let builtProfile = null;

  const controlUi = mountControlPanel(controlsRoot, DEMO_CONTROL_SPECS, state, {
    onChange: (key) => {
      if (key === 'guides') refreshGuides();
      refreshPreview();
      scheduleRebuild();
    },
    onLive: () => {
      // previewMaterial always exists; sigilMaterial is lazily created on the
      // first committed stroke, so update preview first and guard the sigil.
      updateChromeMaterial(previewMaterial, chromeOptionsFromState(state));
      if (sigilMaterial) updateRaymarchSigilMaterial(sigilMaterial, chromeOptionsFromState(state));
    },
    signal,
  });

  const sigilMesh = new THREE.Mesh(new THREE.BufferGeometry(), previewMaterial);
  sigilMesh.frustumCulled = false;
  sigilMesh.visible = false;
  scene.add(sigilMesh);

  const previewMesh = new THREE.Mesh(new THREE.BufferGeometry(), previewMaterial);
  previewMesh.frustumCulled = false;
  previewMesh.visible = false;
  previewMesh.renderOrder = 1;
  scene.add(previewMesh);

  const guideGroup = new THREE.Group();
  guideGroup.renderOrder = 2;
  scene.add(guideGroup);
  const guideMat = new THREE.LineBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0.7, depthTest: false });

  const strokes = [];
  let current = [];
  let rebuildVersion = 0;
  let rebuildTimer = 0;
  let pool = null;
  let gridInfo = '—';
  let lastError = '';
  let drawing = false;
  let holdPreviewUntilRebuild = false;
  let activePointer = null;
  let orbiting = false;
  let orbitPointer = null;
  let orbitX = 0;
  let orbitY = 0;
  const orbitOffset = new THREE.Vector3();
  const orbitSpherical = new THREE.Spherical();

  const ui = {
    defaults: panelRoot.querySelector('#defaults'),
    undo: panelRoot.querySelector('#undo'),
    clear: panelRoot.querySelector('#clear'),
  };

  function applyDrawDefaults() {
    Object.assign(state, createDrawDemoState());
    syncControlPanelToState(controlUi, state, panelRoot);
    updateChromeMaterial(previewMaterial, chromeOptionsFromState(state));
    if (sigilMaterial) updateRaymarchSigilMaterial(sigilMaterial, chromeOptionsFromState(state));
    refreshGuides();
    refreshPreview();
    scheduleRebuild(0);
  }

  function allStrokes() {
    return current.length >= 2 ? [...strokes, current] : strokes;
  }

  function scheduleRebuild(delay = 120) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, delay);
  }

  function refreshGuides() {
    guideGroup.clear();
    guideGroup.visible = state.guides;
    if (!guideGroup.visible) return;
    for (const stroke of allStrokes()) {
      if (stroke.length < 2) continue;
      const pts = stroke.map(([x, y]) => new THREE.Vector3(x, y, 0.012));
      guideGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), guideMat));
    }
  }

  function clearPreviewMesh() {
    previewMesh.visible = false;
    const old = previewMesh.geometry;
    previewMesh.geometry = new THREE.BufferGeometry();
    old.dispose();
  }

  // Preview draw is DISABLED in the raymarch mode: while dragging, nothing renders
  // for the in-progress stroke, so the committed raymarch surface is the only thing
  // on screen and its true cost/responsiveness is what you see. (The realtime mesh
  // mode keeps its sparse-strip preview.) previewMesh stays empty + hidden.
  function refreshPreview() {
    previewMesh.visible = false;
  }

  // rebuild() is called both debounced (scheduleRebuild) and directly
  // (finishStroke/undo/clear). buildResidentField reuses the SAME grow-only pool
  // buffers in place, so two overlapping runs would issue GPU rasterize/blur
  // passes writing the same StorageBufferAttributes concurrently (flicker /
  // half-overwritten sampling). Serialize every rebuild through one promise
  // chain so the shared buffers are only ever touched by one build at a time.
  let building = Promise.resolve();
  function rebuild() {
    building = building.then(runRebuild, runRebuild);
    return building;
  }

  // Live (during-drag) rebuild: coalesce a burst of pointermoves into at most ONE
  // trailing rebuild, chained after whatever build is in flight. The field is thus
  // rebuilt as fast as the GPU can finish, never piling up, and because runRebuild
  // reads allStrokes() (incl. the in-progress stroke) the raymarched surface tracks
  // the pen in real time instead of only appearing on release.
  let liveScheduled = false;
  function scheduleLiveRebuild() {
    if (liveScheduled) return;
    liveScheduled = true;
    building = building.then(runLive, runLive);
  }
  function runLive() {
    liveScheduled = false;
    return runRebuild();
  }

  async function runRebuild() {
    try {
      lastError = '';
      // allStrokes() includes the in-progress stroke while drawing, so live
      // rebuilds raymarch the pen stroke as it's drawn (read once, synchronously,
      // before the first await so a still-growing `current` can't tear the build).
      const active = allStrokes();
      if (active.length === 0) {
        sigilMesh.visible = false;
        holdPreviewUntilRebuild = false;
        clearPreviewMesh();
        gridInfo = '—';
        return;
      }

      const version = ++rebuildVersion;
      // While dragging, build at a lower DRAFT resolution so each live rebuild is
      // cheap; the release rebuild (drawing === false) uses full state.resolution.
      const buildOpts = shapeOptionsFromState(state);
      if (drawing) {
        buildOpts.resolution = DRAFT_RESOLUTION;
        buildOpts.fieldResolution = DRAFT_RESOLUTION;
      }
      const field = await buildResidentField(renderer, active, buildOpts, pool);

      // Discard results that an unmount or a newer rebuild has superseded.
      if (version !== rebuildVersion || signal.aborted) {
        field?.dispose?.();
        return;
      }

      if (!field) {
        sigilMesh.visible = false;
        holdPreviewUntilRebuild = false;
        if (!drawing) clearPreviewMesh();
        gridInfo = '—';
        return;
      }

      pool = field;

      // Recreate the material only when its storage bindings or build-time
      // branch (profile) are stale; otherwise update grid uniforms in place.
      const profile = state.profile;
      const needNewMaterial = !sigilMaterial
        || field.reused === false
        || field.rawAttr !== builtRaw
        || field.smoothAttr !== builtSmooth
        || profile !== builtProfile;

      if (needNewMaterial) {
        if (sigilMaterial) sigilMaterial.dispose();
        sigilMaterial = createRaymarchSigilMaterial(field, chromeOptionsFromState(state));
        sigilMesh.material = sigilMaterial;
        builtRaw = field.rawAttr;
        builtSmooth = field.smoothAttr;
        builtProfile = profile;
      } else {
        updateRaymarchFieldUniforms(sigilMaterial, field);
        updateRaymarchSigilMaterial(sigilMaterial, chromeOptionsFromState(state));
      }

      // The proxy box depends on the grid (bounds/cell), so rebuild it here;
      // live `peak` drags do NOT reach this path (handled by uniforms).
      const oldGeometry = sigilMesh.geometry;
      sigilMesh.geometry = buildProxyBoxGeometry(field);
      oldGeometry.dispose();
      sigilMesh.visible = field.grid.segmentCount > 0;
      gridInfo = `${field.grid.width}×${field.grid.height} field · ${RAYMARCH_STEPS} steps`;

      holdPreviewUntilRebuild = false;
      if (!drawing) clearPreviewMesh();
    } catch (error) {
      lastError = error?.message ?? String(error);
      console.error('meshless rebuild failed', error);
      // A transient field-build failure must not leave the canvas blank: release
      // the preview hold finishStroke() set so the next interaction can redraw.
      holdPreviewUntilRebuild = false;
      if (!drawing) clearPreviewMesh();
    }
  }

  function pushPoint(p) {
    if (!p) return;
    const last = current[current.length - 1];
    if (last) {
      const dx = p[0] - last[0];
      const dy = p[1] - last[1];
      const minStep = state.minDrawStep;
      if (dx * dx + dy * dy < minStep * minStep) return;
    }
    current.push(p);
  }

  function finishStroke() {
    if (!drawing) return;
    drawing = false;
    activePointer = null;
    if (current.length >= 2) {
      strokes.push(current);
      holdPreviewUntilRebuild = true;
    } else {
      refreshPreview();
    }
    current = [];
    refreshGuides();
    rebuild();
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
    try {
      renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      // Some event sources do not create a capturable pointer.
    }
    renderer.domElement.style.cursor = 'grabbing';
  }

  function moveOrbit(event) {
    if (!orbiting || event.pointerId !== orbitPointer) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    rotateView(event.clientX - orbitX, event.clientY - orbitY);
    orbitX = event.clientX;
    orbitY = event.clientY;
  }

  function endOrbit(event) {
    if (!orbiting || event.pointerId !== orbitPointer) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Capture may already be gone after browser-level cancellation.
    }
    renderer.domElement.style.cursor = 'crosshair';
    orbiting = false;
    orbitPointer = null;
  }

  ui.defaults.addEventListener('click', applyDrawDefaults, { signal });
  ui.undo.addEventListener('click', () => {
    if (drawing) finishStroke();
    strokes.pop();
    holdPreviewUntilRebuild = false;
    clearPreviewMesh();
    refreshGuides();
    rebuild();
  }, { signal });
  ui.clear.addEventListener('click', () => {
    if (drawing) finishStroke();
    strokes.length = 0;
    current = [];
    holdPreviewUntilRebuild = false;
    clearPreviewMesh();
    refreshGuides();
    rebuild();
  }, { signal });

  renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });
  renderer.domElement.addEventListener('pointerdown', beginOrbit, { capture: true, signal });
  renderer.domElement.addEventListener('pointermove', moveOrbit, { capture: true, signal });
  renderer.domElement.addEventListener('pointerup', endOrbit, { capture: true, signal });
  renderer.domElement.addEventListener('pointercancel', endOrbit, { capture: true, signal });

  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drawing = true;
    activePointer = event.pointerId;
    renderer.domElement.setPointerCapture(event.pointerId);
    current = [];
    pushPoint(planePoint(event));
    refreshGuides();
    refreshPreview();
  }, { signal });

  renderer.domElement.addEventListener('pointermove', (event) => {
    if (!drawing || event.pointerId !== activePointer) return;
    pushPoint(planePoint(event));
    refreshGuides();
    scheduleLiveRebuild(); // raymarch the in-progress stroke live as it's drawn
  }, { signal });

  renderer.domElement.addEventListener('pointerup', finishStroke, { signal });
  renderer.domElement.addEventListener('pointercancel', finishStroke, { signal });

  refreshGuides();

  let frames = 0;
  let fpsClock = 0;
  let lastT = performance.now();

  addEventListener('error', (event) => {
    lastError = event.message ?? String(event.error);
  }, { signal });
  addEventListener('unhandledrejection', (event) => {
    lastError = event.reason?.message ?? String(event.reason);
  }, { signal });

  ctx.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);

    const now = performance.now();
    fpsClock += now - lastT;
    lastT = now;
    frames++;
    if (fpsClock >= 500) {
      const fps = Math.round((frames * 1000) / fpsClock);
      const err = lastError ? ` · error: ${lastError}` : '';
      statsEl.textContent = `${fps} fps · ${gridInfo}${err}`;
      frames = 0;
      fpsClock = 0;
    }
  });

  return () => {
    abort.abort();
    clearTimeout(rebuildTimer);
    guideMat.dispose();
    previewMaterial.dispose();
    if (sigilMaterial) sigilMaterial.dispose();
    scene.remove(sigilMesh, previewMesh, guideGroup);
    sigilMesh.geometry.dispose();
    previewMesh.geometry.dispose();
    // Release the resident-field pool's GPU buffers (force: nothing references
    // them after the material is disposed) so they become GC-eligible promptly
    // instead of lingering until page unload.
    pool?.dispose?.(true);
    pool = null;
    builtRaw = null;
    builtSmooth = null;
    controls.mouseButtons = prevMouseButtons;
    renderer.domElement.style.cursor = '';
    ctx.setAnimationLoop(null);
  };
}
