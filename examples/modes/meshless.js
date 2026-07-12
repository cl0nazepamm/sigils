import {
  buildSparseCurveGeometry,
  createChromeMaterial,
  updateChromeMaterial,
} from '../../src/index.js';
import {
  createDrawDemoState,
  chromeOptionsFromState,
  sparsePreviewOptionsFromState,
} from '../shared/sigilDefaults.js';
import { buildResidentField } from '../shared/meshlessField.js';
import {
  createRaymarchSigilMaterial,
  updateRaymarchSigilMaterial,
  updateRaymarchFieldUniforms,
  buildProxyBoxGeometry,
  RAYMARCH_STEPS,
} from '../shared/raymarchSigilMaterial.js';
import { createDrawPlane } from '../shared/demoContext.js';
import { bindRightDragOrbit } from '../shared/orbit.js';
import { bindUndoRedoKeys } from '../shared/hotkeys.js';
import { mountControlPanel, syncControlPanelToState } from '../shared/controlPanel.js';
import { DEMO_CONTROL_SPECS } from '../shared/demoControlSpecs.js';
import { bindGlbExportButton } from '../shared/glbExport.js';
import { bindSaveImageButton } from '../shared/saveImage.js';
import {
  activeBuildPaths,
  buildOptionsForSession,
  isDrawSettingKey,
  makeStrokeRecord,
  strokePoints,
} from '../shared/strokeSession.js';

export const meta = {
  id: 'meshless',
  label: 'Raymarch (experimental)',
};

const LIVE_REBUILD_MIN_MS = 80;
const MESHLESS_IGNORED_CONTROLS = new Set([
  'backend',
  'base',
  'depthMode',
  'laplacian',
  'laplacianWeight',
  'heightSmooth',
  'heightSmoothWeight',
]);
const MESHLESS_CONTROL_SPECS = compactControlSpecs(DEMO_CONTROL_SPECS, MESHLESS_IGNORED_CONTROLS);

function compactControlSpecs(specs, ignored) {
  const out = [];
  let sectionStart = -1;
  let sectionHasControl = false;

  const closeEmptySection = () => {
    if (sectionStart >= 0 && !sectionHasControl) out.splice(sectionStart);
    sectionStart = -1;
    sectionHasControl = false;
  };

  for (const spec of specs) {
    if (spec.type === 'section' || spec.type === 'details') {
      closeEmptySection();
      sectionStart = out.length;
      out.push(spec);
      continue;
    }

    if (spec.type === 'group' || spec.type === 'hostReset') {
      closeEmptySection();
      out.push(spec);
      continue;
    }

    if (ignored.has(spec.key)) continue;
    out.push(spec);
    sectionHasControl = true;
  }

  closeEmptySection();
  return out;
}

