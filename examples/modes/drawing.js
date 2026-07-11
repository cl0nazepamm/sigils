/**
 * Drawing — one planar workspace for freehand and editable CV curves.
 *
 * Both tools append to the same chronological stroke session and share the
 * merged field, material, export, Photon and path-trace lifecycle. CV curves
 * retain direct handle/radius editing while freehand keeps its live strip.
 */

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
import { mountControlPanel, syncControlPanelToState } from '../shared/controlPanel.js';
import { DEMO_CONTROL_SPECS } from '../shared/demoControlSpecs.js';
import { bindGlbExportButton } from '../shared/glbExport.js';
import { bindRightDragOrbit } from '../shared/orbit.js';
import { bindUndoRedoKeys } from '../shared/hotkeys.js';
import { createPhotonRig } from '../shared/photonRig.js';
import { createPathTraceRig } from '../shared/pathTraceRig.js';
import {
  createInactiveTraceRigs,
  lockFieldBackendToCpu,
  markUnsupported,
} from '../shared/unsupportedUi.js';
import {
  activeBuildPaths,
  buildOptionsForSession,
  clampCvRadiusScale,
  committedBuildPaths,
  cvInsertIndexFromHit,
  cvRadiusGuideRadius,
  cvRadiusScaleFromDrag,
  closestPointOnPolyline2D,
  cloneStrokeEdit,
  expandActivePaths,
  isDrawSettingKey,
  isSplineRecord,
  makeStrokeRecord,
  makeSplineRecord,
  MAX_CV_RADIUS_SCALE,
  MIN_CV_RADIUS_SCALE,
  normalizeCvRadiusScales,
  pickCvControl,
  pointOnPolyline2DHit,
  restoreStrokeEdit,
  sampleSplinePoints,
  strokePoints,
  strokeCopyCount,
  transformStrokeCopyPoint,
  inverseStrokeCopyPoint,
  updateSplineRecord,
} from '../shared/strokeSession.js';

export const meta = {
  id: 'realtime',
  label: 'Drawing',
};

const PICK_RADIUS_PX = 14;
const HANDLE_RADIUS_PX = 5;
const RADIUS_PICK_TOLERANCE_PX = 8;
const TOUCH_HANDLE_RADIUS_PX = 12;
const TOUCH_PICK_RADIUS_PX = 20;
const TOUCH_RADIUS_TOLERANCE_PX = 14;
const STROKE_PICK_PAD_PX = 6;
const DOUBLE_CLICK_WINDOW_MS = 600;
const DOUBLE_CLICK_SLOP_PX = 8;
const CLOSE_MIN_CVS = 3;
const MAX_HISTORY = 100;
const CV_RADIUS_SPEC = {
  key: 'cvRadiusScale',
  label: 'New point width ×',
  type: 'range',
  min: MIN_CV_RADIUS_SCALE,
  max: MAX_CV_RADIUS_SCALE,
  step: 0.01,
};
const ACTIVE_CVS_SPEC = {
  key: 'showActiveCvs',
  label: 'Show curve points',
  type: 'check',
};
const DRAW_TOOLS = new Set(['freehand', 'spline']);

