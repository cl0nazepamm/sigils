/**
 * CV Curves — Alias-style editable B-spline drawing.
 *
 * Left click places control vertices; the curve follows the CV hull
 * (approximating, never interpolating). Click the first CV to close the loop,
 * double-click or Enter to commit an open curve, Escape cancels, Backspace
 * removes the last CV. CVs stay editable after commit: grab any handle and
 * drag — the scene shows fast strip previews during the drag and re-melts the
 * merged sigil on release.
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
import {
  buildOptionsForSession,
  committedBuildPaths,
  expandActivePaths,
  isDrawSettingKey,
  isSplineRecord,
  makeSplineRecord,
  sampleSplinePoints,
  updateSplineRecord,
} from '../shared/strokeSession.js';

export const meta = {
  id: 'spline',
  label: 'CV Curves',
};

const PICK_RADIUS_PX = 14;
const HANDLE_RADIUS_PX = 5;
const CLOSE_MIN_CVS = 3;

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
      <h2>CV Curves</h2>
    </div>
    <div id="controls"></div>
    <div class="buttons">
      <button id="defaults" type="button">Draw defaults</button>
      <button id="undo" type="button">Undo</button>
      <button id="clear" type="button">Clear</button>
      <button id="export-glb" type="button">GLB</button>
    </div>
  `;
  infoRoot.innerHTML = `<b>sigils · cv curves</b><br /><span id="stats">—</span><br /><span class="hint">click: place cv · first cv: close · dblclick/enter: commit · esc: cancel</span>`;

  const statsEl = infoRoot.querySelector('#stats');
  const controlsRoot = panelRoot.querySelector('#controls');
  let sigilMaterial = createChromeMaterial(chromeOptionsFromState(state));
  const defaultState = createDrawDemoState();

  // The strip-only toggle belongs to the freehand mode's flow.
  const controlSpecs = DEMO_CONTROL_SPECS.filter((spec) => spec.key !== 'previewStripOnly');

  const controlUi = mountControlPanel(controlsRoot, controlSpecs, state, {
    onChange: (key) => {
      if (key === 'orthographic') {
        camera = ctx.setOrthographicView(state.orthographic);
        return;
      }
      if (key === 'guides') refreshGuides();
      if (key === 'profile') replaceChromeMaterial();
      refreshDraftPreview();
      if (isDrawSettingKey(key)) return;
      scheduleRebuild();
    },
    onLive: () => {
      updateChromeMaterial(sigilMaterial, chromeOptionsFromState(state));
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

  // --- CV handles + hulls -------------------------------------------------
  const overlay = new THREE.Group();
  overlay.renderOrder = 3;
  scene.add(overlay);

  const handleGeometry = new THREE.CircleGeometry(1, 24);
  const handleMaterials = {
    draft: new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95 }),
    close: new THREE.MeshBasicMaterial({ color: 0xffd24d, depthTest: false, transparent: true, opacity: 0.95 }),
    committed: new THREE.MeshBasicMaterial({ color: 0x9fc2d8, depthTest: false, transparent: true, opacity: 0.75 }),
    active: new THREE.MeshBasicMaterial({ color: 0x6fd0ff, depthTest: false, transparent: true, opacity: 1 }),
  };
  const hullMaterial = new THREE.LineBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0.45, depthTest: false });
  const guideMaterial = new THREE.LineBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0.7, depthTest: false });
  const guideGroup = new THREE.Group();
  guideGroup.renderOrder = 2;
  scene.add(guideGroup);

  let draft = null; // { cvs: [[x,y],…], hover: [x,y]|null }
  let drag = null;  // { record: 'draft'|splineRecord, index, moved }
  let rebuildVersion = 0;
  let rebuildTimer = 0;
  let vertexCount = 0;
  let lastError = '';
  let blendBackend = '—';

  const ui = {
    defaults: panelRoot.querySelector('#defaults'),
    undo: panelRoot.querySelector('#undo'),
    clear: panelRoot.querySelector('#clear'),
    exportGlb: panelRoot.querySelector('#export-glb'),
  };

  bindGlbExportButton(ui.exportGlb, { strokes, state, renderer, signal });
  bindRightDragOrbit(ctx, { signal, getCamera: () => camera });

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
    previous.dispose();
  }

  function applyDrawDefaults() {
    Object.assign(state, createDrawDemoState());
    syncControlPanelToState(controlUi, state, panelRoot);
    camera = ctx.setOrthographicView(state.orthographic);
    replaceChromeMaterial();
    refreshGuides();
    refreshDraftPreview();
    scheduleRebuild(0);
  }

  function scheduleRebuild(delay = 120) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, delay);
  }

  // --- overlays -----------------------------------------------------------

  function splineRecords() {
    return strokes.filter(isSplineRecord);
  }

  // Group.clear() does not dispose geometry; hull/guide lines own theirs
  // (handles share handleGeometry, which outlives the group).
  function emptyGroup(group) {
    for (const child of group.children) {
      if (!child.userData.isHandle) child.geometry?.dispose();
    }
    group.clear();
  }

  function refreshGuides() {
    emptyGroup(guideGroup);
    emptyGroup(overlay);

    // Hull + handles for the draft.
    if (draft && draft.cvs.length > 0) {
      addHull(draft.cvs, false);
      draft.cvs.forEach((cv, i) => {
        const closable = i === 0 && draft.cvs.length >= CLOSE_MIN_CVS;
        addHandle(cv, closable ? handleMaterials.close : handleMaterials.draft);
      });
    }

    // Hull + handles for committed spline records.
    for (const record of splineRecords()) {
      addHull(record.cvs, record.closed);
      const dragged = drag && drag.record === record;
      record.cvs.forEach((cv, i) => {
        const active = dragged && drag.index === i;
        addHandle(cv, active ? handleMaterials.active : handleMaterials.committed);
      });
    }

    // Sampled-curve guide lines (the freehand 'Curves' toggle).
    if (state.guides) {
      guideGroup.visible = true;
      const paths = committedBuildPaths(strokes);
      if (draft && draft.cvs.length >= 2) paths.push(sampleSplinePoints(draft.cvs, false));
      for (const path of paths) {
        if (path.length < 2) continue;
        const pts = path.map(([x, y]) => new THREE.Vector3(x, y, 0.012));
        guideGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), guideMaterial));
      }
    }
  }

  function addHull(cvs, closed) {
    if (cvs.length < 2) return;
    const pts = cvs.map(([x, y]) => new THREE.Vector3(x, y, 0.016));
    if (closed) pts.push(pts[0].clone());
    overlay.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), hullMaterial));
  }

  function addHandle(cv, material) {
    const mesh = new THREE.Mesh(handleGeometry, material);
    mesh.position.set(cv[0], cv[1], 0.02);
    mesh.userData.isHandle = true;
    overlay.add(mesh);
  }

  function scaleHandles() {
    const s = worldPerPixel() * HANDLE_RADIUS_PX;
    for (const child of overlay.children) {
      if (child.userData.isHandle) child.scale.setScalar(s);
    }
  }

  // --- picking ------------------------------------------------------------

  function pickCv(p) {
    if (!p) return null;
    const radius = worldPerPixel() * PICK_RADIUS_PX;
    let best = null;
    let bestDist = radius;

    const consider = (record, cvs) => {
      for (let i = 0; i < cvs.length; i++) {
        const d = Math.hypot(cvs[i][0] - p[0], cvs[i][1] - p[1]);
        if (d <= bestDist) {
          best = { record, index: i };
          bestDist = d;
        }
      }
    };

    if (draft) consider('draft', draft.cvs);
    const records = splineRecords();
    for (let r = records.length - 1; r >= 0; r--) consider(records[r], records[r].cvs);
    return best;
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
      symmetry: 1,
      mirror: false,
      phase: 0,
    };
  }

  function refreshDraftPreview() {
    if (!draft) {
      clearMesh(draftMesh);
      return;
    }
    const cvs = draft.hover && !drag ? [...draft.cvs, draft.hover] : draft.cvs;
    if (cvs.length < 2) {
      clearMesh(draftMesh);
      return;
    }
    const sampled = sampleSplinePoints(cvs, false);
    const paths = expandActivePaths(sampled, state);
    setMeshGeometry(draftMesh, buildSparseCurveGeometry(paths, stripOptions()));
  }

  function refreshDragPreview() {
    const paths = committedBuildPaths(strokes);
    if (paths.length === 0) {
      clearMesh(dragMesh);
      return;
    }
    setMeshGeometry(dragMesh, buildSparseCurveGeometry(paths, stripOptions()));
  }

  function updateVertexCount() {
    let count = 0;
    for (const mesh of [sigilMesh, draftMesh, dragMesh]) {
      if (mesh.visible) count += mesh.geometry.getAttribute('position')?.count ?? 0;
    }
    vertexCount = count;
  }

  // --- merged rebuild -----------------------------------------------------

  async function rebuild() {
    try {
      lastError = '';
      if (strokes.length === 0) {
        clearMesh(sigilMesh);
        clearMesh(dragMesh);
        blendBackend = '—';
        return;
      }

      const version = ++rebuildVersion;
      const paths = committedBuildPaths(strokes);
      const geometry = await buildSigilGeometryAsync(paths, {
        ...buildOptionsForSession(state),
        renderer,
        onGpuFallback: (error) => console.warn('sigils: hybrid field fallback', error),
      });

      if (version !== rebuildVersion) {
        geometry.dispose();
        return;
      }

      blendBackend = geometry.userData.fieldBackend
        ?? geometry.userData.sigilizeBackend
        ?? geometry.userData.buildBackend
        ?? state.backend;

      setMeshGeometry(sigilMesh, geometry);
      // A new committed-CV drag may have started while this build was in
      // flight; keep showing strips until ITS release-rebuild lands.
      if (drag && drag.record !== 'draft') {
        sigilMesh.visible = false;
      } else {
        clearMesh(dragMesh);
      }
    } catch (error) {
      lastError = error?.message ?? String(error);
      console.error('sigils rebuild failed', error);
    }
  }

  // --- draft lifecycle ----------------------------------------------------

  function commitDraft(closed) {
    if (!draft || draft.cvs.length < 2) {
      cancelDraft();
      return;
    }
    strokes.push(makeSplineRecord(draft.cvs, closed, state));
    draft = null;
    clearMesh(draftMesh);
    refreshGuides();
    scheduleRebuild(0);
  }

  function cancelDraft() {
    draft = null;
    clearMesh(draftMesh);
    refreshGuides();
  }

  function popDraftCv() {
    if (!draft || draft.cvs.length === 0) return;
    draft.cvs.pop();
    if (draft.cvs.length === 0) draft = null;
    refreshGuides();
    refreshDraftPreview();
  }

  // --- pointer interaction --------------------------------------------------

  let activePointer = null;

  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const p = planePoint(event);
    if (!p) return;
    activePointer = event.pointerId;
    try {
      renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      // Some event sources do not create a capturable pointer.
    }

    const pick = pickCv(p);

    // Close the draft loop by clicking its first CV.
    if (pick && pick.record === 'draft' && pick.index === 0 && draft.cvs.length >= CLOSE_MIN_CVS) {
      commitDraft(true);
      return;
    }

    if (pick) {
      drag = { record: pick.record, index: pick.index, moved: false };
      if (pick.record !== 'draft') {
        sigilMesh.visible = false;
        refreshDragPreview();
      }
      refreshGuides();
      return;
    }

    // Place a new CV and drag it until release for fine positioning.
    if (!draft) draft = { cvs: [], hover: null };
    draft.cvs.push([p[0], p[1]]);
    drag = { record: 'draft', index: draft.cvs.length - 1, moved: false };
    refreshGuides();
    refreshDraftPreview();
  }, { signal });

  renderer.domElement.addEventListener('pointermove', (event) => {
    const p = planePoint(event);
    if (!p) return;

    if (drag && event.pointerId === activePointer) {
      drag.moved = true;
      if (drag.record === 'draft') {
        draft.cvs[drag.index] = [p[0], p[1]];
        refreshGuides();
        refreshDraftPreview();
      } else {
        const cvs = drag.record.cvs;
        cvs[drag.index] = [p[0], p[1]];
        updateSplineRecord(drag.record, cvs);
        refreshGuides();
        refreshDragPreview();
      }
      return;
    }

    // Hover: tentative next CV for the draft curve + grab cursor over handles.
    const pick = pickCv(p);
    renderer.domElement.style.cursor = pick ? 'grab' : 'crosshair';
    if (draft) {
      draft.hover = p;
      refreshDraftPreview();
    }
  }, { signal });

  function endDrag(event) {
    if (event.pointerId !== activePointer) return;
    activePointer = null;
    if (!drag) return;
    const wasCommittedEdit = drag.record !== 'draft';
    drag = null;
    refreshGuides();
    if (wasCommittedEdit) scheduleRebuild(0);
  }

  renderer.domElement.addEventListener('pointerup', endDrag, { signal });
  renderer.domElement.addEventListener('pointercancel', endDrag, { signal });

  renderer.domElement.addEventListener('dblclick', () => {
    if (!draft) return;
    // The double click's second press placed a duplicate CV — drop it.
    if (draft.cvs.length >= 2) draft.cvs.pop();
    commitDraft(false);
  }, { signal });

  addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (event.key === 'Enter' && draft) {
      commitDraft(false);
    } else if (event.key === 'Escape' && draft) {
      cancelDraft();
    } else if (event.key === 'Backspace' && draft) {
      event.preventDefault();
      popDraftCv();
    }
  }, { signal });

  // --- buttons --------------------------------------------------------------

  ui.defaults.addEventListener('click', applyDrawDefaults, { signal });
  ui.undo.addEventListener('click', () => {
    if (draft) {
      popDraftCv();
      return;
    }
    strokes.pop();
    clearMesh(dragMesh);
    refreshGuides();
    rebuild();
  }, { signal });
  ui.clear.addEventListener('click', () => {
    draft = null;
    drag = null;
    strokes.length = 0;
    clearMesh(draftMesh);
    clearMesh(dragMesh);
    refreshGuides();
    rebuild();
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
    scaleHandles();
    renderer.render(scene, camera);

    const now = performance.now();
    fpsClock += now - lastT;
    lastT = now;
    frames++;
    if (fpsClock >= 500) {
      const fps = Math.round((frames * 1000) / fpsClock);
      const cvCount = draft ? ` · ${draft.cvs.length} cv` : '';
      const err = lastError ? ` · error: ${lastError}` : '';
      statsEl.textContent = `${fps} fps · ${vertexCount} verts · ${blendBackend}${cvCount}${err}`;
      frames = 0;
      fpsClock = 0;
    }
  });

  return () => {
    abort.abort();
    clearTimeout(rebuildTimer);
    hullMaterial.dispose();
    guideMaterial.dispose();
    handleGeometry.dispose();
    for (const m of Object.values(handleMaterials)) m.dispose();
    sigilMaterial.dispose();
    scene.remove(sigilMesh, draftMesh, dragMesh, overlay, guideGroup);
    sigilMesh.geometry.dispose();
    draftMesh.geometry.dispose();
    dragMesh.geometry.dispose();
    ctx.setAnimationLoop(null);
  };
}
