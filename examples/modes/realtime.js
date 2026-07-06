import {
  buildSparseCurveGeometry,
  buildSigilGeometryAsync,
  createChromeMaterial,
  createDrawDemoState,
  sparsePreviewOptionsFromState,
  chromeOptionsFromState,
  updateChromeMaterial,
} from '../../src/index.js';
import { createDrawPlane } from '../shared/demoContext.js';
import { bindRightDragOrbit } from '../shared/orbit.js';
import { mountControlPanel, syncControlPanelToState } from '../shared/controlPanel.js';
import { DEMO_CONTROL_SPECS } from '../shared/demoControlSpecs.js';
import { bindGlbExportButton } from '../shared/glbExport.js';
import { createCausticEngine, causticReceiverWall } from '../vendor/caustic_engine.js';
import {
  activeBuildPaths,
  buildOptionsForSession,
  committedBuildPaths,
  isDrawSettingKey,
  makeStrokeRecord,
  strokePoints,
} from '../shared/strokeSession.js';

export const meta = {
  id: 'realtime',
  label: 'Freehand',
};

export function mount(ctx, { panelRoot, infoRoot, state = createDrawDemoState(), strokes = [] }) {
  const { THREE, renderer, scene, controls } = ctx;
  const abort = new AbortController();
  const { signal } = abort;
  let camera = ctx.setOrthographicView(state.orthographic);
  const { planePoint } = createDrawPlane(() => camera);

  controls.target.set(0, 0, 0);
  camera = ctx.setCameraHome();
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
  renderer.domElement.style.cursor = 'crosshair';

  panelRoot.innerHTML = `
    <div class="mode-head">
      <h2>Sigils</h2>
    </div>
    <div id="controls"></div>
    <div class="buttons">
      <button id="defaults" type="button">Draw defaults</button>
      <button id="undo" type="button">Undo</button>
      <button id="clear" type="button">Clear</button>
      <button id="export-glb" type="button">GLB</button>
      <button id="photon" type="button">Photon blast</button>
    </div>
    <div id="photon-controls" hidden></div>
  `;
  infoRoot.innerHTML = `<b>sigils</b><br /><span id="stats">—</span>`;

  const statsEl = infoRoot.querySelector('#stats');
  const controlsRoot = panelRoot.querySelector('#controls');
  let sigilMaterial = createChromeMaterial(chromeOptionsFromState(state));
  const defaultState = createDrawDemoState();

  const controlUi = mountControlPanel(controlsRoot, DEMO_CONTROL_SPECS, state, {
    onChange: (key) => {
      if (key === 'orthographic') {
        camera = ctx.setOrthographicView(state.orthographic);
        return;
      }
      if (key === 'guides') refreshGuides();
      if (key === 'profile') replaceChromeMaterial();
      refreshPreview();
      if (key === 'previewStripOnly') {
        rebuildVersion++;
        clearTimeout(rebuildTimer);
        if (state.previewStripOnly) {
          clearCommittedMesh();
          holdPreviewUntilRebuild = false;
          blendBackend = 'strip';
        } else {
          scheduleRebuild(0);
        }
        return;
      }
      if (state.previewStripOnly) return;
      if (isDrawSettingKey(key)) return;
      scheduleRebuild();
    },
    onLive: (key) => {
      updateChromeMaterial(sigilMaterial, chromeOptionsFromState(state));
      if (photonActive && caustic) {
        if (key === 'peak') uploadPhotonCaster();
        if (key === 'roughness') caustic.setRoughness(state.roughness);
      }
      if (state.previewStripOnly && key === 'peak') refreshPreview();
    },
    defaults: defaultState,
    signal,
  });

  const sigilMesh = new THREE.Mesh(new THREE.BufferGeometry(), sigilMaterial);
  sigilMesh.frustumCulled = false;
  sigilMesh.visible = false;
  scene.add(sigilMesh);

  const previewMesh = new THREE.Mesh(new THREE.BufferGeometry(), sigilMaterial);
  previewMesh.frustumCulled = false;
  previewMesh.visible = false;
  previewMesh.renderOrder = 1;
  scene.add(previewMesh);

  const guideGroup = new THREE.Group();
  guideGroup.renderOrder = 2;
  scene.add(guideGroup);
  const guideMat = new THREE.LineBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0.7, depthTest: false });

  let current = [];
  let rebuildVersion = 0;
  let rebuildTimer = 0;
  let vertexCount = 0;
  let lastError = '';
  let blendBackend = '—';
  let drawing = false;
  let holdPreviewUntilRebuild = false;
  let activePointer = null;

  const ui = {
    defaults: panelRoot.querySelector('#defaults'),
    undo: panelRoot.querySelector('#undo'),
    clear: panelRoot.querySelector('#clear'),
    exportGlb: panelRoot.querySelector('#export-glb'),
    photon: panelRoot.querySelector('#photon'),
  };

  bindGlbExportButton(ui.exportGlb, { strokes, state, renderer, signal });

  // Photon blast: GPU caustics thrown off the drawn sigil onto a backdrop wall
  // BEHIND it. The sigil is drawn on the z=0 plane facing +Z, so reflected
  // photons travel toward -Z — a floor under the sigil caught almost nothing.
  // Wall distance sets the caustic throw: landings scale with the sigil->wall
  // gap, so a close wall keeps the photons hugging the silhouette.
  const WALL = { z: -0.5, y: 0, width: 20, height: 12 };
  let caustic = null, causticWall = null, keyLight = null, photonActive = false;

  // The photon light lives on a sphere around the sigil's centre: orbit swings
  // it across the front, lift raises it, range pulls it away. Glow drives both
  // the caustic strength and the key light so the backdrop follows the beam.
  // Defaults rake the light from the side: a head-on light reflects FORWARD off
  // the sigil (away from the back wall) — only steep slopes and stroke side
  // walls throw photons backward, so grazing angles are what read on the wall.
  const PHOTON_DEFAULTS = {
    lightOrbit: 58, lightLift: 10, lightRange: 3.4,
    reach: 0.9, glow: 4, beamWidth: 0.7, bloom: 1.0,
  };
  const photonState = { ...PHOTON_DEFAULTS };
  const PHOTON_CONTROL_SPECS = [
    { type: 'section', label: 'Photon light' },
    { key: 'lightOrbit', label: 'Orbit', type: 'range', min: -80, max: 80, step: 1, int: true, live: true },
    { key: 'lightLift', label: 'Lift', type: 'range', min: -8, max: 70, step: 1, int: true, live: true },
    { key: 'lightRange', label: 'Range', type: 'range', min: 1.8, max: 6, step: 0.05, live: true },
    { key: 'reach', label: 'Reach', type: 'range', min: 0.3, max: 6, step: 0.05, live: true },
    { key: 'glow', label: 'Glow', type: 'range', min: 0, max: 6, step: 0.05, live: true },
    { key: 'beamWidth', label: 'Width', type: 'range', min: 0.15, max: 2, step: 0.05, live: true },
    { key: 'bloom', label: 'Bloom', type: 'range', min: 0, max: 2, step: 0.05, live: true },
  ];
  const photonPanel = panelRoot.querySelector('#photon-controls');
  mountControlPanel(photonPanel, PHOTON_CONTROL_SPECS, photonState, {
    onLive: () => applyPhotonState(),
    defaults: { ...PHOTON_DEFAULTS },
    signal,
  });

  function applyPhotonState() {
    if (!caustic) return;
    const az = THREE.MathUtils.degToRad(photonState.lightOrbit);
    const el = THREE.MathUtils.degToRad(photonState.lightLift);
    const r = photonState.lightRange;
    const x = Math.sin(az) * Math.cos(el) * r;
    const y = Math.sin(el) * r;
    const z = Math.cos(az) * Math.cos(el) * r; // always in front of the sigil
    caustic.setLight(x, y, z);
    caustic.setStrength(photonState.glow);
    caustic.setSoftness(photonState.beamWidth);
    caustic.setBloom(photonState.bloom);
    // Reach = throw distance (world units) where a photon's weight halves;
    // photons landing much farther than the reach fade out instead of smearing.
    caustic.setThrowFalloff(1 / (photonState.reach * photonState.reach));
    keyLight.position.set(x, y, z);
    keyLight.intensity = 12 * photonState.glow;
  }

  function ensurePhotonRig() {
    if (caustic) return;
    caustic = createCausticEngine({
      THREE, renderer,
      grid: 1024, // wider receiver -> keep caustic texel density up
      // 1M grid cells over a 20x12 wall: the engine's 3M default converges at
      // ~3 photons/cell and leaves visible speckle. Emit is sub-ms, so buy
      // smoothness with volume: ~200 photons/cell. Fixed-point headroom is
      // fine — the u32 grid saturates around ~1e9 photons into one hot cell.
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

  function uploadPhotonCaster() {
    const verts = sigilMesh.geometry.getAttribute('position')?.count ?? 0;
    if (verts <= 0 || !caustic) return false;
    sigilMesh.updateMatrixWorld(true);
    caustic.setCasterMesh(sigilMesh);
    caustic.markDirty();
    return true;
  }

  function setPhotonActive(on) {
    if (on) {
      const verts = sigilMesh.geometry.getAttribute('position')?.count ?? 0;
      if (verts <= 0) { statsEl.textContent = 'draw a sigil first'; return; }
      ensurePhotonRig();
      if (!uploadPhotonCaster()) return;
      caustic.overlayMesh.visible = causticWall.visible = keyLight.visible = true;
    } else if (caustic) {
      caustic.overlayMesh.visible = causticWall.visible = keyLight.visible = false;
    }
    photonActive = on;
    photonPanel.hidden = !on;
    ui.photon.classList.toggle('active', on);
    ui.photon.textContent = on ? 'Photon off' : 'Photon blast';
  }

  ui.photon.addEventListener('click', () => setPhotonActive(!photonActive), { signal });

  function replaceChromeMaterial() {
    const previous = sigilMaterial;
    sigilMaterial = createChromeMaterial(chromeOptionsFromState(state));
    sigilMesh.material = sigilMaterial;
    previewMesh.material = sigilMaterial;
    previous.dispose();
    if (photonActive && caustic) uploadPhotonCaster();
  }

  function applyDrawDefaults() {
    Object.assign(state, createDrawDemoState());
    syncControlPanelToState(controlUi, state, panelRoot);
    camera = ctx.setOrthographicView(state.orthographic);
    replaceChromeMaterial();
    refreshGuides();
    refreshPreview();
    scheduleRebuild(0);
  }

  function allStrokes() {
    const paths = strokes.map(strokePoints);
    if (current.length >= 2) paths.push(current);
    return paths;
  }

  function scheduleRebuild(delay = 120) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, delay);
  }

  function refreshGuides() {
    // Group.clear() does not dispose the line geometries.
    for (const child of guideGroup.children) child.geometry?.dispose();
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

  function clearCommittedMesh() {
    sigilMesh.visible = false;
    const old = sigilMesh.geometry;
    sigilMesh.geometry = new THREE.BufferGeometry();
    old.dispose();
    if (photonActive) setPhotonActive(false);
    updateVertexCount();
  }

  function updateVertexCount() {
    const committed = sigilMesh.geometry.getAttribute('position')?.count ?? 0;
    const preview = previewMesh.visible
      ? (previewMesh.geometry.getAttribute('position')?.count ?? 0)
      : 0;
    vertexCount = committed + preview;
  }

  function refreshPreview() {
    if (state.previewStripOnly) {
      const paths = activeBuildPaths(strokes, current, state);
      if (paths.length === 0) {
        clearPreviewMesh();
        updateVertexCount();
        return;
      }

      const geometry = buildSparseCurveGeometry(paths, {
        ...sparsePreviewOptionsFromState(state),
        symmetry: 1,
        mirror: false,
        phase: 0,
      });
      const old = previewMesh.geometry;
      previewMesh.geometry = geometry;
      old.dispose();
      previewMesh.visible = (geometry.getAttribute('position')?.count ?? 0) > 0;
      updateVertexCount();
      return;
    }

    if (holdPreviewUntilRebuild && !drawing) {
      updateVertexCount();
      return;
    }

    if (!drawing || current.length < 2) {
      if (holdPreviewUntilRebuild) {
        updateVertexCount();
        return;
      }
      clearPreviewMesh();
      updateVertexCount();
      return;
    }

    const geometry = buildSparseCurveGeometry([current], sparsePreviewOptionsFromState(state));
    const old = previewMesh.geometry;
    previewMesh.geometry = geometry;
    old.dispose();
    previewMesh.visible = (geometry.getAttribute('position')?.count ?? 0) > 0;
    updateVertexCount();
  }

  async function rebuild() {
    try {
      lastError = '';
      if (state.previewStripOnly) {
        clearCommittedMesh();
        holdPreviewUntilRebuild = false;
        blendBackend = 'strip';
        refreshPreview();
        return;
      }
      if (strokes.length === 0) {
        const old = sigilMesh.geometry;
        sigilMesh.geometry = new THREE.BufferGeometry();
        old.dispose();
        sigilMesh.visible = false;
        holdPreviewUntilRebuild = false;
        clearPreviewMesh();
        vertexCount = 0;
        blendBackend = '—';
        if (photonActive) setPhotonActive(false);
        return;
      }

      const version = ++rebuildVersion;
      const paths = committedBuildPaths(strokes);
      const geometry = await buildSigilGeometryAsync(paths, {
        ...buildOptionsForSession(state),
        renderer,
        onGpuFallback: (error) => console.warn('sigils: hybrid field fallback', error),
      });

      if (version !== rebuildVersion || state.previewStripOnly) {
        geometry.dispose();
        return;
      }

      const committedVerts = geometry.getAttribute('position')?.count ?? 0;
      blendBackend = geometry.userData.fieldBackend
        ?? geometry.userData.sigilizeBackend
        ?? geometry.userData.buildBackend
        ?? state.backend;

      const oldGeometry = sigilMesh.geometry;
      sigilMesh.geometry = geometry;
      oldGeometry.dispose();
      sigilMesh.visible = committedVerts > 0;

      holdPreviewUntilRebuild = false;
      if (!drawing) clearPreviewMesh();
      updateVertexCount();
      if (photonActive && caustic) uploadPhotonCaster();
    } catch (error) {
      lastError = error?.message ?? String(error);
      console.error('sigils rebuild failed', error);
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
      strokes.push(makeStrokeRecord(current, state));
      holdPreviewUntilRebuild = !state.previewStripOnly;
    } else {
      refreshPreview();
    }
    current = [];
    refreshGuides();
    if (state.previewStripOnly) refreshPreview();
    else rebuild();
  }

  ui.defaults.addEventListener('click', applyDrawDefaults, { signal });
  ui.undo.addEventListener('click', () => {
    if (drawing) finishStroke();
    strokes.pop();
    holdPreviewUntilRebuild = false;
    clearPreviewMesh();
    refreshGuides();
    if (state.previewStripOnly) refreshPreview();
    else rebuild();
  }, { signal });
  ui.clear.addEventListener('click', () => {
    if (drawing) finishStroke();
    strokes.length = 0;
    current = [];
    holdPreviewUntilRebuild = false;
    clearPreviewMesh();
    refreshGuides();
    if (state.previewStripOnly) refreshPreview();
    else rebuild();
  }, { signal });

  bindRightDragOrbit(ctx, { signal, getCamera: () => camera });

  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drawing = true;
    activePointer = event.pointerId;
    try {
      renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      // Some event sources do not create a capturable pointer.
    }
    current = [];
    pushPoint(planePoint(event));
    refreshGuides();
    refreshPreview();
  }, { signal });

  renderer.domElement.addEventListener('pointermove', (event) => {
    if (!drawing || event.pointerId !== activePointer) return;
    const before = current.length;
    pushPoint(planePoint(event));
    if (current.length === before) return;
    refreshGuides();
    refreshPreview();
  }, { signal });

  renderer.domElement.addEventListener('pointerup', finishStroke, { signal });
  renderer.domElement.addEventListener('pointercancel', finishStroke, { signal });

  refreshGuides();
  if (strokes.length > 0) rebuild();

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
    if (photonActive && caustic) caustic.update(); // GPU compute passes before the scene draw
    renderer.render(scene, camera);

    const now = performance.now();
    fpsClock += now - lastT;
    lastT = now;
    frames++;
    if (fpsClock >= 500) {
      const fps = Math.round((frames * 1000) / fpsClock);
      const err = lastError ? ` · error: ${lastError}` : '';
      statsEl.textContent = `${fps} fps · ${vertexCount} verts · ${blendBackend}${err}`;
      frames = 0;
      fpsClock = 0;
    }
  });

  return () => {
    abort.abort();
    clearTimeout(rebuildTimer);
    guideMat.dispose();
    sigilMaterial.dispose();
    scene.remove(sigilMesh, previewMesh, guideGroup);
    sigilMesh.geometry.dispose();
    previewMesh.geometry.dispose();
    if (caustic) { scene.remove(caustic.overlayMesh); caustic.dispose(); }
    if (causticWall) { scene.remove(causticWall); causticWall.geometry.dispose(); causticWall.material.dispose(); }
    if (keyLight) scene.remove(keyLight);
    ctx.setAnimationLoop(null);
  };
}
