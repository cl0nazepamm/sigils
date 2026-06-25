import {
  buildSparseCurveGeometry,
  buildSigilGeometryAsync,
  createChromeMaterial,
  createSigilState,
  shapeOptionsFromState,
  sparsePreviewOptionsFromState,
  chromeOptionsFromState,
  updateChromeMaterial,
} from '../../src/index.js';
import { createDrawPlane } from '../shared/demoContext.js';
import { mountControlPanel } from '../shared/controlPanel.js';
import { DEMO_CONTROL_SPECS } from '../shared/demoControlSpecs.js';

export const meta = {
  id: 'realtime',
  label: 'Sigils',
  hint: 'Draw chrome sigils · sparse preview while dragging, SDF merge on release',
};

export function mount(ctx, { panelRoot, infoRoot }) {
  const { THREE, renderer, scene, camera, controls } = ctx;
  const abort = new AbortController();
  const { signal } = abort;
  const { planePoint } = createDrawPlane(camera);

  camera.up.set(0, 1, 0);
  camera.position.set(0, -0.85, 3.7);
  controls.target.set(0, 0, 0);
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: null };
  renderer.domElement.style.cursor = 'crosshair';

  const state = createSigilState();

  panelRoot.innerHTML = `
    <div class="mode-head">
      <h2>Sigils</h2>
      <p class="sub">${meta.hint}</p>
    </div>
    <div id="controls"></div>
    <div class="buttons">
      <button id="undo" type="button">Undo</button>
      <button id="clear" type="button">Clear</button>
    </div>
    <div class="note">Left-drag to draw. Right-drag orbits, scroll zooms.</div>
  `;
  infoRoot.innerHTML = `<b>sigils</b><br /><span id="stats">—</span>`;

  const statsEl = infoRoot.querySelector('#stats');
  const controlsRoot = panelRoot.querySelector('#controls');
  const sigilMaterial = createChromeMaterial(chromeOptionsFromState(state));

  mountControlPanel(controlsRoot, DEMO_CONTROL_SPECS, state, {
    onChange: (key) => {
      if (key === 'guides') refreshGuides();
      refreshPreview();
      scheduleRebuild();
    },
    onLive: () => updateChromeMaterial(sigilMaterial, chromeOptionsFromState(state)),
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

  const strokes = [];
  let current = [];
  let rebuildVersion = 0;
  let rebuildTimer = 0;
  let vertexCount = 0;
  let lastError = '';
  let blendBackend = '—';
  let drawing = false;
  let activePointer = null;
  let orbiting = false;
  let orbitPointer = null;
  let orbitX = 0;
  let orbitY = 0;
  const orbitOffset = new THREE.Vector3();
  const orbitSpherical = new THREE.Spherical();

  const ui = {
    undo: panelRoot.querySelector('#undo'),
    clear: panelRoot.querySelector('#clear'),
  };

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

  function refreshPreview() {
    if (!drawing || current.length < 2) {
      previewMesh.visible = false;
      const old = previewMesh.geometry;
      previewMesh.geometry = new THREE.BufferGeometry();
      old.dispose();
      const committed = sigilMesh.geometry.getAttribute('position')?.count ?? 0;
      vertexCount = committed;
      return;
    }

    const geometry = buildSparseCurveGeometry([current], sparsePreviewOptionsFromState(state));
    const old = previewMesh.geometry;
    previewMesh.geometry = geometry;
    old.dispose();
    previewMesh.visible = (geometry.getAttribute('position')?.count ?? 0) > 0;
    const committed = sigilMesh.geometry.getAttribute('position')?.count ?? 0;
    vertexCount = committed + (geometry.getAttribute('position')?.count ?? 0);
  }

  async function rebuild() {
    try {
      lastError = '';
      if (strokes.length === 0) {
        const old = sigilMesh.geometry;
        sigilMesh.geometry = new THREE.BufferGeometry();
        old.dispose();
        sigilMesh.visible = false;
        vertexCount = previewMesh.geometry.getAttribute('position')?.count ?? 0;
        blendBackend = '—';
        return;
      }

      const version = ++rebuildVersion;
      const geometry = await buildSigilGeometryAsync(strokes, {
        ...shapeOptionsFromState(state),
        renderer,
        onGpuFallback: (error) => console.warn('sigils: hybrid field fallback', error),
      });

      if (version !== rebuildVersion) {
        geometry.dispose();
        return;
      }

      const committedVerts = geometry.getAttribute('position')?.count ?? 0;
      const previewVerts = previewMesh.geometry.getAttribute('position')?.count ?? 0;
      vertexCount = committedVerts + previewVerts;
      blendBackend = geometry.userData.fieldBackend
        ?? geometry.userData.sigilizeBackend
        ?? geometry.userData.buildBackend
        ?? state.backend;

      const oldGeometry = sigilMesh.geometry;
      sigilMesh.geometry = geometry;
      oldGeometry.dispose();
      sigilMesh.visible = committedVerts > 0;
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
    if (current.length >= 2) strokes.push(current);
    current = [];
    refreshGuides();
    refreshPreview();
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

  ui.undo.addEventListener('click', () => {
    if (drawing) finishStroke();
    strokes.pop();
    refreshGuides();
    rebuild();
  }, { signal });
  ui.clear.addEventListener('click', () => {
    if (drawing) finishStroke();
    strokes.length = 0;
    current = [];
    refreshGuides();
    refreshPreview();
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
    refreshPreview();
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
    ctx.setAnimationLoop(null);
  };
}
