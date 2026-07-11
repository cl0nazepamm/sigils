/**
 * Paint-on-Mesh mode: drop a GLB onto the canvas (or use the built-in torus
 * knot), then draw on it with either Freehand or editable CV curves. CVs stay
 * surface-bound, expose tangent-plane center handles and variable-radius
 * rings, and can be edited through the original or mirrored display copy.
 * Freehand keeps left-drag painting; right-drag orbits in either tool.
 *
 * Strokes live in the target's LOCAL space so the sigil follows the mesh.
 * Every raw stroke is conformed before sweeping: arc-length resample →
 * Laplacian smooth (kills pointer jitter) → weld back onto the surface via a
 * closest-point mesh index (createMeshIndex — a raycast per point would
 * freeze on dense GLBs; the index makes it microseconds).
 *
 * The welded-volume backend commits with buildSurfaceVineFieldGeometry over
 * ALL strokes — an SDF smooth-min union, so crossings weld into one body.
 * Painting itself stays preview-free; geometry appears only on commit.
 * The surface-patch backend is the topology-safe alternative: it clips the
 * target's own triangles and displaces that open patch along target normals.
 *
 * All brush sizes are WORLD units, converted through the target's
 * normalization scale, so a GLB authored in millimeters and one authored in
 * meters get the same brush.
 */

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createMeshIndex } from '../../src/index.js';
import { bindRightDragOrbit } from '../shared/orbit.js';
import { bindUndoRedoKeys } from '../shared/hotkeys.js';
import { bindMeshGlbExportButton } from '../shared/glbExport.js';
import { createPathTraceRig } from '../shared/pathTraceRig.js';
import { mountControlPanel, syncControlPanelToState } from '../shared/controlPanel.js';
import { createInactiveTraceRigs, markUnsupported } from '../shared/unsupportedUi.js';
import { saveDemoAsset } from '../shared/demoPersistence.js';
import {
  clampCvRadiusScale,
  cvRadiusScaleFromDrag,
} from '../shared/strokeSession.js';
import {
  cleanSurfaceStrokeRecords,
  cloneSurfaceStrokeEdit,
  closestPointOnSurfacePolyline,
  captureSurfaceDrawSettings,
  cvInsertIndexNearSurfacePoint,
  inverseSurfaceCopySample,
  isSurfaceSplineRecord,
  makeSurfaceFreehandRecord,
  makeSurfaceSplineRecord,
  pickSurfaceCvControl,
  pickSurfaceStroke,
  restoreSurfaceStrokeEdit,
  surfaceStrokeCopyCount,
  transformSurfaceCopySample,
  updateSurfaceSplineRecord,
} from '../shared/surfaceStrokeSession.js';
import {
  SURFACE_DEFAULTS,
  TARGET_ASSET_KEY,
  snapshotTargetGeometry,
} from './surface/store.js';
import {
  SURFACE_CONTROL_SPECS,
  CONFORM_STEP,
  HANDLE_RADIUS_PX,
  PICK_RADIUS_PX,
  RADIUS_PICK_TOLERANCE_PX,
  TOUCH_HANDLE_RADIUS_PX,
  TOUCH_PICK_RADIUS_PX,
  TOUCH_RADIUS_TOLERANCE_PX,
  STROKE_PICK_PAD_PX,
  CLOSE_MIN_CVS,
  DOUBLE_CLICK_WINDOW_MS,
  DOUBLE_CLICK_SLOP_PX,
  MAX_HISTORY,
  NAVIGATION_PICK_DEBOUNCE_MS,
} from './surface/config.js';
import { createStrokePipeline } from './surface/strokePipeline.js';
export { serializeStore, restoreStore } from './surface/store.js';

export const meta = { id: 'surface', label: 'Paint on Mesh' };