export function mount(ctx, {
  panelRoot,
  infoRoot,
  state = createDrawDemoState(),
  strokes = [],
  interaction = null,
}) {
  const { THREE, renderer, scene, controls, computeRenderer, renderBackend } = ctx;
  const abort = new AbortController();
  const { signal } = abort;
  const selectionBlocked = () => interaction?.blockSelection === true;
  let camera = ctx.setOrthographicView(state.orthographic);
  const { planePoint } = createDrawPlane(() => camera);

  controls.target.set(0, 0, 0);
  camera = ctx.setCameraHome();
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
  state.drawTool = DRAW_TOOLS.has(state.drawTool) ? state.drawTool : 'freehand';
  renderer.domElement.style.cursor = 'crosshair';

  panelRoot.innerHTML = `
    <div class="mode-head">
      <h2>Drawing</h2>
      <div class="draw-tools" role="group" aria-label="Drawing tool">
        <button type="button" data-draw-tool="freehand" aria-pressed="false">Freehand</button>
        <button type="button" data-draw-tool="spline" aria-pressed="false">Curve</button>
      </div>
    </div>
    <div id="controls"></div>
    <div class="buttons">
      <button id="defaults" type="button">Reset all</button>
      <button id="undo" type="button">Undo</button>
      <button id="clear" type="button">Clear</button>
      <button id="export-glb" type="button">Export GLB</button>
      <button id="photon" type="button">Photon trace</button>
      <button id="pathtrace" type="button">Path trace</button>
    </div>
    <div id="photon-controls" hidden></div>
    <div id="pathtrace-controls" hidden></div>
  `;
  infoRoot.innerHTML = `<b>Sigils Creator · Drawing</b><br /><span id="stats">—</span><br /><span class="hint pointer-hint-mouse" data-draw-hint></span><span class="hint pointer-hint-touch" data-draw-hint-touch></span>`;

  const statsEl = infoRoot.querySelector('#stats');
  const controlsRoot = panelRoot.querySelector('#controls');
  let sigilMaterial = createChromeMaterial(chromeOptionsFromState(state));
  const defaultState = createDrawDemoState();

  const controlSpecs = [];
  for (const spec of DEMO_CONTROL_SPECS) {
    controlSpecs.push(spec);
    if (spec.key === 'guides') {
      controlSpecs.push(CV_RADIUS_SPEC);
      controlSpecs.push(ACTIVE_CVS_SPEC);
    }
  }
  state.cvRadiusScale = clampCvRadiusScale(state.cvRadiusScale);

  const controlUi = mountControlPanel(controlsRoot, controlSpecs, state, {
    onChange: (key) => {
      if (key === 'cvRadiusScale') {
        applySelectedRadius(state.cvRadiusScale);
        return;
      }
      if (key === 'showActiveCvs') {
        if (!state.showActiveCvs) selected = null;
        syncRadiusControl();
        refreshGuides();
        return;
      }
      if (key === 'guides') {
        refreshGuides();
        return;
      }
      if (key === 'orthographic') {
        if (pathTrace?.active) {
          state.orthographic = false;
          return;
        }
        camera = ctx.setOrthographicView(state.orthographic);
        return;
      }
      if (key === 'thickness') refreshGuides();
      if (key === 'profile') replaceChromeMaterial();
      refreshDraftPreview();
      refreshFreehandPreview();
      if (key === 'previewStripOnly') {
        rebuildVersion++;
        rebuildQueued = false;
        clearTimeout(rebuildTimer);
        holdPreviewUntilRebuild = false;
        if (state.previewStripOnly) {
          clearCommittedMesh();
          clearMesh(dragMesh);
          blendBackend = 'strip';
          refreshFreehandPreview();
        } else {
          clearMesh(freehandMesh);
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
      photon.handleLive(key);
      pathTrace.handleLive(key);
      if (state.previewStripOnly && key === 'peak') {
        refreshFreehandPreview();
        refreshDraftPreview();
      }
    },
    defaults: defaultState,
    signal,
  });

  const sigilMesh = new THREE.Mesh(new THREE.BufferGeometry(), sigilMaterial);
  sigilMesh.frustumCulled = false;
  sigilMesh.visible = false;
  scene.add(sigilMesh);

  // Draft curve while placing CVs (committed mesh stays visible under it).
  const draftMesh = new THREE.Mesh(new THREE.BufferGeometry(), sigilMaterial);
  draftMesh.frustumCulled = false;
  draftMesh.visible = false;
  draftMesh.renderOrder = 1;
  scene.add(draftMesh);

  // All curves as strips while a committed CV is being dragged.
  const dragMesh = new THREE.Mesh(new THREE.BufferGeometry(), sigilMaterial);
  dragMesh.frustumCulled = false;
  dragMesh.visible = false;
  dragMesh.renderOrder = 1;
  scene.add(dragMesh);

  // Freehand live stroke, or the whole session while Preview strip is on.
  const freehandMesh = new THREE.Mesh(new THREE.BufferGeometry(), sigilMaterial);
  freehandMesh.frustumCulled = false;
  freehandMesh.visible = false;
  freehandMesh.renderOrder = 1;
  scene.add(freehandMesh);

  // --- CV handles + hulls -------------------------------------------------
  const overlay = new THREE.Group();
  overlay.renderOrder = 3;
  scene.add(overlay);

  const handleGeometry = new THREE.CircleGeometry(1, 24);
  const radiusGuideGeometry = new THREE.RingGeometry(0.9, 1, 40);
  const handleMaterials = {
    draft: new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95 }),
    close: new THREE.MeshBasicMaterial({ color: 0xffd24d, depthTest: false, transparent: true, opacity: 0.95 }),
    committed: new THREE.MeshBasicMaterial({ color: 0x9fc2d8, depthTest: false, transparent: true, opacity: 0.75 }),
    active: new THREE.MeshBasicMaterial({ color: 0x6fd0ff, depthTest: false, transparent: true, opacity: 1 }),
  };
  const radiusGuideMaterials = {
    draft: new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.2, side: THREE.DoubleSide }),
    committed: new THREE.MeshBasicMaterial({ color: 0x9fc2d8, depthTest: false, transparent: true, opacity: 0.17, side: THREE.DoubleSide }),
    active: new THREE.MeshBasicMaterial({ color: 0x6fd0ff, depthTest: false, transparent: true, opacity: 0.72, side: THREE.DoubleSide }),
  };
  const hullMaterial = new THREE.LineBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0.45, depthTest: false });
  const guideMaterial = new THREE.LineBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0.55, depthTest: false });
  const activeGuideMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false });
  const hoverGuideMaterial = new THREE.LineBasicMaterial({ color: 0xffd24d, transparent: true, opacity: 0.95, depthTest: false });
  const guideGroup = new THREE.Group();
  guideGroup.renderOrder = 2;
  scene.add(guideGroup);

  let draft = null; // { cvs: [[x,y],…], cvRadiusScales: number[], hover: [x,y]|null }
  let drag = null;  // { kind: 'move'|'radius', record: 'draft'|splineRecord, index, ... }
  let current = []; // in-progress freehand points
  let drawing = false;
  let holdPreviewUntilRebuild = false;
  let currentGuide = null;
  let selected = null; // retained independently of drag so the slider stays useful
  let activeRecord = null; // only this committed stroke exposes CV controls
  let activeCopy = 0; // rendered symmetry copy whose handles are currently shown
  let hoveredStroke = null; // { record, path } for direct viewport switching
  let lastPressEditedCv = false;
  let lastPlacedCv = null; // lets the second click on a newly placed tail commit the draft
  let continueEndpoint = null; // dblclick first/last open CV to keep extending that end
  let rebuildVersion = 0;
  let rebuildTimer = 0;
  let vertexCount = 0;
  let lastError = '';
  let blendBackend = '—';
  let buildingCount = 0;
  let rebuildRunning = false;
  let rebuildQueued = false;
  let computeFailed = false;
  const undoActions = [];
  const redoActions = [];
  const draftUndo = []; // right-click CV deletes inside an open draft

  const ui = {
    defaults: panelRoot.querySelector('#defaults'),
    undo: panelRoot.querySelector('#undo'),
    clear: panelRoot.querySelector('#clear'),
    exportGlb: panelRoot.querySelector('#export-glb'),
    photon: panelRoot.querySelector('#photon'),
    pathtrace: panelRoot.querySelector('#pathtrace'),
    toolButtons: [...panelRoot.querySelectorAll('[data-draw-tool]')],
  };

  bindGlbExportButton(ui.exportGlb, { strokes, state, renderer: computeRenderer, signal });
  bindRightDragOrbit(ctx, {
    signal,
    getCamera: () => camera,
    onClick: (event) => tryDeleteCvAtPointer(event),
  });

  if (renderBackend === 'webgl') lockFieldBackendToCpu(controlsRoot, state);

  let pathTrace;
  let photon;
  if (renderBackend === 'webgl') {
    markUnsupported(ui.photon);
    markUnsupported(ui.pathtrace);
    ({ photon, pathTrace } = createInactiveTraceRigs());
  } else {
    // Mutually exclusive — arming one disarms the other. Path-trace first so
    // photon’s exclusion hook finds an initialized neighbor.
    pathTrace = createPathTraceRig(ctx, {
      sigilMesh, state, signal,
      controlsRoot,
      onCameraChange: (cam) => { camera = cam; },
      button: ui.pathtrace,
      panel: panelRoot.querySelector('#pathtrace-controls'),
      getCamera: () => camera,
      setStatus: (msg) => { statsEl.textContent = msg; },
      onToggle: (on) => {
        if (on) {
          photon.setActive(false);
          sigilMesh.visible = false;
          draftMesh.visible = false;
          dragMesh.visible = false;
          freehandMesh.visible = false;
          overlay.visible = false;
          guideGroup.visible = false;
        } else {
          sigilMesh.visible = (sigilMesh.geometry.getAttribute('position')?.count ?? 0) > 0;
          overlay.visible = true;
          refreshGuides();
          refreshDraftPreview();
          refreshFreehandPreview();
        }
      },
    });

    photon = createPhotonRig(ctx, {
      sigilMesh, state, signal,
      button: ui.photon,
      panel: panelRoot.querySelector('#photon-controls'),
      getCamera: () => camera,
      setStatus: (msg) => { statsEl.textContent = msg; },
      onToggle: (on) => { if (on) pathTrace.setActive(false); },
    });
  }

  function worldPerPixel() {
    if (camera.isOrthographicCamera) {
      return (camera.top - camera.bottom) / ((camera.zoom || 1) * window.innerHeight);
    }
    const dist = camera.position.distanceTo(controls.target);
    return (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))) / window.innerHeight;
  }

  function replaceChromeMaterial() {
    const previous = sigilMaterial;
    sigilMaterial = createChromeMaterial(chromeOptionsFromState(state));
    sigilMesh.material = sigilMaterial;
    draftMesh.material = sigilMaterial;
    dragMesh.material = sigilMaterial;
    freehandMesh.material = sigilMaterial;
    previous.dispose();
    photon.refreshCaster();
  }

  function applyDrawDefaults() {
    if (drawing) finishFreehandStroke();
    if (draft) {
      if (draft.cvs.length >= 2) commitDraft(false);
      else cancelDraft();
    }
    selected = null;
    hoveredStroke = null;
    ensureActiveRecord();
    Object.assign(state, createDrawDemoState());
    if (renderBackend === 'webgl') state.backend = 'cpu';
    syncControlPanelToState(controlUi, state, panelRoot);
    camera = ctx.setOrthographicView(state.orthographic);
    replaceChromeMaterial();
    photon.resetDefaults();
    pathTrace.resetDefaults();
    refreshGuides();
    syncRadiusControl();
    refreshDraftPreview();
    refreshFreehandPreview();
    updateToolUi();
    scheduleRebuild(0);
  }

  function scheduleRebuild(delay = 120) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, delay);
  }

  function isCvTool() {
    return state.drawTool === 'spline';
  }

  function updateHints() {
    const mouseHint = infoRoot.querySelector('[data-draw-hint]');
    const touchHint = infoRoot.querySelector('[data-draw-hint-touch]');
    if (!mouseHint && !touchHint) return;

    let mouse = '';
    let touch = '';
    if (!isCvTool()) {
      if (drawing) {
        mouse = 'left-drag: paint · release: finish stroke';
        touch = 'drag: paint · lift: finish stroke';
      } else if (selectionBlocked()) {
        mouse = 'left-drag: draw only · selection blocked · right-drag: orbit · pan: middle';
        touch = 'draw: one finger · selection blocked · two fingers: pan/zoom';
      } else if (activeRecord) {
        mouse = 'left-drag: draw · Delete: remove selected · Tab: cycle · Shift-click: draw over · middle-click curve: insert · right-drag: orbit';
        touch = 'draw: one finger · tap stroke: switch · two fingers: pan/zoom';
      } else {
        mouse = 'left-drag: draw · click stroke / Tab: select · Shift-click: draw over · right-drag: orbit · pan: middle';
        touch = 'draw: one finger · tap stroke: select · two fingers: pan/zoom';
      }
    } else if (draft) {
      const canClose = draft.cvs.length >= CLOSE_MIN_CVS;
      mouse = canClose
        ? 'left-click: add CV · drag: place · right-click CV: delete · click first CV: close · dblclick empty / Enter: commit · Esc: cancel · Backspace: pop last'
        : 'left-click: add CV · drag: place · right-click CV: delete · Enter: commit (2+ CVs) · Esc: cancel · Backspace: pop last';
      touch = 'tap: add CV · drag: place · tap first CV: close · two fingers: pan/zoom';
    } else if (selectionBlocked()) {
      mouse = 'left-click: place CV · selection blocked · right-drag: orbit';
      touch = 'tap: place CV · selection blocked · two fingers: pan/zoom';
    } else if (activeRecord && isSplineRecord(activeRecord) && state.showActiveCvs) {
      mouse = 'left-drag: move CV · drag ring: radius · middle-click: insert CV · right-click CV: delete · dblclick end: continue · Delete: remove stroke · Esc: deselect · right-drag: orbit';
      touch = 'drag dot: move · drag ring: radius · tap stroke: switch · two fingers: pan/zoom';
    } else if (activeRecord) {
      mouse = 'click stroke: select · Tab: cycle · Delete: remove · Shift-click: new · left-click empty: start curve · right-drag: orbit';
      touch = 'tap stroke: switch · tap empty: start curve · two fingers: pan/zoom';
    } else {
      mouse = 'left-click: place CV · click stroke / Tab: select · Shift-click: new · right-drag: orbit';
      touch = 'tap: place CV · tap stroke: select · two fingers: pan/zoom';
    }

    if (mouseHint) mouseHint.textContent = mouse;
    if (touchHint) touchHint.textContent = touch;
  }

  function updateToolUi() {
    const cv = isCvTool();
    for (const button of ui.toolButtons) {
      const active = button.dataset.drawTool === state.drawTool;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }

    const setRowVisible = (key, visible) => {
      const row = controlUi.get(key)?.row;
      if (row) row.style.display = visible ? '' : 'none';
    };
    setRowVisible('cvRadiusScale', cv);
    setRowVisible('showActiveCvs', cv);
    updateHints();
    renderer.domElement.style.cursor = 'crosshair';
  }

  function setDrawTool(next) {
    const tool = DRAW_TOOLS.has(next) ? next : 'freehand';
    if (tool === state.drawTool) return;

    if (drawing) finishFreehandStroke();

    if (drag) {
      const pointerId = activePointer;
      const committedEdit = drag.moved && drag.record !== 'draft';
      drag = null;
      activePointer = null;
      touchPointers.clear();
      releasePointer(pointerId);
      if (committedEdit) scheduleRebuild(0);
    }
    if (draft) {
      if (draft.cvs.length >= 2) commitDraft(false);
      else cancelDraft();
    }

    state.drawTool = tool;
    hoveredStroke = null;
    updateToolUi();
    syncRadiusControl();
    refreshGuides();
    refreshDraftPreview();
    refreshFreehandPreview();
  }

  // --- overlays -----------------------------------------------------------

  function splineRecords() {
    return strokes.filter(isSplineRecord);
  }

  function ensureActiveRecord(preferred = activeRecord) {
    if (selectionBlocked()) {
      activeRecord = null;
      activeCopy = 0;
      return null;
    }
    const next = preferred && strokes.includes(preferred)
      ? preferred
      : splineRecords().at(-1) ?? strokes.at(-1) ?? null;
    if (next !== activeRecord) activeCopy = 0;
    activeRecord = next;
    activeCopy = activeRecord
      ? Math.min(strokeCopyCount(activeRecord.draw) - 1, Math.max(0, activeCopy))
      : 0;
    return activeRecord;
  }

  function pathsForRecord(record) {
    if (!record) return [];
    return record.expanded ?? committedBuildPaths([record]);
  }

  function activateRecord(record, copyIndex = 0) {
    if (selectionBlocked()) return;
    if (!record || !strokes.includes(record)) return;
    const copy = Math.min(strokeCopyCount(record.draw) - 1, Math.max(0, copyIndex));
    const same = record === activeRecord && copy === activeCopy;
    if (same && (!isSplineRecord(record) || state.showActiveCvs)) {
      refreshGuides();
      return;
    }
    activeRecord = record;
    activeCopy = copy;
    selected = null;
    hoveredStroke = null;
    if (isSplineRecord(record) && !state.showActiveCvs) {
      state.showActiveCvs = true;
      const mounted = controlUi.get('showActiveCvs');
      if (mounted) syncControlPanelToState(new Map([['showActiveCvs', mounted]]), state, panelRoot);
    }
    syncRadiusControl();
    refreshGuides();
  }

  function cycleActiveRecord(direction) {
    if (selectionBlocked()) return;
    if (draft || drag || drawing) return;
    if (strokes.length === 0) return;
    const current = strokes.indexOf(activeRecord);
    const start = current >= 0 ? current : strokes.length - 1;
    const next = (start + direction + strokes.length) % strokes.length;
    activateRecord(strokes[next], 0);
  }

  function deleteActiveStroke() {
    if (drawing) cancelFreehandStroke();
    if (draft || drag || !activeRecord) return;
    const index = strokes.indexOf(activeRecord);
    if (index < 0) return;
    const record = activeRecord;
    strokes.splice(index, 1);
    recordHistory({ type: 'remove', record, index });
    if (selected?.record === record) selected = null;
    activeRecord = null;
    activeCopy = 0;
    hoveredStroke = null;
    holdPreviewUntilRebuild = false;
    syncRadiusControl();
    clearMesh(dragMesh);
    refreshFreehandPreview();
    refreshGuides();
    rebuild();
  }

  function displayedCvs(record = activeRecord, copyIndex = activeCopy) {
    if (!isSplineRecord(record)) return [];
    return record.cvs.map((cv) => transformStrokeCopyPoint(cv, record.draw, copyIndex));
  }

  function pickOtherStroke(p) {
    if (!p || draft || selectionBlocked()) return null;
    const pixelPad = worldPerPixel() * STROKE_PICK_PAD_PX;
    let best = null;
    let bestScore = Infinity;
    for (let r = strokes.length - 1; r >= 0; r--) {
      const record = strokes[r];
      const paths = pathsForRecord(record);
      for (let copyIndex = 0; copyIndex < paths.length; copyIndex++) {
        const path = paths[copyIndex];
        const hit = closestPointOnPolyline2D(p, path);
        const localRadius = cvRadiusGuideRadius(state.thickness, hit.radiusScale);
        const reach = localRadius + pixelPad;
        if (hit.distance > reach) continue;
        const score = hit.distance / Math.max(localRadius, pixelPad, 1e-9);
        if (score < bestScore) {
          bestScore = score;
          best = { record, copyIndex, path, distance: hit.distance };
        }
      }
    }
    return best;
  }

  function radiusScalesFor(record) {
    if (record === 'draft') return draft?.cvRadiusScales ?? null;
    return record?.cvRadiusScales ?? null;
  }

  function selectedTarget() {
    if (!selected) return null;
    const cvs = selected.record === 'draft' ? draft?.cvs : selected.record?.cvs;
    const radii = radiusScalesFor(selected.record);
    if (!cvs?.[selected.index] || !radii?.[selected.index]) return null;
    return { ...selected, cvs, radii };
  }

  function syncRadiusControl() {
    const target = selectedTarget();
    if (target) state.cvRadiusScale = target.radii[target.index];
    const mounted = controlUi.get('cvRadiusScale');
    const label = mounted?.row.querySelector('label');
    if (label) label.textContent = target ? 'Point width ×' : 'New point width ×';
    if (mounted) syncControlPanelToState(new Map([['cvRadiusScale', mounted]]), state, panelRoot);
  }

  function selectCv(record, index) {
    if (record !== 'draft' && selectionBlocked()) return;
    selected = { record, index };
    if (record !== 'draft') {
      if (activeRecord !== record) activeCopy = 0;
      activeRecord = record;
      hoveredStroke = null;
    }
    syncRadiusControl();
  }

  function clearSelection() {
    selected = null;
    if (!isCvTool() || !isSplineRecord(activeRecord)) {
      activeRecord = null;
      activeCopy = 0;
      hoveredStroke = null;
    }
    syncRadiusControl();
    refreshGuides();
  }

  function syncSelectionBlock() {
    if (selectionBlocked()) {
      if (drag?.record && drag.record !== 'draft') cancelTouchEdit();
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
  }

  function applySelectedRadius(value, { scheduleCommitted = true } = {}) {
    const scale = clampCvRadiusScale(value);
    state.cvRadiusScale = scale;
    const target = selectedTarget();
    if (!target) return;

    target.radii[target.index] = scale;
    syncRadiusControl();
    if (target.record === 'draft') {
      refreshGuides();
      refreshDraftPreview();
      return;
    }

    updateSplineRecord(target.record, target.cvs, target.record.closed, target.radii);
    sigilMesh.visible = false;
    refreshGuides();
    refreshDragPreview();
    if (scheduleCommitted) scheduleRebuild();
  }

  // Group.clear() does not dispose geometry; hull/guide lines own theirs
  // (handles share handleGeometry, which outlives the group).
  function emptyGroup(group) {
    for (const child of group.children) {
      if (!child.userData.sharedOverlayGeometry) child.geometry?.dispose();
    }
    group.clear();
  }

  function refreshGuides() {
    emptyGroup(guideGroup);
    emptyGroup(overlay);
    currentGuide = null;

    if (!isCvTool()) {
      // Curves checkbox: ambient centerlines for every non-active stroke.
      if (state.guides) {
        for (const stroke of strokes) {
          if (stroke === activeRecord) continue;
          for (const path of pathsForRecord(stroke)) {
            if (path.length >= 2) addCurveGuide(path, guideMaterial);
          }
        }
        if (current.length >= 2) currentGuide = addCurveGuide(current, guideMaterial);
      }
      // Selected stroke is always highlighted, even with Curves off.
      if (!drawing && activeRecord && strokes.includes(activeRecord)) {
        const path = pathsForRecord(activeRecord)[activeCopy]
          ?? strokePoints(activeRecord);
        addCurveGuide(path, activeGuideMaterial);
      }
      if (!drawing && hoveredStroke
        && (hoveredStroke.record !== activeRecord || hoveredStroke.copyIndex !== activeCopy)) {
        addCurveGuide(hoveredStroke.path, hoverGuideMaterial);
      }
      overlay.visible = false;
      guideGroup.visible = guideGroup.children.length > 0;
      updateHints();
      return;
    }

    // Hull + handles for the draft.
    if (draft && draft.cvs.length > 0) {
      addHull(draft.cvs, false);
      draft.cvs.forEach((cv, i) => {
        const closable = i === 0 && draft.cvs.length >= CLOSE_MIN_CVS;
        const active = selected?.record === 'draft' && selected.index === i;
        addRadiusGuide(cv, draft.cvRadiusScales[i], active ? radiusGuideMaterials.active : radiusGuideMaterials.draft);
        addHandle(cv, active ? handleMaterials.active : (closable ? handleMaterials.close : handleMaterials.draft));
      });
    }

    // Ambient Curves for other committed strokes while editing CVs.
    if (state.guides) {
      for (const stroke of strokes) {
        if (stroke === activeRecord) continue;
        for (const path of pathsForRecord(stroke)) {
          if (path.length >= 2) addCurveGuide(path, guideMaterial);
        }
      }
    }

    // Only the active/latest committed stroke exposes its CVs. This keeps a
    // dense multi-stroke sigil editable without covering it in every handle.
    const record = !draft && state.showActiveCvs ? ensureActiveRecord() : (!draft ? activeRecord : null);
    if (isSplineRecord(record) && state.showActiveCvs) {
      const cvs = displayedCvs(record, activeCopy);
      addHull(cvs, record.closed);
      const dragged = drag && drag.record === record;
      cvs.forEach((cv, i) => {
        const active = (dragged && drag.index === i) || (selected?.record === record && selected.index === i);
        const continuable = !record.closed && (i === 0 || i === cvs.length - 1);
        addRadiusGuide(cv, record.cvRadiusScales[i], active ? radiusGuideMaterials.active : radiusGuideMaterials.committed);
        addHandle(cv, active ? handleMaterials.active : (continuable ? handleMaterials.close : handleMaterials.committed));
      });
      addCurveGuide(pathsForRecord(record)[activeCopy] ?? record.points, activeGuideMaterial);
    } else if (record && strokes.includes(record)) {
      addCurveGuide(pathsForRecord(record)[activeCopy] ?? strokePoints(record), activeGuideMaterial);
    }

    // Hovering an inactive rendered stroke reveals the exact centerline that
    // a click will activate, including symmetry copies.
    if (!draft && hoveredStroke
      && (hoveredStroke.record !== activeRecord || hoveredStroke.copyIndex !== activeCopy)) {
      addCurveGuide(hoveredStroke.path, hoverGuideMaterial);
    }

    overlay.visible = !!draft || (isSplineRecord(record) && state.showActiveCvs);
    guideGroup.visible = guideGroup.children.length > 0;
    updateHints();
  }

  function addHull(cvs, closed) {
    if (cvs.length < 2) return;
    const pts = cvs.map(([x, y]) => new THREE.Vector3(x, y, 0.016));
    if (closed) pts.push(pts[0].clone());
    overlay.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), hullMaterial));
  }

  function addCurveGuide(path, material) {
    if (!path || path.length < 2) return null;
    const pts = path.map(([x, y]) => new THREE.Vector3(x, y, 0.012));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material);
    guideGroup.add(line);
    return line;
  }

  function refreshCurrentGuide() {
    if (isCvTool() || !state.guides) return;
    if (currentGuide) {
      guideGroup.remove(currentGuide);
      currentGuide.geometry.dispose();
      currentGuide = null;
    }
    if (current.length >= 2) currentGuide = addCurveGuide(current, guideMaterial);
    guideGroup.visible = guideGroup.children.length > 0;
  }

  function addHandle(cv, material) {
    const mesh = new THREE.Mesh(handleGeometry, material);
    mesh.position.set(cv[0], cv[1], 0.02);
    mesh.userData.isHandle = true;
    mesh.userData.sharedOverlayGeometry = true;
    overlay.add(mesh);
  }

  function addRadiusGuide(cv, radiusScale, material) {
    const mesh = new THREE.Mesh(radiusGuideGeometry, material);
    const radius = cvRadiusGuideRadius(state.thickness, radiusScale);
    mesh.position.set(cv[0], cv[1], 0.018);
    mesh.scale.set(radius, radius, 1);
    mesh.userData.isRadiusGuide = true;
    mesh.userData.sharedOverlayGeometry = true;
    overlay.add(mesh);
  }

  function scaleHandles() {
    const s = worldPerPixel() * HANDLE_RADIUS_PX;
    for (const child of overlay.children) {
      if (child.userData.isHandle) child.scale.setScalar(s);
    }
  }

  // --- picking ------------------------------------------------------------

  function pickCv(p, pointerType = 'mouse') {
    if (!p) return null;
    const candidates = [];
    const addCandidates = (record, cvs, radii) => {
      for (let i = 0; i < cvs.length; i++) {
        candidates.push({ record, index: i, cv: cvs[i], radiusScale: radii[i] });
      }
    };

    if (draft) {
      addCandidates('draft', draft.cvs, draft.cvRadiusScales);
    } else if (!selectionBlocked() && state.showActiveCvs) {
      const record = ensureActiveRecord();
      if (isSplineRecord(record)) {
        addCandidates(record, displayedCvs(record), record.cvRadiusScales);
      }
    }

    const touch = pointerType === 'touch';
    const pixel = worldPerPixel();
    return pickCvControl(p, candidates, {
      thickness: state.thickness,
      handleRadius: pixel * (touch ? TOUCH_HANDLE_RADIUS_PX : HANDLE_RADIUS_PX),
      centerTolerance: pixel * (touch ? TOUCH_PICK_RADIUS_PX : PICK_RADIUS_PX),
      ringTolerance: pixel * (touch ? TOUCH_RADIUS_TOLERANCE_PX : RADIUS_PICK_TOLERANCE_PX),
      ringInnerRatio: 0.9,
    });
  }

  // --- preview meshes -----------------------------------------------------

  function setMeshGeometry(mesh, geometry) {
    const old = mesh.geometry;
    mesh.geometry = geometry;
    old.dispose();
    mesh.visible = (geometry.getAttribute('position')?.count ?? 0) > 0;
    updateVertexCount();
  }

  function clearMesh(mesh) {
    setMeshGeometry(mesh, new THREE.BufferGeometry());
  }

  function stripOptions() {
    return {
      ...sparsePreviewOptionsFromState(state),
      pointRadius: true,
      symmetry: 1,
      mirror: false,
      phase: 0,
    };
  }

  function clearCommittedMesh() {
    clearMesh(sigilMesh);
    photon.syncCaster();
    pathTrace.syncSigil();
  }

  function refreshFreehandPreview() {
    if (state.previewStripOnly) {
      const paths = activeBuildPaths(strokes, drawing ? current : [], state);
      if (paths.length === 0) {
        clearMesh(freehandMesh);
        return;
      }
      setMeshGeometry(freehandMesh, buildSparseCurveGeometry(paths, stripOptions()));
      return;
    }

    if (holdPreviewUntilRebuild && !drawing) return;
    if (!drawing || current.length < 2) {
      clearMesh(freehandMesh);
      return;
    }
    setMeshGeometry(
      freehandMesh,
      buildSparseCurveGeometry([current], sparsePreviewOptionsFromState(state)),
    );
  }

  function refreshDraftPreview() {
    if (!draft) {
      clearMesh(draftMesh);
      return;
    }
    const cvs = draft.hover && !drag ? [...draft.cvs, draft.hover] : draft.cvs;
    const cvRadiusScales = draft.hover && !drag
      ? [...draft.cvRadiusScales, clampCvRadiusScale(state.cvRadiusScale)]
      : draft.cvRadiusScales;
    if (cvs.length < 2) {
      clearMesh(draftMesh);
      return;
    }
    const sampled = sampleSplinePoints(cvs, false, cvRadiusScales);
    const paths = expandActivePaths(sampled, state);
    setMeshGeometry(draftMesh, buildSparseCurveGeometry(paths, stripOptions()));
  }

  function refreshDragPreview() {
    if (state.previewStripOnly) {
      clearMesh(dragMesh);
      refreshFreehandPreview();
      return;
    }
    const paths = committedBuildPaths(strokes);
    if (paths.length === 0) {
      clearMesh(dragMesh);
      return;
    }
    setMeshGeometry(dragMesh, buildSparseCurveGeometry(paths, stripOptions()));
  }

  function updateVertexCount() {
    let count = 0;
    for (const mesh of [sigilMesh, draftMesh, dragMesh, freehandMesh]) {
      if (mesh.visible) count += mesh.geometry.getAttribute('position')?.count ?? 0;
    }
    vertexCount = count;
  }

  // --- merged rebuild -----------------------------------------------------

  // GPU field and laplacian builds contain readback waits, so UI events can ask
  // for several newer meshes while one is in flight. Keep one active build and
  // at most one trailing build that reads the latest state; obsolete requests
  // are coalesced instead of forming a latency backlog.
  function rebuild() {
    rebuildVersion++;
    // Empty/strip transitions do not need compute and should remain instant
    // even when an older GPU build is still waiting on readback.
    if (state.previewStripOnly) {
      rebuildQueued = false;
      clearCommittedMesh();
      clearMesh(dragMesh);
      holdPreviewUntilRebuild = false;
      blendBackend = 'strip';
      refreshFreehandPreview();
      return;
    }
    if (strokes.length === 0) {
      rebuildQueued = false;
      clearMesh(sigilMesh);
      clearMesh(dragMesh);
      holdPreviewUntilRebuild = false;
      if (!drawing) clearMesh(freehandMesh);
      blendBackend = '—';
      photon.syncCaster();
      pathTrace.syncSigil();
      return;
    }
    rebuildQueued = true;
    if (!rebuildRunning) void drainRebuilds();
  }

  async function drainRebuilds() {
    rebuildRunning = true;
    try {
      while (rebuildQueued && !signal.aborted) {
        rebuildQueued = false;
        const version = rebuildVersion;
        await runRebuild(version);
      }
    } finally {
      rebuildRunning = false;
    }
  }

  async function runRebuild(version) {
    try {
      lastError = '';
      if (state.previewStripOnly) {
        clearCommittedMesh();
        clearMesh(dragMesh);
        holdPreviewUntilRebuild = false;
        blendBackend = 'strip';
        refreshFreehandPreview();
        return;
      }
      if (strokes.length === 0) {
        clearMesh(sigilMesh);
        clearMesh(dragMesh);
        holdPreviewUntilRebuild = false;
        if (!drawing) clearMesh(freehandMesh);
        blendBackend = '—';
        photon.syncCaster(); // stay armed; hide the caustic while there's no caster
        pathTrace.syncSigil(); // nothing to trace -> drops back to raster
        return;
      }

      const paths = committedBuildPaths(strokes);
      let geometry;
      buildingCount++;
      try {
        geometry = await buildSigilGeometryAsync(paths, {
          ...buildOptionsForSession(state),
          renderer: computeFailed ? null : computeRenderer,
          onGpuFallback: (error) => {
            computeFailed = true;
            console.warn('sigils: compute failed; using the CPU mesh fallback for this session.', error);
          },
        });
      } finally {
        buildingCount--;
      }

      // signal.aborted: the mode unmounted while this build was in flight —
      // touching the rigs now would resurrect disposed engines into the scene.
      if (version !== rebuildVersion || state.previewStripOnly || signal.aborted) {
        geometry.dispose();
        return;
      }

      blendBackend = geometry.userData.fieldBackend
        ?? geometry.userData.laplacianBackend
        ?? geometry.userData.buildBackend
        ?? state.backend;

      setMeshGeometry(sigilMesh, geometry);
      // A new committed-CV drag may have started while this build was in
      // flight; keep showing strips until ITS release-rebuild lands.
      if (drag?.previewStarted && drag.record !== 'draft') {
        sigilMesh.visible = false;
      } else {
        clearMesh(dragMesh);
      }
      holdPreviewUntilRebuild = false;
      if (!drawing) clearMesh(freehandMesh);
      if (pathTrace.active) sigilMesh.visible = false;
      photon.syncCaster();
      pathTrace.syncSigil();
    } catch (error) {
      lastError = error?.message ?? String(error);
      console.error('sigils rebuild failed', error);
    }
  }

  // --- history --------------------------------------------------------------

  function recordHistory(action) {
    undoActions.push(action);
    if (undoActions.length > MAX_HISTORY) undoActions.shift();
    redoActions.length = 0;
  }

  function refreshAfterHistory(preferred = null) {
    selected = null;
    hoveredStroke = null;
    activeRecord = preferred && strokes.includes(preferred) ? preferred : null;
    ensureActiveRecord();
    holdPreviewUntilRebuild = false;
    syncRadiusControl();
    clearMesh(dragMesh);
    refreshFreehandPreview();
    refreshGuides();
    rebuild();
  }

  function applyHistoryAction(action, forward) {
    if (action.type === 'add') {
      if (forward) {
        if (!strokes.includes(action.record)) {
          strokes.splice(Math.min(action.index, strokes.length), 0, action.record);
        }
        return action.record;
      }
      const index = strokes.indexOf(action.record);
      if (index >= 0) strokes.splice(index, 1);
      return null;
    }
    if (action.type === 'remove') {
      if (forward) {
        const index = strokes.indexOf(action.record);
        if (index >= 0) strokes.splice(index, 1);
        return null;
      }
      if (!strokes.includes(action.record)) {
        strokes.splice(Math.min(action.index, strokes.length), 0, action.record);
      }
      return action.record;
    }
    if (action.type === 'replace') {
      const removeRecord = forward ? action.before : action.after;
      const insertRecord = forward ? action.after : action.before;
      const existing = strokes.indexOf(removeRecord);
      const index = existing >= 0 ? existing : action.index;
      if (existing >= 0) strokes.splice(existing, 1);
      if (!strokes.includes(insertRecord)) {
        strokes.splice(Math.min(index, strokes.length), 0, insertRecord);
      }
      return insertRecord;
    }
    if (action.type === 'edit') {
      restoreStrokeEdit(action.record, forward ? action.after : action.before);
      return action.record;
    }
    if (action.type === 'clear') {
      if (forward) strokes.splice(0);
      else strokes.push(...action.records);
      return forward ? null : action.records.at(-1) ?? null;
    }
    return null;
  }

  function undoDraftDelete() {
    const entry = draftUndo.pop();
    if (!entry || !draft) return false;
    const index = Math.min(Math.max(0, entry.index), draft.cvs.length);
    draft.cvs.splice(index, 0, entry.cv.slice());
    draft.cvRadiusScales.splice(index, 0, entry.radiusScale);
    selectCv('draft', index);
    syncRadiusControl();
    refreshGuides();
    refreshDraftPreview();
    return true;
  }

  // --- draft lifecycle ----------------------------------------------------

  function restoreContinuedStroke() {
    if (!draft?.continuedFrom) return false;
    const record = draft.continuedFrom;
    const index = Math.min(draft.continuedIndex ?? strokes.length, strokes.length);
    if (!strokes.includes(record)) strokes.splice(index, 0, record);
    activeRecord = selectionBlocked() ? null : record;
    activeCopy = 0;
    selected = selectionBlocked() ? null : { record, index: record.cvs.length - 1 };
    return true;
  }

  function continueCommittedSpline(record, end) {
    if (!isSplineRecord(record) || record.closed || draft) return;
    const index = strokes.indexOf(record);
    if (index < 0) return;

    const cvs = record.cvs.map((cv) => cv.slice());
    const radii = record.cvRadiusScales.slice();
    if (end === 'start') {
      cvs.reverse();
      radii.reverse();
    }

    strokes.splice(index, 1);
    if (selected?.record === record) selected = null;
    if (activeRecord === record) activeRecord = null;
    if (hoveredStroke?.record === record) hoveredStroke = null;
    draftUndo.length = 0;

    draft = {
      cvs,
      cvRadiusScales: radii,
      hover: null,
      continuedFrom: record,
      continuedIndex: index,
      drawCapture: {
        symmetry: record.draw.symmetry,
        mirror: record.draw.mirror,
        phase: record.draw.phase,
        center: record.draw.center.slice(),
      },
    };
    continueEndpoint = null;
    lastPlacedCv = null;
    selectCv('draft', draft.cvs.length - 1);
    clearMesh(dragMesh);
    holdPreviewUntilRebuild = false;
    refreshGuides();
    refreshDraftPreview();
    scheduleRebuild(0);
  }

  function commitDraft(closed) {
    if (!draft || draft.cvs.length < 2) {
      cancelDraft();
      return;
    }
    stopActiveDraftPointer();
    const selectedIndex = selected?.record === 'draft'
      ? selected.index
      : (closed ? 0 : draft.cvs.length - 1);
    const continued = draft.continuedFrom;
    const continuedIndex = draft.continuedIndex;
    const commitState = draft.drawCapture
      ? {
          ...state,
          symmetry: draft.drawCapture.symmetry,
          mirror: draft.drawCapture.mirror,
          phase: draft.drawCapture.phase,
          center: draft.drawCapture.center,
        }
      : state;
    const record = makeSplineRecord(draft.cvs, closed, commitState, draft.cvRadiusScales);
    const insertAt = continuedIndex != null
      ? Math.min(continuedIndex, strokes.length)
      : strokes.length;
    strokes.splice(insertAt, 0, record);
    if (continued) {
      recordHistory({ type: 'replace', index: insertAt, before: continued, after: record });
    } else {
      recordHistory({ type: 'add', record, index: insertAt });
    }
    draft = null;
    draftUndo.length = 0;
    lastPlacedCv = null;
    continueEndpoint = null;
    activeRecord = selectionBlocked() ? null : record;
    activeCopy = 0;
    hoveredStroke = null;
    selected = selectionBlocked()
      ? null
      : { record, index: Math.min(record.cvs.length - 1, Math.max(0, selectedIndex)) };
    clearMesh(draftMesh);
    syncRadiusControl();
    refreshGuides();
    scheduleRebuild(0);
  }

  function cancelDraft() {
    stopActiveDraftPointer();
    const restored = restoreContinuedStroke();
    if (selected?.record === 'draft') selected = null;
    draft = null;
    draftUndo.length = 0;
    lastPlacedCv = null;
    continueEndpoint = null;
    clearMesh(draftMesh);
    syncRadiusControl();
    refreshGuides();
    if (restored) scheduleRebuild(0);
  }

  function popDraftCv() {
    if (!draft || draft.cvs.length === 0) return;
    stopActiveDraftPointer();
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
      refreshDraftPreview();
      if (restored) scheduleRebuild(0);
      return;
    }
    if (selected?.record === 'draft' && selected.index >= draft.cvs.length) {
      selected.index = draft.cvs.length - 1;
    }
    syncRadiusControl();
    refreshGuides();
    refreshDraftPreview();
  }

  // --- freehand lifecycle ------------------------------------------------

  function pushFreehandPoint(p) {
    if (!p) return;
    const last = current[current.length - 1];
    if (last) {
      const dx = p[0] - last[0];
      const dy = p[1] - last[1];
      if (dx * dx + dy * dy < state.minDrawStep * state.minDrawStep) return;
    }
    current.push(p);
  }

  function finishFreehandStroke() {
    if (!drawing) return;
    const pointerId = activePointer;
    drawing = false;
    activePointer = null;
    releasePointer(pointerId);
    if (current.length >= 2) {
      const record = makeStrokeRecord(current, state);
      const index = strokes.length;
      strokes.push(record);
      recordHistory({ type: 'add', record, index });
      activeRecord = selectionBlocked() ? null : record;
      activeCopy = 0;
      hoveredStroke = null;
      holdPreviewUntilRebuild = !state.previewStripOnly;
    } else {
      holdPreviewUntilRebuild = false;
    }
    current = [];
    refreshGuides();
    if (state.previewStripOnly) refreshFreehandPreview();
    else rebuild();
  }

  function cancelFreehandStroke() {
    if (!drawing) return;
    const pointerId = activePointer;
    drawing = false;
    activePointer = null;
    current = [];
    holdPreviewUntilRebuild = false;
    releasePointer(pointerId);
    refreshCurrentGuide();
    refreshFreehandPreview();
    updateHints();
  }

  // --- pointer interaction --------------------------------------------------

  let activePointer = null;
  const touchPointers = new Set();

  function releasePointer(pointerId) {
    if (pointerId == null) return;
    try {
      renderer.domElement.releasePointerCapture(pointerId);
    } catch {
      // Pointer capture may already have ended.
    }
  }

  function stopActiveDraftPointer() {
    if (drag?.record !== 'draft') return;
    const pointerId = activePointer;
    activePointer = null;
    drag = null;
    touchPointers.clear();
    releasePointer(pointerId);
  }

  function cancelTouchEdit() {
    const cancelledPointer = activePointer;
    const needsRebuild = drag?.record !== 'draft' && (drag?.moved || drag?.added);
    if (drag?.record !== 'draft' && drag?.before) {
      restoreStrokeEdit(drag.record, drag.before);
    } else if (drag?.kind === 'radius') {
      const radii = radiusScalesFor(drag.record);
      if (radii?.[drag.index] != null) radii[drag.index] = drag.startRadius;
    } else if (drag?.added) {
      const cvs = drag.record === 'draft' ? draft?.cvs : drag.record?.cvs;
      const radii = radiusScalesFor(drag.record);
      if (cvs && radii) {
        cvs.splice(drag.index, 1);
        radii.splice(drag.index, 1);
        if (drag.record === 'draft' && cvs.length === 0) draft = null;
      }
    } else if (drag?.start) {
      const cvs = drag.record === 'draft' ? draft?.cvs : drag.record?.cvs;
      if (cvs?.[drag.index]) cvs[drag.index] = drag.start;
    }
    activePointer = null;
    drag = null;
    releasePointer(cancelledPointer);
    if (selected?.record === 'draft' && !draft?.cvs[selected.index]) selected = null;
    syncRadiusControl();
    refreshGuides();
    refreshDraftPreview();
    if (needsRebuild) {
      refreshDragPreview();
      scheduleRebuild(0);
    }
  }

  // Deliberately centralized: a future pen-pressure curve only needs to map
  // PointerEvent.pressure here; records and geometry already consume the scale.
  function radiusScaleForPointer(_event) {
    return clampCvRadiusScale(state.cvRadiusScale);
  }

  /** Middle-click: insert a CV on the selected committed spline only. */
  function tryInsertCvAtPointer(event) {
    if (selectionBlocked()) return false;
    if (drawing || drag || draft) return false;
    if (!isSplineRecord(activeRecord) || !strokes.includes(activeRecord)) return false;
    const p = planePoint(event);
    if (!p) return false;
    if (pickCv(p, event.pointerType)) return false;

    let best = null;
    let bestScore = Infinity;
    const pixelPad = worldPerPixel() * STROKE_PICK_PAD_PX;
    const paths = pathsForRecord(activeRecord);
    for (let copy = 0; copy < paths.length; copy++) {
      const path = paths[copy];
      const hit = closestPointOnPolyline2D(p, path);
      const localRadius = cvRadiusGuideRadius(state.thickness, hit.radiusScale);
      const reach = localRadius + pixelPad;
      if (hit.distance > reach) continue;
      const score = hit.distance / Math.max(localRadius, pixelPad, 1e-9);
      if (score < bestScore) {
        bestScore = score;
        best = { copyIndex: copy, path, hit };
      }
    }
    if (!best) return false;

    const { copyIndex, path: displayPath, hit: displayHit } = best;
    const displayPoint = pointOnPolyline2DHit(displayPath, displayHit);
    if (!displayPoint) return false;

    if (!isCvTool()) setDrawTool('spline');

    const targetRecord = activeRecord;
    const before = cloneStrokeEdit(targetRecord);
    const cvs = targetRecord.cvs;
    const radii = radiusScalesFor(targetRecord);
    const closed = targetRecord.closed === true;
    const authorityPoint = inverseStrokeCopyPoint(displayPoint, targetRecord.draw, copyIndex);
    const authorityPath = targetRecord.points ?? sampleSplinePoints(cvs, closed, radii);
    const authorityHit = closestPointOnPolyline2D(authorityPoint, authorityPath);
    // `authorityPath` is sampled uniformly in spline parameter, not arc length.
    // Use that parameter so long/short curve sections cannot shift the CV slot.
    const insertAt = cvInsertIndexFromHit(cvs.length, closed, authorityHit);
    const radius = clampCvRadiusScale(displayHit.radiusScale);

    cvs.splice(insertAt, 0, [authorityPoint[0], authorityPoint[1]]);
    radii.splice(insertAt, 0, radius);
    updateSplineRecord(targetRecord, cvs, closed, radii);
    activeCopy = copyIndex;
    sigilMesh.visible = false;

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
      moved: false,
      added: true,
      copyIndex,
      before,
      start: [authorityPoint[0], authorityPoint[1]],
    };
    lastPressEditedCv = true;
    lastPlacedCv = null;
    hoveredStroke = null;
    renderer.domElement.style.cursor = 'grabbing';
    refreshGuides();
    refreshDragPreview();
    return true;
  }

  /** Right-click: delete a CV on the draft or the active committed spline. */
  function tryDeleteCvAtPointer(event) {
    if (drawing || drag) return false;
    if (!isCvTool()) return false;
    const p = planePoint(event);
    if (!p) return false;
    const pick = pickCv(p, event.pointerType);
    if (!pick || pick.kind === 'radius') return false;

    if (pick.record === 'draft') {
      if (!draft?.cvs.length) return false;
      const [cv] = draft.cvs.splice(pick.index, 1);
      const [radiusScale] = draft.cvRadiusScales.splice(pick.index, 1);
      draftUndo.push({ index: pick.index, cv, radiusScale });
      lastPlacedCv = null;
      if (draft.cvs.length === 0) {
        const restored = restoreContinuedStroke();
        draft = null;
        draftUndo.length = 0;
        if (selected?.record === 'draft') selected = null;
        syncRadiusControl();
        refreshGuides();
        refreshDraftPreview();
        if (restored) scheduleRebuild(0);
        return true;
      }
      if (selected?.record === 'draft') {
        selected.index = Math.min(selected.index, draft.cvs.length - 1);
      }
      syncRadiusControl();
      refreshGuides();
      refreshDraftPreview();
      return true;
    }

    if (pick.record !== activeRecord || !isSplineRecord(activeRecord)) return false;
    const record = activeRecord;
    if (record.cvs.length <= 2) {
      // A spline needs two CVs; remove the whole stroke instead.
      const index = strokes.indexOf(record);
      if (index < 0) return false;
      strokes.splice(index, 1);
      recordHistory({ type: 'remove', record, index });
      if (selected?.record === record) selected = null;
      activeRecord = null;
      activeCopy = 0;
      hoveredStroke = null;
      holdPreviewUntilRebuild = false;
      syncRadiusControl();
      clearMesh(dragMesh);
      refreshFreehandPreview();
      refreshGuides();
      rebuild();
      return true;
    }

    const before = cloneStrokeEdit(record);
    const cvs = record.cvs;
    const radii = record.cvRadiusScales;
    cvs.splice(pick.index, 1);
    radii.splice(pick.index, 1);
    updateSplineRecord(record, cvs, record.closed, radii);
    if (selected?.record === record) {
      selected.index = Math.min(selected.index, cvs.length - 1);
    }
    recordHistory({
      type: 'edit',
      record,
      before,
      after: cloneStrokeEdit(record),
    });
    syncRadiusControl();
    refreshGuides();
    scheduleRebuild(0);
    return true;
  }

  function updatePointerHover(p, pointerType = 'mouse', forceNew = false) {
    const suppressPicking = (forceNew || selectionBlocked()) && !draft;
    const pick = suppressPicking ? null : pickCv(p, pointerType);
    const strokePick = !suppressPicking && !pick ? pickOtherStroke(p) : null;
    const hoverChanged = hoveredStroke?.record !== strokePick?.record
      || hoveredStroke?.copyIndex !== strokePick?.copyIndex;
    hoveredStroke = strokePick;
    if (hoverChanged) refreshGuides();
    renderer.domElement.style.cursor = pick?.kind === 'radius'
      ? 'nwse-resize'
      : pick
        ? 'grab'
        : strokePick
          ? 'pointer'
          : 'crosshair';
    if (draft) {
      draft.hover = pick ? null : p;
      refreshDraftPreview();
    }
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
        if (drawing) cancelFreehandStroke();
        else cancelTouchEdit();
        return;
      }
    }
    if (event.button !== 0) return;
    const p = planePoint(event);
    if (!p) return;
    activePointer = event.pointerId;
    try {
      renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      // Some event sources do not create a capturable pointer.
    }

    if (!isCvTool()) {
      const forceNew = event.shiftKey || selectionBlocked();
      const strokePick = forceNew ? null : pickOtherStroke(p);
      if (strokePick) {
        activePointer = null;
        releasePointer(event.pointerId);
        activateRecord(strokePick.record, strokePick.copyIndex);
        renderer.domElement.style.cursor = 'pointer';
        return;
      }
      drawing = true;
      current = [];
      holdPreviewUntilRebuild = false;
      pushFreehandPoint(p);
      refreshCurrentGuide();
      refreshFreehandPreview();
      updateHints();
      return;
    }

    const forceNew = (event.shiftKey || selectionBlocked()) && !draft;
    const pickedCv = forceNew ? null : pickCv(p, event.pointerType);
    const strokePick = !forceNew && !pickedCv ? pickOtherStroke(p) : null;
    const repeatsPlacedTail = !!pickedCv
      && pickedCv.record === 'draft'
      && pickedCv.index === lastPlacedCv?.index
      && event.timeStamp - lastPlacedCv.timeStamp <= DOUBLE_CLICK_WINDOW_MS
      && Math.hypot(event.clientX - lastPlacedCv.clientX, event.clientY - lastPlacedCv.clientY)
        <= DOUBLE_CLICK_SLOP_PX;
    // Let the second press of a double-click place its temporary duplicate.
    // The dblclick handler removes that duplicate before committing.
    const pick = repeatsPlacedTail ? null : pickedCv;
    lastPressEditedCv = (!!pick && !repeatsPlacedTail) || !!strokePick;
    if ((pick && !repeatsPlacedTail) || strokePick) lastPlacedCv = null;

    if (strokePick) {
      activePointer = null;
      releasePointer(event.pointerId);
      continueEndpoint = null;
      activateRecord(strokePick.record, strokePick.copyIndex);
      renderer.domElement.style.cursor = 'grab';
      return;
    }

    // Close the draft loop by clicking its first CV.
    if (pick?.kind === 'move' && pick.record === 'draft' && pick.index === 0
      && draft.cvs.length >= CLOSE_MIN_CVS && !event.shiftKey) {
      selectCv('draft', 0);
      commitDraft(true);
      return;
    }

    if (pick) {
      const cvs = pick.record === 'draft' ? draft.cvs : pick.record.cvs;
      selectCv(pick.record, pick.index);
      if (pick.record !== 'draft' && isSplineRecord(pick.record) && !pick.record.closed) {
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
      if (pick.kind === 'radius') {
        const radii = radiusScalesFor(pick.record);
        drag = {
          kind: 'radius',
          record: pick.record,
          index: pick.index,
          moved: false,
          added: false,
          copyIndex: pick.record === 'draft' ? 0 : activeCopy,
          before: pick.record === 'draft' ? null : cloneStrokeEdit(pick.record),
          startRadius: radii[pick.index],
          startDistance: Math.hypot(p[0] - pick.cv[0], p[1] - pick.cv[1]),
        };
        renderer.domElement.style.cursor = 'nwse-resize';
      } else {
        drag = {
          kind: 'move',
          record: pick.record,
          index: pick.index,
          moved: false,
          added: false,
          copyIndex: pick.record === 'draft' ? 0 : activeCopy,
          before: pick.record === 'draft' ? null : cloneStrokeEdit(pick.record),
          start: [...cvs[pick.index]],
        };
        renderer.domElement.style.cursor = 'grabbing';
      }
      refreshGuides();
      return;
    }

    // Place a new CV and drag it until release for fine positioning.
    lastPressEditedCv = false;
    continueEndpoint = null;
    hoveredStroke = null;
    draftUndo.length = 0;
    if (!draft) draft = { cvs: [], cvRadiusScales: [], hover: null };
    draft.cvs.push([p[0], p[1]]);
    draft.cvRadiusScales.push(radiusScaleForPointer(event));
    drag = { kind: 'move', record: 'draft', index: draft.cvs.length - 1, moved: false, added: true, start: null };
    lastPlacedCv = {
      index: drag.index,
      timeStamp: event.timeStamp,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    selectCv('draft', drag.index);
    refreshGuides();
    refreshDraftPreview();
  }, { signal });

  renderer.domElement.addEventListener('pointermove', (event) => {
    const p = planePoint(event);
    if (!p) return;

    if (!isCvTool()) {
      if (drawing && event.pointerId === activePointer) {
        const before = current.length;
        pushFreehandPoint(p);
        if (before === current.length) return;
        refreshCurrentGuide();
        refreshFreehandPreview();
        return;
      }
      updatePointerHover(p, event.pointerType, event.shiftKey);
      return;
    }

    if (drag && event.pointerId === activePointer) {
      drag.moved = true;
      if (drag.record !== 'draft' && !drag.previewStarted) {
        drag.previewStarted = true;
        clearTimeout(rebuildTimer);
        sigilMesh.visible = false;
      }
      if (drag.kind === 'radius') {
        const cvs = drag.record === 'draft' ? draft?.cvs : drag.record.cvs;
        const baseCv = cvs?.[drag.index];
        if (!baseCv) return;
        const displayCv = drag.record === 'draft'
          ? baseCv
          : transformStrokeCopyPoint(baseCv, drag.record.draw, drag.copyIndex);
        const currentDistance = Math.hypot(p[0] - displayCv[0], p[1] - displayCv[1]);
        const scale = cvRadiusScaleFromDrag(
          drag.startRadius,
          drag.startDistance,
          currentDistance,
          state.thickness,
        );
        applySelectedRadius(scale, { scheduleCommitted: false });
        renderer.domElement.style.cursor = 'nwse-resize';
      } else if (drag.record === 'draft') {
        draft.cvs[drag.index] = [p[0], p[1]];
        refreshGuides();
        refreshDraftPreview();
      } else {
        const cvs = drag.record.cvs;
        const basePoint = inverseStrokeCopyPoint(p, drag.record.draw, drag.copyIndex);
        cvs[drag.index] = [basePoint[0], basePoint[1]];
        updateSplineRecord(drag.record, cvs);
        refreshGuides();
        refreshDragPreview();
      }
      return;
    }

    // Hover: tentative next CV plus direct switching feedback for other strokes.
    updatePointerHover(p, event.pointerType, event.shiftKey);
  }, { signal });

  renderer.domElement.addEventListener('pointerleave', () => {
    if (drawing || drag) return;
    const hadHover = !!hoveredStroke;
    hoveredStroke = null;
    if (draft?.hover) {
      draft.hover = null;
      refreshDraftPreview();
    }
    if (hadHover) refreshGuides();
    renderer.domElement.style.cursor = 'crosshair';
  }, { signal });

  function endDrag(event) {
    if (event.pointerType === 'touch') touchPointers.delete(event.pointerId);
    if (event.pointerId !== activePointer) return;
    if (drawing) {
      finishFreehandStroke();
      return;
    }
    activePointer = null;
    releasePointer(event.pointerId);
    if (!drag) return;
    const finished = drag;
    drag = null;
    if (finished.record !== 'draft' && finished.before && (finished.moved || finished.added)) {
      recordHistory({
        type: 'edit',
        record: finished.record,
        before: finished.before,
        after: cloneStrokeEdit(finished.record),
      });
      scheduleRebuild(0);
    }
    refreshGuides();
    const p = planePoint(event);
    updatePointerHover(p, event.pointerType, event.shiftKey);
  }

  renderer.domElement.addEventListener('pointerup', endDrag, { signal });
  renderer.domElement.addEventListener('pointercancel', (event) => {
    if (event.pointerType === 'touch') touchPointers.delete(event.pointerId);
    if (event.pointerId === activePointer) {
      if (drawing) cancelFreehandStroke();
      else cancelTouchEdit();
    }
  }, { signal });

  renderer.domElement.addEventListener('dblclick', (event) => {
    if (!isCvTool()) return;

    if (!draft && continueEndpoint
      && event.timeStamp - continueEndpoint.timeStamp <= DOUBLE_CLICK_WINDOW_MS
      && Math.hypot(
        event.clientX - continueEndpoint.clientX,
        event.clientY - continueEndpoint.clientY,
      ) <= DOUBLE_CLICK_SLOP_PX) {
      const { record, end } = continueEndpoint;
      continueEndpoint = null;
      lastPlacedCv = null;
      if (strokes.includes(record) && isSplineRecord(record) && !record.closed) {
        continueCommittedSpline(record, end);
      }
      return;
    }

    if (!draft || lastPressEditedCv) {
      lastPlacedCv = null;
      continueEndpoint = null;
      return;
    }
    // The double click's second press placed a duplicate CV — drop it.
    if (draft.cvs.length >= 2) {
      draft.cvs.pop();
      draft.cvRadiusScales.pop();
      if (selected?.record === 'draft' && selected.index >= draft.cvs.length) {
        selected.index = draft.cvs.length - 1;
      }
    }
    commitDraft(false);
  }, { signal });

  addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const canvasContext = event.target === renderer.domElement || event.target === document.body;
    if (event.key === 'Tab' && !selectionBlocked()
      && !draft && !drawing && canvasContext && strokes.length > 1) {
      event.preventDefault();
      cycleActiveRecord(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Enter' && draft) {
      commitDraft(false);
    } else if (event.key === 'Escape') {
      if (draft) cancelDraft();
      else if (selected) clearSelection();
      else if (activeRecord) {
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
      && !draft && !drawing && activeRecord) {
      event.preventDefault();
      deleteActiveStroke();
    }
  }, { signal });

  // --- buttons --------------------------------------------------------------

  function undoAction() {
    if (drawing) finishFreehandStroke();
    if (draft) {
      if (undoDraftDelete()) return;
      popDraftCv();
      return;
    }
    let action = undoActions.pop();
    if (!action && strokes.length > 0) {
      const record = strokes.at(-1);
      action = { type: 'add', record, index: strokes.length - 1 };
    }
    if (!action) return;
    const preferred = applyHistoryAction(action, false);
    redoActions.push(action);
    refreshAfterHistory(preferred);
  }

  function redoAction() {
    if (draft) return; // CV-level redo inside a draft isn't tracked
    const action = redoActions.pop();
    if (!action) return;
    const preferred = applyHistoryAction(action, true);
    undoActions.push(action);
    refreshAfterHistory(preferred);
  }

  for (const button of ui.toolButtons) {
    button.addEventListener('click', () => setDrawTool(button.dataset.drawTool), { signal });
  }
  ui.defaults.addEventListener('click', applyDrawDefaults, { signal });
  ui.undo.addEventListener('click', undoAction, { signal });
  ui.clear.addEventListener('click', () => {
    if (drawing) finishFreehandStroke();
    draft = null;
    draftUndo.length = 0;
    drag = null;
    selected = null;
    activeRecord = null;
    activeCopy = 0;
    hoveredStroke = null;
    current = [];
    holdPreviewUntilRebuild = false;
    const records = strokes.splice(0);
    if (records.length) recordHistory({ type: 'clear', records });
    clearMesh(draftMesh);
    clearMesh(dragMesh);
    clearMesh(freehandMesh);
    syncRadiusControl();
    refreshGuides();
    rebuild();
  }, { signal });
  bindUndoRedoKeys({ undo: undoAction, redo: redoAction, signal });

  for (const record of splineRecords()) {
    const normalized = normalizeCvRadiusScales(record.cvs, record.cvRadiusScales);
    if (!Array.isArray(record.cvRadiusScales)
      || record.cvRadiusScales.length !== normalized.length
      || normalized.some((radius, index) => radius !== record.cvRadiusScales[index])) {
      updateSplineRecord(
        record,
        record.cvs,
        record.closed,
        normalized,
      );
    }
  }
  interaction?.addEventListener?.('blockselectionchange', syncSelectionBlock, { signal });
  if (selectionBlocked()) syncSelectionBlock();
  else ensureActiveRecord();
  updateToolUi();
  syncRadiusControl();
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
    scaleHandles();
    // Hold the converged trace while editing. Only the live drawing preview is
    // composited; committed guides, selections and CV controls stay out.
    const editing = drawing || !!draft || !!drag;
    const holdTrace = editing || buildingCount > 0;
    const liveCurveMesh = drawing ? freehandMesh : (draft ? draftMesh : null);
    const liveCurveVisible = (liveCurveMesh?.geometry.getAttribute('position')?.count ?? 0) > 0;
    pathTrace.setHold(holdTrace);
    if (pathTrace.active) {
      draftMesh.visible = false;
      dragMesh.visible = false;
      freehandMesh.visible = false;
      overlay.visible = false;
      guideGroup.visible = false;
    }
    const traced = pathTrace.render(); // owns the frame while path tracing
    if (!traced) {
      photon.update(); // GPU compute passes before the scene draw
      renderer.render(scene, camera);
    } else if (liveCurveVisible) {
      liveCurveMesh.visible = true;
      const prevAutoClear = renderer.autoClearColor;
      renderer.autoClearColor = false;
      pathTrace.beginComposite();
      renderer.render(scene, camera);
      pathTrace.endComposite();
      renderer.autoClearColor = prevAutoClear;
      liveCurveMesh.visible = false;
    }

    const now = performance.now();
    fpsClock += now - lastT;
    lastT = now;
    frames++;
    if (fpsClock >= 500) {
      const fps = Math.round((frames * 1000) / fpsClock);
      const toolTag = isCvTool() ? 'CV' : 'freehand';
      const cvCount = draft ? ` · ${draft.cvs.length} cv` : '';
      const activeIndex = strokes.indexOf(activeRecord);
      const copyCount = activeRecord ? strokeCopyCount(activeRecord.draw) : 0;
      const strokeTag = !draft && activeIndex >= 0
        ? ` · stroke ${activeIndex + 1}/${strokes.length}${copyCount > 1 ? ` · copy ${activeCopy + 1}/${copyCount}` : ''}`
        : '';
      const radius = isCvTool() && isSplineRecord(activeRecord)
        ? selectedTarget()?.radii[selected.index]
        : null;
      const radiusTag = radius == null ? '' : ` · radius ×${radius.toFixed(2)}`;
      const busy = buildingCount > 0 ? ' · building…' : '';
      const err = lastError ? ` · error: ${lastError}` : '';
      const backendTag = renderBackend === 'webgl' ? ' · gl' : '';
      statsEl.textContent = traced
        ? `${fps} fps · path tracing · ${pathTrace.samples()} spp${err}`
        : `${fps} fps · ${toolTag} · ${vertexCount} verts · ${blendBackend}${backendTag}${cvCount}${strokeTag}${radiusTag}${busy}${err}`;
      frames = 0;
      fpsClock = 0;
    }
  });

  return () => {
    abort.abort();
    clearTimeout(rebuildTimer);
    hullMaterial.dispose();
    guideMaterial.dispose();
    activeGuideMaterial.dispose();
    hoverGuideMaterial.dispose();
    handleGeometry.dispose();
    radiusGuideGeometry.dispose();
    for (const m of Object.values(handleMaterials)) m.dispose();
    for (const m of Object.values(radiusGuideMaterials)) m.dispose();
    sigilMaterial.dispose();
    scene.remove(sigilMesh, draftMesh, dragMesh, freehandMesh, overlay, guideGroup);
    sigilMesh.geometry.dispose();
    draftMesh.geometry.dispose();
    dragMesh.geometry.dispose();
    freehandMesh.geometry.dispose();
    photon.dispose();
    pathTrace.dispose();
    ctx.setAnimationLoop(null);
  };
}