export function mount(ctx, { panelRoot, infoRoot, state = createDrawDemoState(), strokes = [] }) {
  const { THREE, renderer, scene, controls, renderBackend } = ctx;
  const abort = new AbortController();
  const { signal } = abort;
  let camera = ctx.setOrthographicView(state.orthographic);
  const { planePoint } = createDrawPlane(() => camera);

  // ctx is shared between modes and realtime does not restore these, so re-set
  // camera/controls/cursor on mount; remember the button map to restore later.
  const prevMouseButtons = controls.mouseButtons;
  controls.target.set(0, 0, 0);
  camera = ctx.setCameraHome();
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
  renderer.domElement.style.cursor = 'crosshair';

  if (renderBackend === 'webgl') {
    panelRoot.innerHTML = `
      <div class="mode-head">
        <h2>Raymarch <span class="experimental">experimental</span></h2>
      </div>
      <p class="hint">Needs WebGPU compute — this session is on WebGL2. Switch to Drawing.</p>
    `;
    infoRoot.innerHTML = `<b>Sigils Creator · Raymarch</b><br /><span id="stats">webgl — unavailable</span>`;
    return () => {
      controls.mouseButtons = prevMouseButtons;
      renderer.domElement.style.cursor = '';
    };
  }

  panelRoot.innerHTML = `
    <div class="mode-head">
      <h2>Raymarch <span class="experimental">experimental</span></h2>
    </div>
    <div id="controls"></div>
    <div class="buttons">
      <button id="defaults" type="button">Reset all</button>
      <button id="undo" type="button">Undo</button>
      <button id="clear" type="button">Clear</button>
      <button id="export-glb" type="button">Export GLB</button>
      <button id="save-png" type="button">Save PNG</button>
    </div>
  `;
  infoRoot.innerHTML = `<b>Sigils Creator · Raymarch</b><br /><span id="stats">—</span><br /><span class="hint pointer-hint-mouse">draw: left-drag · orbit: right-drag · pan: middle · ctrl/⌘+z undo · +shift redo</span><span class="hint pointer-hint-touch">draw: one finger · two fingers: orbit/zoom · pan: three fingers · undo from the panel</span>`;

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
  const defaultState = createDrawDemoState();

  const controlUi = mountControlPanel(controlsRoot, MESHLESS_CONTROL_SPECS, state, {
    onChange: (key) => {
      if (key === 'orthographic') {
        camera = ctx.setOrthographicView(state.orthographic);
        return;
      }
      if (key === 'guides') refreshGuides();
      refreshPreview();
      if (key === 'previewStripOnly') {
        rebuildVersion++;
        clearTimeout(rebuildTimer);
        clearTimeout(liveRebuildTimer);
        liveQueued = false;
        if (state.previewStripOnly) {
          clearRaymarchMesh();
          holdPreviewUntilRebuild = false;
          gridInfo = 'strip';
        } else {
          clearPreviewMesh();
          scheduleRebuild(0);
        }
        return;
      }
      if (state.previewStripOnly) return;
      if (isDrawSettingKey(key)) {
        if (drawing) scheduleLiveRebuild();
        return;
      }
      scheduleRebuild();
    },
    onLive: () => {
      // previewMaterial always exists; sigilMaterial is lazily created on the
      // first committed stroke, so update preview first and guard the sigil.
      updateChromeMaterial(previewMaterial, chromeOptionsFromState(state));
      if (sigilMaterial) updateRaymarchSigilMaterial(sigilMaterial, chromeOptionsFromState(state));
      if (state.previewStripOnly) refreshPreview();
    },
    defaults: defaultState,
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
  let currentGuide = null;

  let current = [];
  let rebuildVersion = 0;
  let rebuildTimer = 0;
  let pool = null;
  const redoStrokes = [];
  let gridInfo = '—';
  let lastError = '';
  let drawing = false;
  let holdPreviewUntilRebuild = false;
  let activePointer = null;
  const touchPointers = new Set();

  const ui = {
    defaults: panelRoot.querySelector('#defaults'),
    undo: panelRoot.querySelector('#undo'),
    clear: panelRoot.querySelector('#clear'),
    exportGlb: panelRoot.querySelector('#export-glb'),
    savePng: panelRoot.querySelector('#save-png'),
  };

  bindGlbExportButton(ui.exportGlb, { strokes, state, renderer, signal });
  bindSaveImageButton(ui.savePng, {
    signal,
    getView: () => ({ renderer, scene, camera, THREE }),
    prepareCapture: () => {
      const prevGuides = guideGroup.visible;
      const prevPreview = previewMesh?.visible ?? false;
      guideGroup.visible = false;
      if (previewMesh) previewMesh.visible = false;
      ctx.setRasterBackdropHidden?.('savePng', true);
      return () => {
        guideGroup.visible = prevGuides;
        if (previewMesh) previewMesh.visible = prevPreview;
        ctx.setRasterBackdropHidden?.('savePng', false);
      };
    },
    drawBeauty: () => {
      renderer.render(scene, camera);
    },
  });

  function applyDrawDefaults() {
    Object.assign(state, createDrawDemoState());
    syncControlPanelToState(controlUi, state, panelRoot);
    camera = ctx.setOrthographicView(state.orthographic);
    updateChromeMaterial(previewMaterial, chromeOptionsFromState(state));
    if (sigilMaterial) updateRaymarchSigilMaterial(sigilMaterial, chromeOptionsFromState(state));
    refreshGuides();
    refreshPreview();
    scheduleRebuild(0);
  }

  function allStrokes() {
    return activeBuildPaths(strokes, current, state);
  }

  function scheduleRebuild(delay = 120) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, delay);
  }

  function refreshGuides() {
    clearGuides();
    guideGroup.visible = state.guides;
    if (!guideGroup.visible) return;
    for (const stroke of strokes) {
      const points = strokePoints(stroke);
      if (points.length < 2) continue;
      guideGroup.add(createGuideLine(points));
    }
    refreshCurrentGuide();
  }

  function createGuideLine(stroke) {
    const pts = stroke.map(([x, y]) => new THREE.Vector3(x, y, 0.012));
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), guideMat);
  }

  function disposeGuideLine(line) {
    line.geometry?.dispose?.();
  }

  function clearGuides() {
    for (const child of guideGroup.children) disposeGuideLine(child);
    guideGroup.clear();
    currentGuide = null;
  }

  function clearCurrentGuide() {
    if (!currentGuide) return;
    guideGroup.remove(currentGuide);
    disposeGuideLine(currentGuide);
    currentGuide = null;
  }

  function refreshCurrentGuide() {
    guideGroup.visible = state.guides;
    if (!guideGroup.visible || current.length < 2) {
      clearCurrentGuide();
      return;
    }

    const next = createGuideLine(current);
    if (currentGuide) {
      const old = currentGuide;
      guideGroup.remove(old);
      disposeGuideLine(old);
    }
    currentGuide = next;
    guideGroup.add(currentGuide);
  }

  function clearPreviewMesh() {
    previewMesh.visible = false;
    const old = previewMesh.geometry;
    previewMesh.geometry = new THREE.BufferGeometry();
    old.dispose();
  }

  function clearRaymarchMesh() {
    sigilMesh.visible = false;
    const old = sigilMesh.geometry;
    sigilMesh.geometry = new THREE.BufferGeometry();
    old.dispose();
  }

  function refreshPreview() {
    if (!state.previewStripOnly) {
      previewMesh.visible = false;
      return;
    }

    const paths = activeBuildPaths(strokes, current, state);
    if (paths.length === 0) {
      clearPreviewMesh();
      return;
    }

    const geometry = buildSparseCurveGeometry(paths, {
      ...sparsePreviewOptionsFromState(state),
      pointRadius: true,
      symmetry: 1,
      mirror: false,
      phase: 0,
    });
    const old = previewMesh.geometry;
    previewMesh.geometry = geometry;
    old.dispose();
    previewMesh.visible = (geometry.getAttribute('position')?.count ?? 0) > 0;
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
  let liveQueued = false;
  let liveRebuildTimer = 0;
  let lastLiveRebuildStart = 0;
  function scheduleLiveRebuild() {
    if (liveQueued) return;
    liveQueued = true;
    const wait = Math.max(0, LIVE_REBUILD_MIN_MS - (performance.now() - lastLiveRebuildStart));
    liveRebuildTimer = setTimeout(() => {
      building = building.then(runLive, runLive);
    }, wait);
  }
  function runLive() {
    liveQueued = false;
    lastLiveRebuildStart = performance.now();
    return runRebuild();
  }

  async function runRebuild() {
    let field = null;
    const previousPool = pool;
    if (signal.aborted) return;
    try {
      lastError = '';
      if (state.previewStripOnly) {
        clearRaymarchMesh();
        holdPreviewUntilRebuild = false;
        gridInfo = 'strip';
        refreshPreview();
        return;
      }
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
      const buildOpts = buildOptionsForSession(state);
      if (drawing) {
        // Live-drag rebuilds fire continuously; at the panel's top resolutions
        // (up to 640²) that saturates weak GPUs and can hang the browser. Cap
        // the in-drag grid — the release rebuild runs at full resolution.
        const liveRes = Math.min(buildOpts.resolution ?? 320, 320);
        buildOpts.resolution = liveRes;
        buildOpts.fieldResolution = liveRes;
      }
      field = await buildResidentField(renderer, active, buildOpts, pool);

      // Discard results that an unmount or a newer rebuild has superseded.
      if (version !== rebuildVersion || signal.aborted || state.previewStripOnly) {
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

      // Recreate the material only when its storage bindings or build-time
      // branch (profile) are stale; otherwise update grid uniforms in place.
      const profile = state.profile;
      const needNewMaterial = !sigilMaterial
        || field.reused === false
        || field.rawAttr !== builtRaw
        || field.smoothAttr !== builtSmooth
        || profile !== builtProfile;

      if (needNewMaterial) {
        const nextMaterial = createRaymarchSigilMaterial(field, chromeOptionsFromState(state));
        if (sigilMaterial) sigilMaterial.dispose();
        sigilMaterial = nextMaterial;
        sigilMesh.material = nextMaterial;
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
      pool = field;
      if (previousPool && previousPool !== field && field.reused === false) {
        previousPool.dispose?.(true);
      }

      holdPreviewUntilRebuild = false;
      if (!drawing) clearPreviewMesh();
    } catch (error) {
      if (field && field !== previousPool && field.reused === false) {
        field.dispose?.();
      }
      lastError = error?.message ?? String(error);
      console.error('meshless rebuild failed', error);
      // A transient field-build failure must not leave the canvas blank: release
      // the preview hold finishStroke() set so the next interaction can redraw.
      holdPreviewUntilRebuild = false;
      if (!drawing) clearPreviewMesh();
    }
  }

  function pushPoint(p) {
    if (!p) return false;
    const last = current[current.length - 1];
    if (last) {
      const dx = p[0] - last[0];
      const dy = p[1] - last[1];
      const minStep = state.minDrawStep;
      if (dx * dx + dy * dy < minStep * minStep) return false;
    }
    current.push(p);
    return true;
  }

  function finishStroke() {
    if (!drawing) return;
    drawing = false;
    activePointer = null;
    if (current.length >= 2) {
      strokes.push(makeStrokeRecord(current, state));
      redoStrokes.length = 0; // a fresh stroke invalidates the redo history
      holdPreviewUntilRebuild = !state.previewStripOnly;
    } else {
      refreshPreview();
    }
    current = [];
    refreshGuides();
    if (state.previewStripOnly) refreshPreview();
    else rebuild();
  }

  function cancelStrokeForGesture() {
    if (!drawing) return;
    drawing = false;
    activePointer = null;
    current = [];
    holdPreviewUntilRebuild = false;
    clearTimeout(liveRebuildTimer);
    liveQueued = false;
    refreshCurrentGuide();
    refreshPreview();
    rebuild();
  }

  function afterStrokesChanged() {
    holdPreviewUntilRebuild = false;
    clearPreviewMesh();
    refreshGuides();
    if (state.previewStripOnly) refreshPreview();
    else rebuild();
  }

  function undoStroke() {
    if (drawing) finishStroke();
    const popped = strokes.pop();
    if (popped) redoStrokes.push(popped);
    afterStrokesChanged();
  }

  function redoStroke() {
    const record = redoStrokes.pop();
    if (!record) return;
    strokes.push(record);
    afterStrokesChanged();
  }

  function clearAll() {
    if (drawing) finishStroke();
    // Clear is redoable: park every stroke on the redo stack instead of
    // dropping them, so an accidental Clear can be walked back.
    redoStrokes.push(...strokes.splice(0));
    current = [];
    afterStrokesChanged();
  }

  ui.defaults.addEventListener('click', applyDrawDefaults, { signal });
  ui.undo.addEventListener('click', undoStroke, { signal });
  ui.clear.addEventListener('click', clearAll, { signal });
  bindUndoRedoKeys({ undo: undoStroke, redo: redoStroke, signal });

  bindRightDragOrbit(ctx, { signal, getCamera: () => camera });

  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch') {
      touchPointers.add(event.pointerId);
      if (touchPointers.size > 1) {
        cancelStrokeForGesture();
        return;
      }
    }
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
    refreshCurrentGuide();
    refreshPreview();
  }, { signal });

  renderer.domElement.addEventListener('pointermove', (event) => {
    if (!drawing || event.pointerId !== activePointer) return;
    if (!pushPoint(planePoint(event))) return;
    refreshCurrentGuide();
    if (state.previewStripOnly) refreshPreview();
    else scheduleLiveRebuild(); // raymarch the in-progress stroke live as it's drawn
  }, { signal });

  renderer.domElement.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'touch') touchPointers.delete(event.pointerId);
    if (event.pointerId === activePointer) finishStroke();
  }, { signal });
  renderer.domElement.addEventListener('pointercancel', (event) => {
    if (event.pointerType === 'touch') touchPointers.delete(event.pointerId);
    if (event.pointerId === activePointer) cancelStrokeForGesture();
  }, { signal });

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
    clearTimeout(liveRebuildTimer);
    clearGuides();
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