export function mount(ctx, {
  panelRoot,
  infoRoot,
  store = {},
  interaction = null,
  requestPersist = () => {},
}) {
  const { THREE, renderer, scene, controls, renderBackend, setRasterBackdropHidden } = ctx;
  const abort = new AbortController();
  const { signal } = abort;
  const selectionBlocked = () => interaction?.blockSelection === true;
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;

  ctx.clearScene();
  setRasterBackdropHidden?.('paintOnMesh', true);

  // Left button paints, so OrbitControls must not own it; right-drag orbit
  // comes from bindRightDragOrbit (same convention as the other modes).
  controls.target.set(0, 0, 0);
  const camera = ctx.setCameraHome();
  // the flat-drawing home hugs the plane; back off to frame a unit-ish solid
  const fitDist = 1.5 / Math.tan(((camera.fov ?? 50) * Math.PI / 180) / 2);
  camera.position.setLength(fitDist);
  camera.lookAt(0, 0, 0);
  controls.update();
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
  const previousTouches = { ...controls.touches };
  controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
  renderer.domElement.style.cursor = 'crosshair';

  // Navigation and surface picking share the canvas. Keep expensive hover
  // queries asleep for the whole gesture plus a short settle window so wheel
  // bursts, orbit and pan never interleave with target raycasts.
  let navigationActive = false;
  let navigationBusyUntil = 0;
  const finishNavigation = () => {
    navigationActive = false;
    navigationBusyUntil = performance.now() + NAVIGATION_PICK_DEBOUNCE_MS;
  };
  const onControlsStart = () => { navigationActive = true; };
  const onControlsEnd = finishNavigation;
  controls.addEventListener('start', onControlsStart);
  controls.addEventListener('end', onControlsEnd);
  signal.addEventListener('abort', () => {
    controls.removeEventListener('start', onControlsStart);
    controls.removeEventListener('end', onControlsEnd);
  }, { once: true });
  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (event.button === 1 || event.button === 2) navigationActive = true;
  }, { capture: true, signal });
  renderer.domElement.addEventListener('pointerup', (event) => {
    if (event.button === 1 || event.button === 2) finishNavigation();
  }, { capture: true, signal });
  renderer.domElement.addEventListener('pointercancel', finishNavigation, { capture: true, signal });
  renderer.domElement.addEventListener('wheel', () => {
    navigationBusyUntil = performance.now() + NAVIGATION_PICK_DEBOUNCE_MS;
  }, { capture: true, passive: true, signal });

  // Settings, strokes and redo history live in the per-mode store so painted
  // work survives switching to another mode and back. (Initialized before the
  // meshes below — vineMaterial reads local.rough.)
  const local = (store.settings ??= { ...SURFACE_DEFAULTS });
  for (const [key, value] of Object.entries(SURFACE_DEFAULTS)) local[key] ??= value;
  if (!/^#[0-9a-f]{6}$/i.test(local.targetColor)) local.targetColor = SURFACE_DEFAULTS.targetColor;
  // Stores from before the control existed (or from the wider old range).
  local.rough = Math.min(local.rough ?? SURFACE_DEFAULTS.rough, 0.05);
  // Peak switched from absolute height to a ×width ratio; old absolute
  // values below the shallow-carve floor still get reset.
  if (!(local.peak >= 0.05 && local.peak <= 3)) local.peak = SURFACE_DEFAULTS.peak;
  if (!(local.conform >= 0 && local.conform <= 1.5)) local.conform = SURFACE_DEFAULTS.conform;
  if (!['welded', 'patch'].includes(local.surfaceBackend)) {
    local.surfaceBackend = SURFACE_DEFAULTS.surfaceBackend;
  }
  if (!['freehand', 'spline'].includes(local.drawTool)) local.drawTool = SURFACE_DEFAULTS.drawTool;
  local.symmetry = Math.max(1, Math.min(12, Math.floor(Number(local.symmetry) || 1)));
  local.cvRadiusScale = clampCvRadiusScale(local.cvRadiusScale);
  local.showActiveCvs = local.showActiveCvs !== false;
  local.guides = local.guides !== false;

  // Canonical authority survives mode switches/reloads; conformed samples are
  // target-dependent caches rebuilt below.
  const committed = cleanSurfaceStrokeRecords(store.committed);
  store.committed = committed;
  // Persisted redo records predate insertion indices. Replaying several of
  // them after a remount can reorder mixed freehand/CV sessions, so discard
  // that ambiguous channel here. New chronological history is mount-local;
  // serializeStore still canonicalizes `redo` for backwards data contracts.
  store.redo = [];
  const undoActions = [];
  const redoActions = [];
  const draftUndo = []; // right-click CV deletes inside an open draft

  // --- target mesh (replaceable by GLB drop) ---
  const targetMaterial = new THREE.MeshStandardMaterial({
    color: local.targetColor,
    metalness: local.targetMetalness,
    roughness: local.targetRoughness,
    envMapIntensity: local.targetEnvIntensity,
  });
  function applyTargetPbr() {
    targetMaterial.color.set(local.targetColor);
    targetMaterial.metalness = local.targetMetalness;
    targetMaterial.roughness = local.targetRoughness;
    targetMaterial.envMapIntensity = local.targetEnvIntensity;
  }

  function accelerateTargetRaycast(mesh) {
    const geometry = mesh.geometry;
    if (!geometry.boundsTree) {
      // Preserve imported index order: persisted CVs and the separate
      // closest-point index both treat that topology as authoritative.
      geometry.boundsTree = new MeshBVH(geometry, { indirect: true });
    }
    mesh.raycast = acceleratedRaycast;
  }

  // A dropped GLB (and its normalization scale) survives mode switches via
  // the store, so the painted sigil still fits when the user comes back.
  let target = new THREE.Mesh(
    store.targetGeometry ?? new THREE.TorusKnotGeometry(0.7, 0.28, 256, 48), targetMaterial,
  );
  accelerateTargetRaycast(target);
  if (store.targetScale3) target.scale.fromArray(store.targetScale3);
  else if (store.targetScale) target.scale.setScalar(store.targetScale);
  if (store.targetQuaternion) target.quaternion.fromArray(store.targetQuaternion);
  if (store.targetPosition) target.position.fromArray(store.targetPosition);
  scene.add(target);
  target.updateMatrixWorld(true);

  // closest-point index over the target, built lazily once per target
  let meshIndex = null;
  const getMeshIndex = () => (meshIndex ??= createMeshIndex(target.geometry));

  // metal needs punctual highlights on top of the env or it reads black
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
  keyLight.position.set(2, 3, 4);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x8899ff, 0.8);
  fillLight.position.set(-3, -1, 2);
  scene.add(fillLight);

  const vineMaterial = new THREE.MeshStandardMaterial({
    metalness: 1, roughness: local.rough, envMapIntensity: 1.8,
  });
  const drawCurveMaterial = new THREE.LineBasicMaterial({
    color: 0xffffff,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

  // vines live in the target's local space; the group mirrors its transform
  const vineGroup = new THREE.Group();
  scene.add(vineGroup);
  const syncGroup = () => {
    vineGroup.position.copy(target.position);
    vineGroup.quaternion.copy(target.quaternion);
    vineGroup.scale.copy(target.scale);
  };
  syncGroup();

  // Target-local editing overlays inherit the exact target transform through
  // vineGroup. Only the active/latest spline exposes controls.
  const overlay = new THREE.Group();
  overlay.renderOrder = 2100;
  vineGroup.add(overlay);
  const guideGroup = new THREE.Group();
  guideGroup.renderOrder = 2050;
  vineGroup.add(guideGroup);
  const handleGeometry = new THREE.CircleGeometry(1, 24);
  const radiusGuideGeometry = new THREE.RingGeometry(0.9, 1, 40);
  const handleMaterials = {
    draft: new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: true, depthWrite: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
    close: new THREE.MeshBasicMaterial({ color: 0xffd24d, depthTest: true, depthWrite: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
    committed: new THREE.MeshBasicMaterial({ color: 0x9fc2d8, depthTest: true, depthWrite: false, transparent: true, opacity: 0.82, side: THREE.DoubleSide }),
    active: new THREE.MeshBasicMaterial({ color: 0x6fd0ff, depthTest: true, depthWrite: false, transparent: true, opacity: 1, side: THREE.DoubleSide }),
  };
  const radiusGuideMaterials = {
    draft: new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: true, depthWrite: false, transparent: true, opacity: 0.22, side: THREE.DoubleSide }),
    committed: new THREE.MeshBasicMaterial({ color: 0x9fc2d8, depthTest: true, depthWrite: false, transparent: true, opacity: 0.2, side: THREE.DoubleSide }),
    active: new THREE.MeshBasicMaterial({ color: 0x6fd0ff, depthTest: true, depthWrite: false, transparent: true, opacity: 0.72, side: THREE.DoubleSide }),
  };
  const hullMaterial = new THREE.LineBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0.55, depthTest: true, depthWrite: false });
  const guideMaterial = new THREE.LineBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0.55, depthTest: true, depthWrite: false });
  const activeGuideMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: true, depthWrite: false });
  const hoverGuideMaterial = new THREE.LineBasicMaterial({ color: 0xffd24d, transparent: true, opacity: 0.95, depthTest: true, depthWrite: false });
  const zAxis = new THREE.Vector3(0, 0, 1);
  const overlayNormal = new THREE.Vector3();

  const targetCenterOffset = new THREE.Vector3();
  function recenterTarget() {
    if (!target.geometry.boundingSphere) target.geometry.computeBoundingSphere();
    targetCenterOffset.copy(target.geometry.boundingSphere?.center ?? new THREE.Vector3())
      .multiply(target.scale)
      .applyQuaternion(target.quaternion);
    target.position.copy(targetCenterOffset).multiplyScalar(-1);
  }

  function persistTargetTransform() {
    store.targetGeometry = target.geometry;
    store.targetScale = Math.abs(target.scale.x);
    store.targetScale3 = target.scale.toArray();
    store.targetQuaternion = target.quaternion.toArray();
    store.targetPosition = target.position.toArray();
  }

  async function persistTargetAsset() {
    try {
      await saveDemoAsset(TARGET_ASSET_KEY, snapshotTargetGeometry(target.geometry));
      store.targetAssetKey = TARGET_ASSET_KEY;
      requestPersist();
      return true;
    } catch (error) {
      delete store.targetAssetKey;
      requestPersist();
      console.warn('Paint-on-Mesh target save failed', error);
      return false;
    }
  }

  /** world units → target-local units (GLB drops get normalized by scale) */
  const unit = () => 1 / Math.max(1e-8, Math.abs(target.scale.x));

  let fieldMesh = null;    // fully blended output from the selected geometry backend
  const manualMeshes = new Map(); // record -> independent, unblended mesh
  let active = null;       // raw freehand {p, n, radiusScale} samples
  let activePointer = null;
  const touchPointers = new Set();
  let drawCurve = null;    // raw pointer guide only; never used to build the result
  let draft = null;        // { cvs, cvRadiusScales, hover }
  let drag = null;         // committed/draft CV center or radius transaction
  let selected = null;     // retained CV selection for the radius slider
  let activeRecord = null;
  let activeCopy = 0;
  let hoveredStroke = null;
  let lastPressEditedCv = false;
  let lastPlacedCv = null;
  let continueEndpoint = null;
  let importGeneration = 0;
  let radiusSliderEdit = null;
  let radiusSliderTimer = 0;

  const {
    projectSplinePoint,
    conformFreehand,
    conformSpline,
    conformRecord,
    geometryCenter,
    liveDrawSettings,
    recordDraw,
    clearCopyCache,
    samplesForCopy,
    fieldStrokes,
    buildCommittedGeometry,
  } = createStrokePipeline({
    getLocal: () => local,
    getTarget: () => target,
    getCommitted: () => committed,
    getMeshIndex,
    unit,
  });

  /* -------------------------------------------------------------- build */

  function disposeMesh(mesh) {
    if (!mesh) return;
    vineGroup.remove(mesh);
    mesh.geometry.dispose();
  }

  function disposeManualMeshes() {
    for (const mesh of manualMeshes.values()) disposeMesh(mesh);
    manualMeshes.clear();
  }

  function buildManualRecord(record) {
    const previous = manualMeshes.get(record);
    if (previous) disposeMesh(previous);
    manualMeshes.delete(record);
    const strokes = fieldStrokes([record]);
    if (!strokes.length) return;
    const geometry = buildCommittedGeometry(strokes);
    if ((geometry.getAttribute('position')?.count ?? 0) === 0) {
      geometry.dispose();
      return;
    }
    const mesh = new THREE.Mesh(geometry, vineMaterial);
    manualMeshes.set(record, mesh);
    vineGroup.add(mesh);
  }

  function rebuildField({ reconform = false, incrementalRecord = null } = {}) {
    if (reconform) {
      for (const rec of committed) {
        rec.conformed = conformRecord(rec);
        rec.conformedM = null;
        clearCopyCache(rec);
      }
    }
    disposeMesh(fieldMesh);
    fieldMesh = null;
    try {
      if (local.manualMeshing) {
        // The common drawing path appends one record, so only that record pays
        // the meshing cost. Edits/settings/history rebuild the independent set.
        if (incrementalRecord && !reconform && committed.includes(incrementalRecord)) {
          for (const [record, mesh] of manualMeshes) {
            if (committed.includes(record)) continue;
            disposeMesh(mesh);
            manualMeshes.delete(record);
          }
          buildManualRecord(incrementalRecord);
        } else {
          disposeManualMeshes();
          for (const record of committed) buildManualRecord(record);
        }
      } else {
        disposeManualMeshes();
        const strokes = fieldStrokes();
        if (strokes.length) {
          const geo = buildCommittedGeometry(strokes);
          if (geo.getAttribute('position')?.count > 0) {
            fieldMesh = new THREE.Mesh(geo, vineMaterial);
            vineGroup.add(fieldMesh);
          } else {
            geo.dispose();
          }
        }
      }
    } catch (error) {
      console.error('surface field rebuild failed', error);
    }
    updateInfo();
    pathTrace.syncSigil(); // selected committed geometry changed -> re-trace
  }

  function refreshDrawCurve() {
    disposeMesh(drawCurve);
    drawCurve = null;
    let source = null;
    if (active?.length >= 2) source = active;
    else if (draft?.preview?.length >= 2) source = draft.preview;
    else if (drag?.record && drag.record !== 'draft' && drag.record.conformed?.length >= 2) {
      source = drag.record.conformed;
    }
    if (!source) return;
    const draw = drag?.record && drag.record !== 'draft'
      ? recordDraw(drag.record)
      : liveDrawSettings();
    const positions = [];
    const copies = surfaceStrokeCopyCount(draw);
    for (let copyIndex = 0; copyIndex < copies; copyIndex++) {
      const path = copyIndex === 0
        ? source
        : source.map((sample) => projectCopySample(sample, draw, copyIndex));
      for (let i = 1; i < path.length; i++) {
        positions.push(...path[i - 1].p, ...path[i].p);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    drawCurve = new THREE.LineSegments(geo, drawCurveMaterial);
    drawCurve.renderOrder = 2000;
    vineGroup.add(drawCurve);
  }

  function cancelActiveStroke() {
    const pointerId = activePointer;
    active = null;
    activePointer = null;
    releasePointer(pointerId);
    disposeMesh(drawCurve);
    drawCurve = null;
    updateHints();
  }

  function updateInfo() {
    let verts = fieldMesh?.geometry.getAttribute('position')?.count ?? 0;
    for (const mesh of manualMeshes.values()) {
      verts += mesh.geometry.getAttribute('position')?.count ?? 0;
    }
    const geometryLabel = local.surfaceBackend === 'patch' ? 'surface patch' : 'welded volume';
    const backend = local.manualMeshing ? `manual · ${geometryLabel}` : geometryLabel;
    const strokeLabel = committed.length === 1 ? 'stroke' : 'strokes';
    const activeIndex = committed.indexOf(activeRecord);
    const copyCount = activeRecord ? surfaceStrokeCopyCount(recordDraw(activeRecord)) : 0;
    const activeTag = !draft && activeIndex >= 0
      ? ` · stroke ${activeIndex + 1}/${committed.length}${copyCount > 1 ? ` · copy ${activeCopy + 1}/${copyCount}` : ''}`
      : '';
    const radius = isSurfaceSplineRecord(activeRecord)
      ? selectedTarget()?.radii[selected.index]
      : null;
    const radiusTag = radius == null ? '' : ` · radius ×${radius.toFixed(2)}`;
    setStatus(`${committed.length} ${strokeLabel} · ${verts} verts · ${backend}${activeTag}${radiusTag}`);
    const undoButton = panelRoot.querySelector('#undo');
    const clearButton = panelRoot.querySelector('#clear');
    if (undoButton) undoButton.disabled = committed.length === 0 && undoActions.length === 0;
    if (clearButton) clearButton.disabled = committed.length === 0;
  }

  /** Transient status on the stats line (drop feedback, load errors). */
  function setStatus(msg) {
    const statsEl = infoRoot.querySelector('#stats');
    if (statsEl) statsEl.textContent = msg;
  }

  // sliders fire per input tick; the field rebuild is ~100ms, so trail it
  let rebuildTimer = 0;
  let pendingReconform = false;
  function scheduleRebuild(reconform) {
    pendingReconform = pendingReconform || reconform;
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = 0;
      const rc = pendingReconform;
      pendingReconform = false;
      rebuildField({ reconform: rc });
    }, 140);
  }

  /* ------------------------------------------------------- CV interaction */

  const scratchWorld = new THREE.Vector3();

  function splineRecords() {
    return committed.filter(isSurfaceSplineRecord);
  }

  function ensureActiveRecord(preferred = activeRecord) {
    if (selectionBlocked()) {
      activeRecord = null;
      activeCopy = 0;
      return null;
    }
    activeRecord = preferred && committed.includes(preferred)
      ? preferred
      : splineRecords().at(-1) ?? committed.at(-1) ?? null;
    activeCopy = activeRecord
      ? Math.min(surfaceStrokeCopyCount(recordDraw(activeRecord)) - 1, Math.max(0, activeCopy))
      : 0;
    return activeRecord;
  }

  function activateRecord(record, copyIndex = 0) {
    if (selectionBlocked()) return;
    if (!record || !committed.includes(record)) return;
    flushRadiusSliderHistory();
    const copy = Math.min(
      surfaceStrokeCopyCount(recordDraw(record)) - 1,
      Math.max(0, Math.floor(copyIndex) || 0),
    );
    const same = record === activeRecord && copy === activeCopy;
    if (same && (!isSurfaceSplineRecord(record) || local.showActiveCvs)) {
      refreshGuides();
      updateInfo();
      return;
    }
    activeRecord = record;
    activeCopy = copy;
    selected = null;
    hoveredStroke = null;
    if (isSurfaceSplineRecord(record) && !local.showActiveCvs) {
      local.showActiveCvs = true;
      const mounted = controlUi?.get('showActiveCvs');
      if (mounted) syncControlPanelToState(new Map([['showActiveCvs', mounted]]), local, panelRoot);
    }
    syncRadiusControl();
    refreshGuides();
    updateInfo();
  }

  function cycleActiveRecord(direction) {
    if (selectionBlocked()) return;
    if (draft || drag || active) return;
    if (committed.length < 2) return;
    const current = committed.indexOf(activeRecord);
    const start = current >= 0 ? current : committed.length - 1;
    activateRecord(committed[(start + direction + committed.length) % committed.length], 0);
  }

  function deleteActiveStroke() {
    flushRadiusSliderHistory();
    if (active) cancelActiveStroke();
    if (drag) cancelCvEdit();
    if (draft || !activeRecord) return;
    const index = committed.indexOf(activeRecord);
    if (index < 0) return;
    const record = activeRecord;
    committed.splice(index, 1);
    recordHistory({ type: 'remove', record, index });
    selected = null;
    activeRecord = null;
    activeCopy = 0;
    hoveredStroke = null;
    syncRadiusControl();
    refreshGuides();
    refreshDrawCurve();
    rebuildField();
  }

  function displayedCvs(record = activeRecord, copyIndex = activeCopy) {
    if (!isSurfaceSplineRecord(record)) return [];
    const draw = recordDraw(record);
    return record.cvs.map((cv) => projectCopySample(cv, draw, copyIndex));
  }

  function displayedPath(record, copyIndex = 0) {
    return samplesForCopy(record, copyIndex);
  }

  function selectedTarget() {
    if (!selected) return null;
    const cvs = selected.record === 'draft' ? draft?.cvs : selected.record?.cvs;
    const radii = selected.record === 'draft'
      ? draft?.cvRadiusScales
      : selected.record?.cvRadiusScales;
    if (!cvs?.[selected.index] || !Number.isFinite(radii?.[selected.index])) return null;
    return { ...selected, cvs, radii };
  }

  function syncRadiusControl() {
    const targetSelection = selectedTarget();
    if (targetSelection) local.cvRadiusScale = targetSelection.radii[targetSelection.index];
    const mounted = controlUi?.get('cvRadiusScale');
    const label = mounted?.row.querySelector('label');
    if (label) label.textContent = targetSelection ? 'Point width ×' : 'New point width ×';
    if (mounted) syncControlPanelToState(new Map([['cvRadiusScale', mounted]]), local, panelRoot);
  }

  function selectCv(record, index) {
    if (record !== 'draft' && selectionBlocked()) return;
    flushRadiusSliderHistory();
    selected = { record, index };
    if (record !== 'draft') activeRecord = record;
    syncRadiusControl();
    updateInfo();
  }

  function syncSelectionBlock() {
    if (selectionBlocked()) {
      if (drag?.record && drag.record !== 'draft') cancelCvEdit();
      if (selected?.record !== 'draft') selected = null;
      activeRecord = null;
      activeCopy = 0;
      hoveredStroke = null;
      continueEndpoint = null;
      renderer.domElement.style.cursor = 'crosshair';
    }
    syncRadiusControl();
    refreshGuides();
    updateHints();
    updateInfo();
  }

  function emptyGroup(group) {
    for (const child of [...group.children]) {
      if (!child.userData.sharedOverlayGeometry) child.geometry?.dispose();
    }
    group.clear();
  }

  function overlayLift() {
    return 0.004 * unit();
  }

  function liftedPoint(sample) {
    const lift = overlayLift();
    return new THREE.Vector3(
      sample.p[0] + sample.n[0] * lift,
      sample.p[1] + sample.n[1] * lift,
      sample.p[2] + sample.n[2] * lift,
    );
  }

  function orientToSample(mesh, sample) {
    overlayNormal.set(sample.n[0], sample.n[1], sample.n[2]).normalize();
    mesh.quaternion.setFromUnitVectors(zAxis, overlayNormal);
  }

  function addHandle(sample, material) {
    const mesh = new THREE.Mesh(handleGeometry, material);
    mesh.position.copy(liftedPoint(sample));
    orientToSample(mesh, sample);
    mesh.userData.isHandle = true;
    mesh.userData.sample = sample;
    mesh.userData.sharedOverlayGeometry = true;
    overlay.add(mesh);
  }

  function addRadiusGuide(sample, radiusScale, material) {
    const mesh = new THREE.Mesh(radiusGuideGeometry, material);
    mesh.position.copy(liftedPoint(sample));
    orientToSample(mesh, sample);
    const radius = local.width * unit() * clampCvRadiusScale(radiusScale);
    mesh.scale.set(radius, radius, 1);
    mesh.userData.sharedOverlayGeometry = true;
    overlay.add(mesh);
  }

  function addHull(cvs, closed) {
    if (cvs.length < 2) return;
    const points = cvs.map(liftedPoint);
    if (closed) points.push(points[0].clone());
    overlay.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), hullMaterial));
  }

  function addCurveGuide(path, material) {
    if (!path || path.length < 2) return;
    guideGroup.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(path.map(liftedPoint)),
      material,
    ));
  }

  function worldPerPixelAt(sample) {
    scratchWorld.set(sample.p[0], sample.p[1], sample.p[2]);
    target.localToWorld(scratchWorld);
    const rect = renderer.domElement.getBoundingClientRect();
    const distance = camera.position.distanceTo(scratchWorld);
    const world = (2 * distance * Math.tan(THREE.MathUtils.degToRad((camera.fov ?? 50) * 0.5)))
      / Math.max(1, rect.height);
    return world * unit();
  }

  function scaleHandles() {
    for (const child of overlay.children) {
      if (!child.userData.isHandle) continue;
      const scale = worldPerPixelAt(child.userData.sample) * HANDLE_RADIUS_PX;
      child.scale.set(scale, scale, scale);
    }
  }

  function refreshGuides() {
    emptyGroup(guideGroup);
    emptyGroup(overlay);

    // Curves checkbox: ambient centerlines for every non-active stroke.
    if (local.guides) {
      for (const record of committed) {
        if (record === activeRecord) continue;
        const copies = surfaceStrokeCopyCount(recordDraw(record));
        for (let copyIndex = 0; copyIndex < copies; copyIndex++) {
          const path = displayedPath(record, copyIndex);
          if (path?.length >= 2) addCurveGuide(path, guideMaterial);
        }
      }
      if (draft?.preview?.length >= 2) addCurveGuide(draft.preview, guideMaterial);
    }

    if (draft?.cvs.length) {
      addHull(draft.cvs, false);
      draft.cvs.forEach((cv, index) => {
        const activeCv = selected?.record === 'draft' && selected.index === index;
        const closable = index === 0 && draft.cvs.length >= CLOSE_MIN_CVS;
        addRadiusGuide(cv, draft.cvRadiusScales[index], activeCv ? radiusGuideMaterials.active : radiusGuideMaterials.draft);
        addHandle(cv, activeCv ? handleMaterials.active : closable ? handleMaterials.close : handleMaterials.draft);
      });
    } else if (isCvTool() && local.showActiveCvs && ensureActiveRecord()
      && isSurfaceSplineRecord(activeRecord)) {
      const cvs = displayedCvs();
      addHull(cvs, activeRecord.closed);
      cvs.forEach((cv, index) => {
        const activeCv = selected?.record === activeRecord && selected.index === index;
        const continuable = !activeRecord.closed && (index === 0 || index === cvs.length - 1);
        addRadiusGuide(cv, activeRecord.cvRadiusScales[index], activeCv ? radiusGuideMaterials.active : radiusGuideMaterials.committed);
        addHandle(cv, activeCv ? handleMaterials.active : continuable ? handleMaterials.close : handleMaterials.committed);
      });
      // Selected stroke is always highlighted, even with Curves off.
      addCurveGuide(displayedPath(activeRecord, activeCopy), activeGuideMaterial);
    } else if (!active && activeRecord && committed.includes(activeRecord)) {
      addCurveGuide(displayedPath(activeRecord, activeCopy), activeGuideMaterial);
    }

    if (!draft && !active && hoveredStroke
      && (hoveredStroke.record !== activeRecord || hoveredStroke.copyIndex !== activeCopy)) {
      addCurveGuide(hoveredStroke.path, hoverGuideMaterial);
    }
    overlay.visible = overlay.children.length > 0;
    guideGroup.visible = guideGroup.children.length > 0;
    updateHints();
  }

  function pickCv(hit, pointerType = 'mouse') {
    if (!hit) return null;
    const candidates = [];
    if (draft) {
      draft.cvs.forEach((cv, index) => candidates.push({
        record: 'draft', index, cv, radiusScale: draft.cvRadiusScales[index], copyIndex: 0,
      }));
    } else if (!selectionBlocked()
      && local.showActiveCvs && ensureActiveRecord() && isSurfaceSplineRecord(activeRecord)) {
      displayedCvs().forEach((cv, index) => candidates.push({
        record: activeRecord,
        index,
        cv,
        radiusScale: activeRecord.cvRadiusScales[index],
        copyIndex: activeCopy,
      }));
    }
    const pixel = worldPerPixelAt(hit);
    const touch = pointerType === 'touch';
    return pickSurfaceCvControl(hit, candidates, {
      baseRadius: local.width * unit(),
      handleRadius: pixel * (touch ? TOUCH_HANDLE_RADIUS_PX : HANDLE_RADIUS_PX),
      centerTolerance: pixel * (touch ? TOUCH_PICK_RADIUS_PX : PICK_RADIUS_PX),
      ringTolerance: pixel * (touch ? TOUCH_RADIUS_TOLERANCE_PX : RADIUS_PICK_TOLERANCE_PX),
      ringInnerRatio: 0.9,
      normalDotMin: -0.25,
    });
  }

  function pickOtherStroke(hit) {
    if (!hit || draft || selectionBlocked()) return null;
    const candidates = [];
    for (const record of committed) {
      const copies = surfaceStrokeCopyCount(recordDraw(record));
      for (let copyIndex = 0; copyIndex < copies; copyIndex++) {
        const path = displayedPath(record, copyIndex);
        if (path) candidates.push({ record, copyIndex, path });
      }
    }
    return pickSurfaceStroke(hit, candidates, {
      baseRadius: local.width * unit(),
      padding: worldPerPixelAt(hit) * STROKE_PICK_PAD_PX,
      normalDotMin: -0.25,
    });
  }

  function applySelectedRadius(value, { scheduleCommitted = true } = {}) {
    const scale = clampCvRadiusScale(value);
    local.cvRadiusScale = scale;
    const targetSelection = selectedTarget();
    if (!targetSelection) return;
    targetSelection.radii[targetSelection.index] = scale;
    if (targetSelection.record === 'draft') {
      syncRadiusControl();
      refreshDraftPreview();
      return;
    }
    updateSplineRecordFromAuthority(targetSelection.record);
    syncRadiusControl();
    refreshGuides();
    refreshDrawCurve();
    if (scheduleCommitted) scheduleRebuild(false);
  }

  function flushRadiusSliderHistory() {
    clearTimeout(radiusSliderTimer);
    radiusSliderTimer = 0;
    const transaction = radiusSliderEdit;
    radiusSliderEdit = null;
    if (!transaction || !committed.includes(transaction.record)) return;
    const after = cloneSurfaceStrokeEdit(transaction.record);
    if (JSON.stringify(transaction.before) === JSON.stringify(after)) return;
    recordHistory({
      type: 'edit',
      record: transaction.record,
      before: transaction.before,
      after,
    });
  }

  function applyRadiusSlider(value) {
    const targetSelection = selectedTarget();
    if (targetSelection?.record && targetSelection.record !== 'draft') {
      if (radiusSliderEdit
        && (radiusSliderEdit.record !== targetSelection.record
          || radiusSliderEdit.index !== targetSelection.index)) {
        flushRadiusSliderHistory();
      }
      radiusSliderEdit ??= {
        record: targetSelection.record,
        index: targetSelection.index,
        before: cloneSurfaceStrokeEdit(targetSelection.record),
      };
    }
    applySelectedRadius(value);
    if (radiusSliderEdit) {
      clearTimeout(radiusSliderTimer);
      // Native `change` ends mouse/touch slider gestures immediately. This
      // fallback also commits keyboard/context-menu edits as one transaction.
      radiusSliderTimer = setTimeout(flushRadiusSliderHistory, 1200);
    }
  }

  function updateSplineRecordFromAuthority(record) {
    updateSurfaceSplineRecord(record, record.cvs, record.closed, record.cvRadiusScales);
    record.conformed = conformRecord(record);
    record.conformedM = null;
    clearCopyCache(record);
  }

  function refreshDraftPreview() {
    if (!draft) {
      refreshDrawCurve();
      return;
    }
    const cvs = draft.hover && !drag ? [...draft.cvs, draft.hover] : draft.cvs;
    const radii = draft.hover && !drag
      ? [...draft.cvRadiusScales, clampCvRadiusScale(local.cvRadiusScale)]
      : draft.cvRadiusScales;
    draft.preview = cvs.length >= 2 ? conformSpline(cvs, false, radii) : null;
    refreshGuides();
    refreshDrawCurve();
  }

  function isCvTool() {
    return local.drawTool === 'spline';
  }

  function setControlVisible(key, visible) {
    const row = controlUi?.get(key)?.row;
    if (!row) return;
    row.hidden = !visible;
    row.style.display = visible ? '' : 'none';
  }

  function updateToolUi() {
    for (const button of panelRoot.querySelectorAll('[data-draw-tool]')) {
      const activeTool = button.dataset.drawTool === local.drawTool;
      button.classList.toggle('active', activeTool);
      button.setAttribute('aria-pressed', String(activeTool));
    }
    setControlVisible('flow', !isCvTool());
    setControlVisible('cvRadiusScale', isCvTool());
    setControlVisible('showActiveCvs', isCvTool());
    updateHints();
  }

  function updateHints() {
    const mouseHint = infoRoot.querySelector('.pointer-hint-mouse');
    const touchHint = infoRoot.querySelector('.pointer-hint-touch');
    if (!mouseHint && !touchHint) return;

    let mouse = '';
    let touch = '';
    if (!isCvTool()) {
      if (active) {
        mouse = 'left-drag: paint · release: finish stroke';
        touch = 'drag: paint · lift: finish stroke';
      } else if (selectionBlocked()) {
        mouse = 'left-drag: paint only · selection blocked · right-drag: orbit · drop/import .glb';
        touch = 'paint: one finger · selection blocked · two fingers: orbit/zoom';
      } else if (activeRecord) {
        mouse = 'left-drag: paint · Delete: remove selected · Tab: cycle · Shift-click: paint over · middle-click curve: insert · right-drag: orbit';
        touch = 'paint: one finger · tap stroke: switch · two fingers: orbit/zoom';
      } else {
        mouse = 'left-drag: paint · click stroke / Tab: select · Shift-click: paint over · right-drag: orbit · drop/import .glb';
        touch = 'paint: one finger · tap stroke: select · two fingers: orbit/zoom · pan: three fingers';
      }
    } else if (draft) {
      const canClose = draft.cvs.length >= CLOSE_MIN_CVS;
      mouse = canClose
        ? 'left-click: add CV · drag: place · right-click CV: delete · click first CV: close · dblclick empty / Enter: commit · Esc: cancel · Backspace: pop last'
        : 'left-click: add CV · drag: place · right-click CV: delete · Enter: commit (2+ CVs) · Esc: cancel · Backspace: pop last';
      touch = 'tap: add CV · drag: place · tap first CV: close · two fingers: orbit/zoom';
    } else if (selectionBlocked()) {
      mouse = 'left-click: place CV · selection blocked · right-drag: orbit';
      touch = 'tap: place CV · selection blocked · two fingers: orbit/zoom';
    } else if (activeRecord && isSurfaceSplineRecord(activeRecord) && local.showActiveCvs) {
      mouse = 'left-drag: move CV · drag ring: radius · middle-click: insert CV · right-click CV: delete · dblclick end: continue · Delete: remove stroke · Esc: deselect · right-drag: orbit';
      touch = 'drag dot: move · drag ring: radius · tap stroke: switch · two fingers: orbit/zoom';
    } else if (activeRecord) {
      mouse = 'click stroke: select · Tab: cycle · Delete: remove · Shift-click: new · left-click empty: start curve · right-drag: orbit';
      touch = 'tap stroke: switch · tap empty: start curve · two fingers: orbit/zoom';
    } else {
      mouse = 'left-click: place CV · click stroke / Tab: select · Shift-click: new · right-drag: orbit';
      touch = 'tap: place CV · tap stroke: select · two fingers: orbit/zoom';
    }

    if (mouseHint) mouseHint.textContent = mouse;
    if (touchHint) touchHint.textContent = touch;
  }

  /* ------------------------------------------------------------ painting */

  function setPointerRay(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
  }

  function surfaceHit(event) {
    setPointerRay(event);
    const hit = raycaster.intersectObject(target, false)[0];
    if (!hit || !hit.face) return null;
    return {
      p: target.worldToLocal(hit.point.clone()).toArray(),
      n: hit.face.normal.toArray(), // face normals are target-local already
    };
  }

  const radiusPlane = new THREE.Plane();
  const radiusPlanePoint = new THREE.Vector3();
  const radiusPlaneNormal = new THREE.Vector3();
  const radiusPlaneHit = new THREE.Vector3();
  function radiusPointerDistance(event, displayCv) {
    setPointerRay(event);
    radiusPlanePoint.set(...displayCv.p);
    target.localToWorld(radiusPlanePoint);
    radiusPlaneNormal.set(...displayCv.n).transformDirection(target.matrixWorld).normalize();
    radiusPlane.setFromNormalAndCoplanarPoint(radiusPlaneNormal, radiusPlanePoint);
    if (!raycaster.ray.intersectPlane(radiusPlane, radiusPlaneHit)) return null;
    target.worldToLocal(radiusPlaneHit);
    return Math.hypot(
      radiusPlaneHit.x - displayCv.p[0],
      radiusPlaneHit.y - displayCv.p[1],
      radiusPlaneHit.z - displayCv.p[2],
    );
  }

  function releasePointer(pointerId) {
    if (pointerId == null) return;
    try {
      renderer.domElement.releasePointerCapture(pointerId);
    } catch {
      // Capture may already have ended.
    }
  }

  function stopActivePointer() {
    const pointerId = activePointer;
    activePointer = null;
    releasePointer(pointerId);
  }

  // Central pressure seam: PointerEvent.pressure can map to this scale later
  // without changing records, conforming, or either geometry backend.
  function radiusScaleForPointer(_event) {
    return isCvTool() ? clampCvRadiusScale(local.cvRadiusScale) : 1;
  }

  function recordHistory(action) {
    undoActions.push(action);
    if (undoActions.length > MAX_HISTORY) undoActions.shift();
    redoActions.length = 0;
    store.redo.length = 0;
    requestPersist();
  }

  function syncPersistedRedo() {
    // Runtime actions carry object identity + insertion indices. The legacy
    // record-only channel cannot encode either safely, so never serialize a
    // replay that could corrupt chronological mixed-stroke order.
    store.redo.length = 0;
  }

  function refreshAfterHistory(preferred = null) {
    selected = null;
    hoveredStroke = null;
    activeRecord = preferred && committed.includes(preferred) ? preferred : null;
    ensureActiveRecord();
    syncRadiusControl();
    refreshGuides();
    refreshDrawCurve();
    rebuildField();
    syncPersistedRedo();
    requestPersist();
  }

  function applyHistoryAction(action, forward) {
    if (action.type === 'add') {
      if (forward) {
        if (!committed.includes(action.record)) {
          committed.splice(Math.min(action.index, committed.length), 0, action.record);
        }
        return action.record;
      }
      const index = committed.indexOf(action.record);
      if (index >= 0) committed.splice(index, 1);
      return null;
    }
    if (action.type === 'remove') {
      if (forward) {
        const index = committed.indexOf(action.record);
        if (index >= 0) committed.splice(index, 1);
        return null;
      }
      if (!committed.includes(action.record)) {
        committed.splice(Math.min(action.index, committed.length), 0, action.record);
      }
      return action.record;
    }
    if (action.type === 'replace') {
      const removeRecord = forward ? action.before : action.after;
      const insertRecord = forward ? action.after : action.before;
      const existing = committed.indexOf(removeRecord);
      const index = existing >= 0 ? existing : action.index;
      if (existing >= 0) committed.splice(existing, 1);
      if (!committed.includes(insertRecord)) {
        committed.splice(Math.min(index, committed.length), 0, insertRecord);
      }
      return insertRecord;
    }
    if (action.type === 'edit') {
      restoreSurfaceStrokeEdit(action.record, forward ? action.after : action.before);
      action.record.cvs = action.record.cvs.map((cv) =>
        projectSplinePoint(cv.p, { normal: cv.n }));
      action.record.conformed = conformRecord(action.record);
      action.record.conformedM = null;
      clearCopyCache(action.record);
      return action.record;
    }
    if (action.type === 'clear') {
      if (forward) committed.splice(0);
      else committed.push(...action.records);
      return forward ? null : action.records.at(-1) ?? null;
    }
    return null;
  }

  function undoAction() {
    flushRadiusSliderHistory();
    if (active) {
      cancelActiveStroke();
      return;
    }
    if (draft) {
      if (undoDraftDelete()) return;
      popDraftCv();
      return;
    }
    let action = undoActions.pop();
    if (!action && committed.length > 0) {
      const record = committed.at(-1);
      action = { type: 'add', record, index: committed.length - 1 };
    }
    if (!action) return;
    const preferred = applyHistoryAction(action, false);
    redoActions.push(action);
    refreshAfterHistory(preferred);
  }

  function redoAction() {
    flushRadiusSliderHistory();
    if (active || draft) return;
    const action = redoActions.pop();
    if (!action) return;
    const preferred = applyHistoryAction(action, true);
    undoActions.push(action);
    refreshAfterHistory(preferred);
  }

  function finishFreehandStroke() {
    if (!active) return;
    const raw = active;
    active = null;
    stopActivePointer();
    disposeMesh(drawCurve);
    drawCurve = null;
    const conformed = conformFreehand(raw);
    let addedRecord = null;
    if (conformed) {
      const record = makeSurfaceFreehandRecord(raw, {
        seed: committed.length * 7919 + 13,
        draw: liveDrawSettings(),
      });
      record.conformed = conformed;
      record.conformedM = null;
      clearCopyCache(record);
      const index = committed.length;
      committed.push(record);
      recordHistory({ type: 'add', record, index });
      activeRecord = selectionBlocked() ? null : record;
      activeCopy = 0;
      selected = null;
      hoveredStroke = null;
      addedRecord = record;
    }
    refreshGuides();
    rebuildField({ incrementalRecord: addedRecord });
  }

  function restoreContinuedStroke() {
    if (!draft?.continuedFrom) return false;
    const record = draft.continuedFrom;
    const index = Math.min(draft.continuedIndex ?? committed.length, committed.length);
    if (!committed.includes(record)) committed.splice(index, 0, record);
    activeRecord = selectionBlocked() ? null : record;
    activeCopy = 0;
    selected = selectionBlocked() ? null : { record, index: record.cvs.length - 1 };
    return true;
  }

  function continueCommittedSpline(record, end) {
    if (!isSurfaceSplineRecord(record) || record.closed || draft || active) return;
    flushRadiusSliderHistory();
    const index = committed.indexOf(record);
    if (index < 0) return;

    const cvs = record.cvs.map(({ p, n }) => ({ p: p.slice(), n: n.slice() }));
    const radii = record.cvRadiusScales.slice();
    if (end === 'start') {
      cvs.reverse();
      radii.reverse();
    }

    committed.splice(index, 1);
    if (selected?.record === record) selected = null;
    if (activeRecord === record) activeRecord = null;
    if (hoveredStroke?.record === record) hoveredStroke = null;
    draftUndo.length = 0;

    draft = {
      cvs,
      cvRadiusScales: radii,
      hover: null,
      preview: null,
      continuedFrom: record,
      continuedIndex: index,
    };
    continueEndpoint = null;
    lastPlacedCv = null;
    selectCv('draft', draft.cvs.length - 1);
    refreshDraftPreview();
    rebuildField();
  }

  function commitDraft(closed) {
    if (!draft || draft.cvs.length < 2) {
      cancelDraft();
      return;
    }
    stopActivePointer();
    drag = null;
    const continued = draft.continuedFrom;
    const continuedIndex = draft.continuedIndex;
    const record = makeSurfaceSplineRecord(
      draft.cvs,
      closed,
      draft.cvRadiusScales,
      {
        seed: continued?.seed ?? committed.length * 7919 + 13,
        id: continued?.id,
        draw: continued?.draw ?? liveDrawSettings(),
      },
    );
    record.conformed = conformRecord(record);
    if (!record.conformed) {
      cancelDraft();
      return;
    }
    record.conformedM = null;
    clearCopyCache(record);
    const index = continuedIndex != null
      ? Math.min(continuedIndex, committed.length)
      : committed.length;
    committed.splice(index, 0, record);
    if (continued) {
      recordHistory({ type: 'replace', index, before: continued, after: record });
    } else {
      recordHistory({ type: 'add', record, index });
    }
    const selectedIndex = Math.min(record.cvs.length - 1, Math.max(0, selected?.index ?? 0));
    draft = null;
    draftUndo.length = 0;
    lastPlacedCv = null;
    continueEndpoint = null;
    activeRecord = selectionBlocked() ? null : record;
    activeCopy = 0;
    selected = selectionBlocked() ? null : { record, index: selectedIndex };
    syncRadiusControl();
    refreshGuides();
    refreshDrawCurve();
    rebuildField({ incrementalRecord: continued ? null : record });
  }

  function cancelDraft() {
    stopActivePointer();
    drag = null;
    const restored = restoreContinuedStroke();
    if (selected?.record === 'draft') selected = null;
    draft = null;
    draftUndo.length = 0;
    lastPlacedCv = null;
    continueEndpoint = null;
    syncRadiusControl();
    refreshGuides();
    refreshDrawCurve();
    if (restored) rebuildField();
  }

  function popDraftCv() {
    if (!draft?.cvs.length) return;
    stopActivePointer();
    drag = null;
    draft.cvs.pop();
    draft.cvRadiusScales.pop();
    lastPlacedCv = null;
    if (draft.cvs.length === 0) {
      const restored = restoreContinuedStroke();
      draft = null;
      draftUndo.length = 0;
      if (selected?.record === 'draft') selected = null;
      syncRadiusControl();
      refreshGuides();
      refreshDrawCurve();
      if (restored) rebuildField();
      return;
    }
    if (selected?.record === 'draft' && selected.index >= draft.cvs.length) {
      selected.index = draft.cvs.length - 1;
    }
    syncRadiusControl();
    refreshDraftPreview();
  }

  function undoDraftDelete() {
    const entry = draftUndo.pop();
    if (!entry || !draft) return false;
    const index = Math.min(Math.max(0, entry.index), draft.cvs.length);
    draft.cvs.splice(index, 0, {
      p: entry.cv.p.slice(),
      n: entry.cv.n.slice(),
    });
    draft.cvRadiusScales.splice(index, 0, entry.radiusScale);
    selectCv('draft', index);
    syncRadiusControl();
    refreshDraftPreview();
    return true;
  }

  function cloneDraftEdit() {
    if (!draft) return null;
    return {
      cvs: draft.cvs.map(({ p, n }) => ({ p: p.slice(), n: n.slice() })),
      cvRadiusScales: draft.cvRadiusScales.slice(),
    };
  }

  function cancelCvEdit() {
    const pointerId = activePointer;
    if (drag?.record !== 'draft' && drag?.before) {
      restoreSurfaceStrokeEdit(drag.record, drag.before);
      drag.record.conformed = conformRecord(drag.record);
      drag.record.conformedM = null;
      clearCopyCache(drag.record);
    } else if (drag?.added && draft) {
      draft.cvs.splice(drag.index, 1);
      draft.cvRadiusScales.splice(drag.index, 1);
      if (draft.cvs.length === 0) draft = null;
    } else if (drag?.record === 'draft' && drag.before && draft) {
      draft.cvs = drag.before.cvs.map(({ p, n }) => ({ p: p.slice(), n: n.slice() }));
      draft.cvRadiusScales = drag.before.cvRadiusScales.slice();
    }
    drag = null;
    activePointer = null;
    releasePointer(pointerId);
    syncRadiusControl();
    refreshGuides();
    refreshDraftPreview();
  }

  function setDrawTool(next) {
    const tool = ['freehand', 'spline'].includes(next) ? next : 'freehand';
    if (tool === local.drawTool) return;
    flushRadiusSliderHistory();
    if (active) finishFreehandStroke();
    if (drag) cancelCvEdit();
    if (draft) {
      if (draft.cvs.length >= 2) commitDraft(false);
      else cancelDraft();
    }
    local.drawTool = tool;
    hoveredStroke = null;
    updateToolUi();
    syncRadiusControl();
    refreshGuides();
    refreshDrawCurve();
    requestPersist();
  }

  function updatePointerHover(hit, pointerType, forceNew) {
    const suppressPicking = (forceNew || selectionBlocked()) && !draft;
    const pick = isCvTool() && !suppressPicking ? pickCv(hit, pointerType) : null;
    const strokePick = !suppressPicking && !pick ? pickOtherStroke(hit) : null;
    const changed = hoveredStroke?.record !== strokePick?.record
      || hoveredStroke?.copyIndex !== strokePick?.copyIndex;
    hoveredStroke = strokePick;
    if (draft) {
      draft.hover = pick ? null : hit;
      refreshDraftPreview();
    } else if (changed) refreshGuides();
    renderer.domElement.style.cursor = pick?.kind === 'radius'
      ? 'nwse-resize'
      : pick
        ? 'grab'
        : strokePick
          ? 'pointer'
          : 'crosshair';
  }

  /** Middle-click: insert a CV on the selected committed spline only. */
  function tryInsertCvAtPointer(event) {
    if (selectionBlocked()) return false;
    if (active || drag || draft) return false;
    if (!isSurfaceSplineRecord(activeRecord) || !committed.includes(activeRecord)) return false;
    const hit = surfaceHit(event);
    if (!hit) return false;
    if (pickCv(hit, event.pointerType)) return false;

    const candidates = [];
    const copies = surfaceStrokeCopyCount(recordDraw(activeRecord));
    for (let copy = 0; copy < copies; copy++) {
      const path = displayedPath(activeRecord, copy);
      if (path) candidates.push({ record: activeRecord, copyIndex: copy, path });
    }
    const strokePick = pickSurfaceStroke(hit, candidates, {
      baseRadius: local.width * unit(),
      padding: worldPerPixelAt(hit) * STROKE_PICK_PAD_PX,
      normalDotMin: -0.25,
    });
    if (!strokePick?.closest?.p || !strokePick.closest?.n) return false;

    const targetRecord = activeRecord;
    const copyIndex = strokePick.copyIndex;
    const closest = strokePick.closest;
    if (!isCvTool()) setDrawTool('spline');

    const displaySample = {
      p: closest.p.slice(),
      n: closest.n.slice(),
      radiusScale: clampCvRadiusScale(closest.radiusScale),
    };
    const authority = inverseSurfaceCopySample(displaySample, recordDraw(targetRecord), copyIndex);
    const projected = projectSplinePoint(authority.p, {
      normal: authority.n,
      alignNormal: true,
    });
    const cvs = targetRecord.cvs;
    const radii = targetRecord.cvRadiusScales;
    const before = cloneSurfaceStrokeEdit(targetRecord);
    // Re-projected mirror paths are not arc-length-equivalent to their source.
    // Choose the authoritative control-hull gap nearest the mapped surface hit.
    const insertAt = cvInsertIndexNearSurfacePoint(
      cvs,
      targetRecord.closed === true,
      projected.p,
    );

    cvs.splice(insertAt, 0, { p: projected.p, n: projected.n });
    radii.splice(insertAt, 0, clampCvRadiusScale(authority.radiusScale));
    updateSplineRecordFromAuthority(targetRecord);
    activeCopy = copyIndex;

    selectCv(targetRecord, insertAt);
    activePointer = event.pointerId;
    try {
      renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      // Some event sources do not create a capturable pointer.
    }
    drag = {
      kind: 'move',
      record: targetRecord,
      index: insertAt,
      copyIndex,
      before,
      added: true,
      moved: false,
    };
    lastPressEditedCv = true;
    lastPlacedCv = null;
    hoveredStroke = null;
    renderer.domElement.style.cursor = 'grabbing';
    refreshGuides();
    refreshDrawCurve();
    return true;
  }

  /** Right-click: delete a CV on the draft or the active committed spline. */
  function tryDeleteCvAtPointer(event) {
    if (active || drag) return false;
    if (!isCvTool()) return false;
    const hit = surfaceHit(event);
    if (!hit) return false;
    const pick = pickCv(hit, event.pointerType);
    if (!pick || pick.kind === 'radius') return false;

    if (pick.record === 'draft') {
      if (!draft?.cvs.length) return false;
      const [cv] = draft.cvs.splice(pick.index, 1);
      const [radiusScale] = draft.cvRadiusScales.splice(pick.index, 1);
      draftUndo.push({
        index: pick.index,
        cv: { p: cv.p.slice(), n: cv.n.slice() },
        radiusScale,
      });
      lastPlacedCv = null;
      if (draft.cvs.length === 0) {
        const restored = restoreContinuedStroke();
        draft = null;
        draftUndo.length = 0;
        if (selected?.record === 'draft') selected = null;
        syncRadiusControl();
        refreshGuides();
        refreshDrawCurve();
        if (restored) rebuildField();
        return true;
      }
      if (selected?.record === 'draft') {
        selected.index = Math.min(selected.index, draft.cvs.length - 1);
      }
      syncRadiusControl();
      refreshDraftPreview();
      return true;
    }

    if (pick.record !== activeRecord || !isSurfaceSplineRecord(activeRecord)) return false;
    const record = activeRecord;
    flushRadiusSliderHistory();
    if (record.cvs.length <= 2) {
      const index = committed.indexOf(record);
      if (index < 0) return false;
      committed.splice(index, 1);
      recordHistory({ type: 'remove', record, index });
      selected = null;
      activeRecord = null;
      activeCopy = 0;
      hoveredStroke = null;
      syncRadiusControl();
      refreshGuides();
      refreshDrawCurve();
      rebuildField();
      return true;
    }

    const before = cloneSurfaceStrokeEdit(record);
    record.cvs.splice(pick.index, 1);
    record.cvRadiusScales.splice(pick.index, 1);
    updateSplineRecordFromAuthority(record);
    if (selected?.record === record) {
      selected.index = Math.min(selected.index, record.cvs.length - 1);
    }
    recordHistory({
      type: 'edit',
      record,
      before,
      after: cloneSurfaceStrokeEdit(record),
    });
    syncRadiusControl();
    refreshGuides();
    refreshDrawCurve();
    rebuildField();
    return true;
  }

  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (event.button !== 1) return;
    if (!tryInsertCvAtPointer(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { signal, capture: true });

  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch') {
      touchPointers.add(event.pointerId);
      if (touchPointers.size > 1) {
        if (active) cancelActiveStroke();
        else cancelCvEdit();
        return;
      }
    }
    if (event.button !== 0) return;
    const hit = surfaceHit(event);
    if (!hit) return;
    activePointer = event.pointerId;
    try {
      renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      // Some event sources do not create a capturable pointer.
    }

    if (!isCvTool()) {
      const forceNew = event.shiftKey || selectionBlocked();
      const strokePick = forceNew ? null : pickOtherStroke(hit);
      if (strokePick) {
        stopActivePointer();
        activateRecord(strokePick.record, strokePick.copyIndex);
        renderer.domElement.style.cursor = 'pointer';
        return;
      }
      active = [{ ...hit, radiusScale: radiusScaleForPointer(event) }];
      refreshDrawCurve();
      updateHints();
      return;
    }

    const forceNew = (event.shiftKey || selectionBlocked()) && !draft;
    let pick = forceNew ? null : pickCv(hit, event.pointerType);
    const strokePick = !forceNew && !pick ? pickOtherStroke(hit) : null;
    const repeatsPlacedTail = !!pick
      && pick.record === 'draft'
      && pick.index === lastPlacedCv?.index
      && event.timeStamp - lastPlacedCv.timeStamp <= DOUBLE_CLICK_WINDOW_MS
      && Math.hypot(event.clientX - lastPlacedCv.clientX, event.clientY - lastPlacedCv.clientY)
        <= DOUBLE_CLICK_SLOP_PX;
    // Let the second click place its temporary duplicate; dblclick removes
    // that duplicate before committing. Treating it as a handle edit would
    // make dblclick pop the real tail CV instead.
    if (repeatsPlacedTail) pick = null;
    lastPressEditedCv = (!!pick && !repeatsPlacedTail) || !!strokePick;
    if ((pick && !repeatsPlacedTail) || strokePick) lastPlacedCv = null;

    if (strokePick) {
      stopActivePointer();
      continueEndpoint = null;
      activateRecord(strokePick.record, strokePick.copyIndex);
      return;
    }
    if (pick?.kind === 'move' && pick.record === 'draft' && pick.index === 0
      && draft.cvs.length >= CLOSE_MIN_CVS && !event.shiftKey) {
      selectCv('draft', 0);
      commitDraft(true);
      return;
    }
    if (pick) {
      selectCv(pick.record, pick.index);
      if (pick.record !== 'draft' && isSurfaceSplineRecord(pick.record) && !pick.record.closed) {
        const last = pick.record.cvs.length - 1;
        if (pick.index === 0 || pick.index === last) {
          continueEndpoint = {
            record: pick.record,
            end: pick.index === 0 ? 'start' : 'end',
            timeStamp: event.timeStamp,
            clientX: event.clientX,
            clientY: event.clientY,
          };
        } else {
          continueEndpoint = null;
        }
      } else {
        continueEndpoint = null;
      }
      const before = pick.record === 'draft' ? cloneDraftEdit() : cloneSurfaceStrokeEdit(pick.record);
      if (pick.kind === 'radius') {
        const displayCv = pick.cv;
        drag = {
          kind: 'radius',
          record: pick.record,
          index: pick.index,
          copyIndex: pick.copyIndex ?? 0,
          startRadius: selectedTarget().radii[pick.index],
          startDistance: radiusPointerDistance(event, displayCv)
            ?? Math.hypot(
              hit.p[0] - displayCv.p[0], hit.p[1] - displayCv.p[1], hit.p[2] - displayCv.p[2],
            ),
          before,
          moved: false,
        };
        renderer.domElement.style.cursor = 'nwse-resize';
      } else {
        drag = {
          kind: 'move',
          record: pick.record,
          index: pick.index,
          copyIndex: pick.copyIndex ?? 0,
          before,
          moved: false,
        };
        renderer.domElement.style.cursor = 'grabbing';
      }
      refreshGuides();
      return;
    }

    continueEndpoint = null;
    draftUndo.length = 0;
    if (!draft) draft = { cvs: [], cvRadiusScales: [], hover: null, preview: null };
    draft.cvs.push(hit);
    draft.cvRadiusScales.push(radiusScaleForPointer(event));
    drag = {
      kind: 'move', record: 'draft', index: draft.cvs.length - 1, copyIndex: 0, added: true, moved: false,
    };
    lastPlacedCv = {
      index: drag.index,
      timeStamp: event.timeStamp,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    selectCv('draft', drag.index);
    refreshDraftPreview();
  }, { signal });

  renderer.domElement.addEventListener('pointermove', (event) => {
    // Middle-pan and right-orbit are navigation, not surface editing. Never
    // brute-force raycast the imported target during those moves: a dense GLB
    // can contain nearly a million triangles, turning each pan event into a
    // full-mesh intersection pass. Preserve middle-click CV insertion once it
    // has claimed activePointer; that is an edit, not navigation.
    const editingPointer = event.pointerId === activePointer;
    const navigating = !editingPointer && (
      navigationActive
      || (event.buttons & 6) !== 0
      || performance.now() < navigationBusyUntil
    );
    if (navigating) return;

    if (!isCvTool()) {
      if (active && event.pointerId === activePointer) {
        const hit = surfaceHit(event);
        if (!hit) return;
        const last = active.at(-1);
        const minStep = CONFORM_STEP * 0.5 * unit();
        if (Math.hypot(
          hit.p[0] - last.p[0], hit.p[1] - last.p[1], hit.p[2] - last.p[2],
        ) < minStep) return;
        active.push({ ...hit, radiusScale: radiusScaleForPointer(event) });
        refreshDrawCurve();
        return;
      }
      updatePointerHover(surfaceHit(event), event.pointerType, event.shiftKey);
      return;
    }

    if (drag && event.pointerId === activePointer) {
      drag.moved = true;
      if (drag.kind === 'radius') {
        const cvs = drag.record === 'draft' ? draft?.cvs : drag.record.cvs;
        const baseCv = cvs?.[drag.index];
        if (!baseCv) return;
        const displayCv = drag.record === 'draft'
          ? baseCv
          : transformSurfaceCopySample(baseCv, recordDraw(drag.record), drag.copyIndex);
        const currentDistance = radiusPointerDistance(event, displayCv);
        if (currentDistance == null) return;
        const scale = cvRadiusScaleFromDrag(
          drag.startRadius,
          drag.startDistance,
          currentDistance,
          local.width * 2 * unit(),
        );
        applySelectedRadius(scale, { scheduleCommitted: false });
        return;
      }
      const hit = surfaceHit(event);
      if (!hit) return;
      if (drag.record === 'draft') {
        draft.cvs[drag.index] = hit;
        refreshDraftPreview();
      } else {
        const authority = inverseSurfaceCopySample(hit, recordDraw(drag.record), drag.copyIndex);
        drag.record.cvs[drag.index] = authority;
        updateSplineRecordFromAuthority(drag.record);
        refreshGuides();
        refreshDrawCurve();
      }
      return;
    }
    updatePointerHover(surfaceHit(event), event.pointerType, event.shiftKey);
  }, { signal });

  renderer.domElement.addEventListener('pointerleave', () => {
    if (drag) return;
    const changed = !!hoveredStroke;
    hoveredStroke = null;
    if (draft?.hover) {
      draft.hover = null;
      refreshDraftPreview();
    } else if (changed) refreshGuides();
  }, { signal });

  function endPointer(event) {
    if (event.pointerType === 'touch') touchPointers.delete(event.pointerId);
    if (event.pointerId !== activePointer) return;
    if (active) {
      finishFreehandStroke();
      return;
    }
    stopActivePointer();
    if (!drag) return;
    const finished = drag;
    drag = null;
    if (finished.record !== 'draft' && finished.before && (finished.moved || finished.added)) {
      const after = cloneSurfaceStrokeEdit(finished.record);
      recordHistory({ type: 'edit', record: finished.record, before: finished.before, after });
      rebuildField({ incrementalRecord: finished.record });
    }
    refreshGuides();
    refreshDrawCurve();
    updatePointerHover(surfaceHit(event), event.pointerType, event.shiftKey);
  }

  renderer.domElement.addEventListener('pointerup', endPointer, { signal });
  renderer.domElement.addEventListener('pointercancel', (event) => {
    if (event.pointerType === 'touch') touchPointers.delete(event.pointerId);
    if (event.pointerId !== activePointer) return;
    if (active) cancelActiveStroke();
    else cancelCvEdit();
  }, { signal });

  renderer.domElement.addEventListener('dblclick', (event) => {
    if (!draft && continueEndpoint
      && event.timeStamp - continueEndpoint.timeStamp <= DOUBLE_CLICK_WINDOW_MS
      && Math.hypot(
        event.clientX - continueEndpoint.clientX,
        event.clientY - continueEndpoint.clientY,
      ) <= DOUBLE_CLICK_SLOP_PX) {
      const { record, end } = continueEndpoint;
      continueEndpoint = null;
      lastPlacedCv = null;
      if (committed.includes(record) && isSurfaceSplineRecord(record) && !record.closed) {
        if (!isCvTool()) setDrawTool('spline');
        continueCommittedSpline(record, end);
      }
      return;
    }

    if (!draft || lastPressEditedCv) {
      lastPlacedCv = null;
      continueEndpoint = null;
      return;
    }
    if (draft.cvs.length >= 2) {
      draft.cvs.pop();
      draft.cvRadiusScales.pop();
    }
    commitDraft(false);
  }, { signal });

  addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const canvasContext = event.target === renderer.domElement || event.target === document.body;
    if (event.key === 'Tab' && !selectionBlocked()
      && !draft && !active && canvasContext && committed.length > 1) {
      event.preventDefault();
      cycleActiveRecord(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Enter' && draft) {
      commitDraft(false);
    } else if (event.key === 'Escape') {
      if (draft) cancelDraft();
      else if (selected) {
        selected = null;
        syncRadiusControl();
        refreshGuides();
      } else if (activeRecord) {
        selected = null;
        activeRecord = null;
        activeCopy = 0;
        hoveredStroke = null;
        syncRadiusControl();
        refreshGuides();
      }
    } else if (event.key === 'Backspace' && draft) {
      event.preventDefault();
      popDraftCv();
    } else if ((event.key === 'Delete' || event.key === 'Backspace')
      && !draft && !active && activeRecord) {
      event.preventDefault();
      deleteActiveStroke();
    }
  }, { signal });

  // --- GLB import replaces the target (picker for touch, drop for desktop) ---
  function disposeParsedGeometry(gltf) {
    const disposed = new Set();
    gltf?.scene?.traverse((object) => {
      const geometry = object.geometry;
      if (!geometry || disposed.has(geometry)) return;
      disposed.add(geometry);
      geometry.dispose();
    });
  }

  async function loadTargetFile(file) {
    if (!file) {
      setStatus('choose a .glb file to replace the mesh');
      return;
    }
    const generation = ++importGeneration;
    const stale = () => signal.aborted || generation !== importGeneration;
    setStatus(`loading ${file.name}…`);
    let buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (err) {
      if (stale()) return;
      console.warn('GLB read failed', err);
      setStatus(`couldn't read ${file.name}`);
      return;
    }
    if (stale()) return;
    new GLTFLoader().parse(buffer, '', (gltf) => {
      if (stale()) {
        disposeParsedGeometry(gltf);
        return;
      }
      gltf.scene.updateMatrixWorld(true);
      const parts = [];
      gltf.scene.traverse((o) => {
        if (!o.isMesh || !o.geometry?.getAttribute('position')) return;
        const part = o.geometry.clone();
        part.applyMatrix4(o.matrixWorld);
        parts.push(part);
      });
      // The flattened clones below are the only geometry retained by the
      // mode; the loader-owned graph is temporary in both success/stale paths.
      disposeParsedGeometry(gltf);
      if (stale()) {
        parts.forEach((part) => part.dispose());
        return;
      }
      if (!parts.length) {
        setStatus(`no mesh found in ${file.name}`);
        return;
      }
      const geo = parts.length === 1
        ? parts[0]
        : BufferGeometryUtils.mergeGeometries(parts, false);
      if (!geo) {
        parts.forEach((part) => part.dispose());
        setStatus(`couldn't flatten ${file.name}: mesh attributes differ`);
        return;
      }
      if (parts.length > 1) parts.forEach((part) => part.dispose());
      if (stale()) {
        geo.dispose();
        return;
      }
      // Frame the untouched flattened geometry through the target transform;
      // do not translate, rotate, weld or rebuild its vertex data.
      geo.computeBoundingSphere();
      const c = geo.boundingSphere.center;
      const s = 1 / (geo.boundingSphere.radius || 1);
      scene.remove(target);
      target.geometry.boundsTree = null;
      target.geometry.dispose();
      target = new THREE.Mesh(geo, targetMaterial);
      accelerateTargetRaycast(target);
      target.scale.setScalar(s);
      target.position.set(-c.x * s, -c.y * s, -c.z * s);
      scene.add(target);
      target.updateMatrixWorld(true);
      persistTargetTransform();
      meshIndex = null;
      getMeshIndex(); // build now so the first stroke doesn't hiccup
      syncGroup();
      if (active) cancelActiveStroke();
      if (drag) cancelCvEdit();
      if (draft) cancelDraft();
      committed.length = 0;
      undoActions.length = 0;
      redoActions.length = 0;
      store.redo.length = 0;
      activeRecord = null;
      selected = null;
      hoveredStroke = null;
      refreshGuides();
      rebuildField();
      void persistTargetAsset().then((savedTarget) => {
        if (stale()) return;
        setStatus(savedTarget
          ? `${file.name} loaded · target saved in this browser`
          : `${file.name} loaded · target storage unavailable`);
      });
    }, (err) => {
      if (stale()) return;
      console.warn('GLB parse failed', err);
      setStatus(`couldn't parse ${file.name} as GLB`);
    });
  }

  renderer.domElement.addEventListener('dragover', (e) => e.preventDefault(), { signal });
  renderer.domElement.addEventListener('drop', (e) => {
    e.preventDefault();
    void loadTargetFile(e.dataTransfer?.files?.[0]);
  }, { signal });

  bindRightDragOrbit(ctx, {
    signal,
    getCamera: () => camera,
    onClick: (event) => tryDeleteCvAtPointer(event),
  });

  // --- panel: same spec-driven metal UI as the field modes ---
  panelRoot.innerHTML = `
    <div class="mode-head">
      <h2>Paint on Mesh</h2>
      <div class="draw-tools" role="group" aria-label="Surface drawing tool">
        <button type="button" data-draw-tool="freehand" aria-pressed="false">Freehand</button>
        <button type="button" data-draw-tool="spline" aria-pressed="false">Curve</button>
      </div>
    </div>
    <div id="controls"></div>
    <details id="mesh-tools" class="control-section control-details mesh-tools">
      <summary class="section-title">Mesh tools</summary>
      <div class="mesh-tools-grid">
        <button type="button" data-mesh-rotate="x" data-turn="-1" title="Rotate −90° around X">X −90</button>
        <button type="button" data-mesh-rotate="x" data-turn="1" title="Rotate +90° around X">X +90</button>
        <button type="button" data-mesh-flip="x" title="Reflect across the local X axis">Flip X</button>
        <button type="button" data-mesh-rotate="y" data-turn="-1" title="Rotate −90° around Y">Y −90</button>
        <button type="button" data-mesh-rotate="y" data-turn="1" title="Rotate +90° around Y">Y +90</button>
        <button type="button" data-mesh-flip="y" title="Reflect across the local Y axis">Flip Y</button>
        <button type="button" data-mesh-rotate="z" data-turn="-1" title="Rotate −90° around Z">Z −90</button>
        <button type="button" data-mesh-rotate="z" data-turn="1" title="Rotate +90° around Z">Z +90</button>
        <button type="button" data-mesh-flip="z" title="Reflect across the local Z axis">Flip Z</button>
        <button type="button" class="mesh-tool-wide" data-mesh-faces title="Reverse triangle winding and normals">Flip faces</button>
        <button type="button" class="mesh-tool-wide" data-mesh-reset title="Restore imported orientation">Reset transform</button>
      </div>
    </details>
    <div class="buttons">
      <button id="defaults" type="button">Defaults</button>
      <button id="undo" type="button">Undo</button>
      <button id="clear" type="button">Clear</button>
      <button id="import-glb" type="button">Import mesh</button>
      <button id="export-glb" type="button">Export GLB</button>
      <button id="pathtrace" type="button">Path trace</button>
    </div>
    <input id="import-glb-file" type="file" accept=".glb,model/gltf-binary" hidden />
    <div id="pathtrace-controls" hidden></div>
  `;
  infoRoot.innerHTML = '<b>Sigils Creator · Paint on Mesh</b><br /><span id="stats">—</span><br /><span class="hint pointer-hint-mouse"></span><span class="hint pointer-hint-touch"></span>';
  const controlsRoot = panelRoot.querySelector('#controls');
  const controlUi = mountControlPanel(controlsRoot, SURFACE_CONTROL_SPECS, local, {
    // flow changes the conform itself, so committed strokes must re-conform
    onChange: (key) => {
      if (key === 'cvRadiusScale') {
        applyRadiusSlider(local.cvRadiusScale);
        requestPersist();
        return;
      }
      if (key === 'showActiveCvs') {
        if (!local.showActiveCvs) selected = null;
        syncRadiusControl();
        refreshGuides();
        requestPersist();
        return;
      }
      if (key === 'guides') {
        refreshGuides();
        requestPersist();
        return;
      }
      if (key === 'manualMeshing') {
        clearTimeout(rebuildTimer);
        rebuildTimer = 0;
        pendingReconform = false;
        rebuildField();
        requestPersist();
        return;
      }
      if (key === 'surfaceBackend') {
        syncBackendUi();
      }
      if (key === 'symmetry' || key === 'mirror') {
        // Per-stroke capture: panel values only affect new strokes / live draft guides.
        if (activeRecord) {
          activeCopy = Math.min(activeCopy, surfaceStrokeCopyCount(recordDraw(activeRecord)) - 1);
        }
        refreshDrawCurve();
        refreshGuides();
        requestPersist();
        return;
      }
      if (key === 'width') refreshGuides();
      scheduleRebuild(key === 'flow');
      requestPersist();
    },
    onLive: (key) => {
      if (key === 'rough') {
        vineMaterial.roughness = local.rough;
        vineMaterial.needsUpdate = true;
        pathTrace.syncSigil(); // tracer reads vineMaterial directly (scene mode)
      }
      if (key.startsWith('target')) {
        applyTargetPbr();
        pathTrace.syncSigil();
      }
      requestPersist();
    },
    signal,
    defaults: SURFACE_DEFAULTS,
  });

  const manualMeshingControl = controlUi.get('manualMeshing');
  if (manualMeshingControl) {
    const note = document.createElement('p');
    note.id = 'manual-meshing-note';
    note.className = 'control-note';
    note.textContent = 'It is recommended to turn on Manual meshing to avoid waits between strokes.';
    manualMeshingControl.input.setAttribute('aria-describedby', note.id);
    manualMeshingControl.row.insertAdjacentElement('afterend', note);
  }

  for (const button of panelRoot.querySelectorAll('[data-draw-tool]')) {
    button.addEventListener('click', () => setDrawTool(button.dataset.drawTool), { signal });
  }
  controlUi.get('cvRadiusScale')?.input.addEventListener('change', flushRadiusSliderHistory, { signal });

  function syncBackendUi() {
    const patch = local.surfaceBackend === 'patch';
    const setHidden = (el, hidden) => {
      el.hidden = hidden;
      // `.control-row { display: grid }` overrides the browser's default
      // `[hidden]` rule, so conditional rows also need an explicit display.
      el.style.display = hidden ? 'none' : '';
    };
    for (const el of panelRoot.querySelectorAll('.forge-welded')) setHidden(el, patch);
    for (const el of panelRoot.querySelectorAll('.forge-patch')) setHidden(el, !patch);
  }
  syncBackendUi();

  const importInput = panelRoot.querySelector('#import-glb-file');
  panelRoot.querySelector('#import-glb').addEventListener('click', () => importInput.click(), { signal });
  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    void loadTargetFile(file);
  }, { signal });

  panelRoot.querySelector('#defaults').addEventListener('click', () => {
    flushRadiusSliderHistory();
    if (active) finishFreehandStroke();
    if (drag) cancelCvEdit();
    if (draft) cancelDraft();
    Object.assign(local, SURFACE_DEFAULTS);
    selected = null;
    hoveredStroke = null;
    activeCopy = 0;
    syncControlPanelToState(controlUi, local, panelRoot);
    syncBackendUi();
    updateToolUi();
    syncRadiusControl();
    refreshGuides();
    refreshDrawCurve();
    vineMaterial.roughness = local.rough;
    vineMaterial.needsUpdate = true;
    applyTargetPbr();
    rebuildField({ reconform: true });
    requestPersist();
  }, { signal });
  panelRoot.querySelector('#undo').addEventListener('click', undoAction, { signal });
  panelRoot.querySelector('#clear').addEventListener('click', () => {
    flushRadiusSliderHistory();
    if (active) finishFreehandStroke();
    if (drag) cancelCvEdit();
    if (draft) cancelDraft();
    if (committed.length === 0) return;
    const records = committed.splice(0);
    recordHistory({ type: 'clear', records });
    activeRecord = null;
    selected = null;
    hoveredStroke = null;
    syncRadiusControl();
    refreshGuides();
    rebuildField();
  }, { signal });
  // Path-trace beauty mode. Scene mode: vines + target are real geometry with
  // standard materials, so the tracer ingests the live scene with no bake.
  // While painting, the tracer holds and composites only the live draw curve.
  const pathTraceBtn = panelRoot.querySelector('#pathtrace');
  let pathTrace;
  if (renderBackend === 'webgl') {
    markUnsupported(pathTraceBtn);
    pathTrace = createInactiveTraceRigs().pathTrace;
  } else {
    pathTrace = createPathTraceRig(ctx, {
      hasContent: () => !!fieldMesh || manualMeshes.size > 0,
      emptyHint: 'paint a stroke first',
      button: pathTraceBtn,
      panel: panelRoot.querySelector('#pathtrace-controls'),
      getCamera: () => camera,
      setStatus,
      signal,
      onToggle: (on) => {
        if (on) {
          overlay.visible = false;
          guideGroup.visible = false;
          if (drawCurve) drawCurve.visible = false;
        } else {
          refreshGuides();
          refreshDrawCurve();
        }
      },
    });
  }

  const meshAxes = {
    x: new THREE.Vector3(1, 0, 0),
    y: new THREE.Vector3(0, 1, 0),
    z: new THREE.Vector3(0, 0, 1),
  };
  const quarterTurn = new THREE.Quaternion();

  function finishTargetTransform() {
    recenterTarget();
    target.updateMatrixWorld(true);
    syncGroup();
    persistTargetTransform();
    pathTrace.syncSigil();
    requestPersist();
  }

  for (const button of panelRoot.querySelectorAll('[data-mesh-rotate]')) {
    button.addEventListener('click', () => {
      const axis = meshAxes[button.dataset.meshRotate];
      const turns = Number(button.dataset.turn) || 0;
      quarterTurn.setFromAxisAngle(axis, turns * Math.PI * 0.5);
      target.quaternion.premultiply(quarterTurn).normalize();
      finishTargetTransform();
    }, { signal });
  }

  for (const button of panelRoot.querySelectorAll('[data-mesh-flip]')) {
    button.addEventListener('click', () => {
      const axis = button.dataset.meshFlip;
      target.scale[axis] *= -1;
      finishTargetTransform();
    }, { signal });
  }

  panelRoot.querySelector('[data-mesh-reset]').addEventListener('click', () => {
    const scale = Math.max(Math.abs(target.scale.x), Math.abs(target.scale.y), Math.abs(target.scale.z));
    target.quaternion.identity();
    target.scale.setScalar(scale);
    finishTargetTransform();
  }, { signal });

  panelRoot.querySelector('[data-mesh-faces]').addEventListener('click', () => {
    flushRadiusSliderHistory();
    if (drag) cancelCvEdit();
    const geo = target.geometry;
    let index = geo.getIndex();
    if (!index) {
      const count = geo.getAttribute('position')?.count ?? 0;
      const IndexArray = count > 65535 ? Uint32Array : Uint16Array;
      const values = new IndexArray(count);
      for (let i = 0; i < count; i++) values[i] = i;
      geo.setIndex(new THREE.BufferAttribute(values, 1));
      index = geo.getIndex();
    }
    for (let i = 0; i + 2 < index.count; i += 3) {
      const b = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, b);
    }
    index.needsUpdate = true;

    const normal = geo.getAttribute('normal');
    if (normal) {
      for (let i = 0; i < normal.count; i++) {
        normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
      }
      normal.needsUpdate = true;
    }
    const tangent = geo.getAttribute('tangent');
    if (tangent?.itemSize === 4) {
      for (let i = 0; i < tangent.count; i++) tangent.setW(i, -tangent.getW(i));
      tangent.needsUpdate = true;
    }

    meshIndex = null;
    for (const record of splineRecords()) {
      record.cvs = record.cvs.map((cv) => projectSplinePoint(cv.p, { normal: cv.n }));
    }
    if (draft) {
      draft.cvs = draft.cvs.map((cv) => projectSplinePoint(cv.p, { normal: cv.n }));
      if (draft.hover) {
        draft.hover = projectSplinePoint(draft.hover.p, { normal: draft.hover.n });
      }
      draft.preview = null;
    }
    persistTargetTransform();
    rebuildField({ reconform: true });
    if (draft) refreshDraftPreview();
    else refreshGuides();
    void persistTargetAsset();
  }, { signal });

  bindUndoRedoKeys({ undo: undoAction, redo: redoAction, signal });
  bindMeshGlbExportButton(panelRoot.querySelector('#export-glb'), {
    signal,
    getMesh: () => {
      const sources = fieldMesh ? [fieldMesh] : [...manualMeshes.values()];
      if (sources.length === 0) return null;
      // Export manual mode as separate unblended nodes. Turning Manual
      // meshing off first produces the usual single welded mesh instead.
      const root = new THREE.Group();
      root.name = local.manualMeshing ? 'sigil-manual-strokes' : 'sigil-merged';
      sources.forEach((source, index) => {
        const mesh = new THREE.Mesh(source.geometry, vineMaterial);
        mesh.name = local.manualMeshing
          ? `sigil-stroke-${index + 1}`
          : (local.surfaceBackend === 'patch' ? 'sigil-surface-patch' : 'sigil-vines');
        root.add(mesh);
      });
      root.position.copy(vineGroup.position);
      root.quaternion.copy(vineGroup.quaternion);
      root.scale.copy(vineGroup.scale);
      return root;
    },
  });

  ctx.setAnimationLoop(() => {
    controls.update();
    scaleHandles();
    const editing = !!active || !!draft || !!drag || !!rebuildTimer;
    const controlsVisible = !!draft
      || (isCvTool() && local.showActiveCvs && isSurfaceSplineRecord(activeRecord));
    const guideVisible = guideGroup.children.length > 0;
    const liveCurveVisible = !!drawCurve && (!!active || !!draft);
    pathTrace.setHold(editing);
    // Scene-mode tracing must never ingest committed editor overlays.
    if (pathTrace.active) {
      overlay.visible = false;
      guideGroup.visible = false;
      if (drawCurve) drawCurve.visible = false;
    }
    const traced = pathTrace.render();
    if (!traced) {
      overlay.visible = controlsVisible;
      guideGroup.visible = guideVisible;
      if (drawCurve) drawCurve.visible = true;
      renderer.render(scene, camera);
    } else if (liveCurveVisible) {
      const targetWasVisible = target.visible;
      const fieldWasVisible = fieldMesh ? fieldMesh.visible : false;
      const manualVisibility = [];
      target.visible = false;
      if (fieldMesh) fieldMesh.visible = false;
      for (const mesh of manualMeshes.values()) {
        manualVisibility.push([mesh, mesh.visible]);
        mesh.visible = false;
      }
      drawCurve.visible = true;
      const prevAutoClear = renderer.autoClearColor;
      renderer.autoClearColor = false;
      pathTrace.beginComposite();
      renderer.render(scene, camera);
      pathTrace.endComposite();
      renderer.autoClearColor = prevAutoClear;
      target.visible = targetWasVisible;
      if (fieldMesh) fieldMesh.visible = fieldWasVisible;
      for (const [mesh, visible] of manualVisibility) mesh.visible = visible;
      drawCurve.visible = false;
    }
  });
  // Regrow the selected committed geometry if strokes survived a mode switch.
  // Legacy strokes (no per-stroke draw) inherit the saved panel symmetry/mirror.
  for (const record of committed) {
    if (!record.draw) record.draw = captureSurfaceDrawSettings(local, geometryCenter());
  }
  if (committed.length) {
    rebuildField({ reconform: committed.some((record) => !record.conformed) });
  }
  else updateInfo();
  interaction?.addEventListener?.('blockselectionchange', syncSelectionBlock, { signal });
  if (selectionBlocked()) syncSelectionBlock();
  else ensureActiveRecord();
  updateInfo();
  syncRadiusControl();
  refreshGuides();
  updateToolUi();

  return () => {
    flushRadiusSliderHistory();
    clearTimeout(radiusSliderTimer);
    importGeneration++;
    abort.abort();
    clearTimeout(rebuildTimer);
    ctx.setAnimationLoop(null);
    pathTrace.dispose();
    disposeMesh(drawCurve);
    disposeMesh(fieldMesh);
    disposeManualMeshes();
    emptyGroup(overlay);
    emptyGroup(guideGroup);
    handleGeometry.dispose();
    radiusGuideGeometry.dispose();
    for (const material of Object.values(handleMaterials)) material.dispose();
    for (const material of Object.values(radiusGuideMaterials)) material.dispose();
    hullMaterial.dispose();
    guideMaterial.dispose();
    activeGuideMaterial.dispose();
    hoverGuideMaterial.dispose();
    vineMaterial.dispose();
    drawCurveMaterial.dispose();
    controls.touches = previousTouches;
    setRasterBackdropHidden?.('paintOnMesh', false);
    // The target geometry lives on in the store (strokes are target-local);
    // pull the mesh out before clearScene's dispose sweep.
    persistTargetTransform();
    scene.remove(target);
    targetMaterial.dispose();
    ctx.clearScene();
  };
}
