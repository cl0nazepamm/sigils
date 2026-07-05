/**
 * Paint-on-Mesh mode: drop a GLB onto the canvas (or use the built-in torus
 * knot), left-drag to paint strokes on its surface, release to grow the
 * surface-native sigil (buildSurfaceSigilGeometry). Right-drag orbits.
 *
 * Strokes live in the target's LOCAL space so the emblem follows the mesh.
 * Displacement is baked into positions, so a plain metal material shades it.
 */

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildSurfaceSigilGeometry } from '../../src/index.js';
import { bindRightDragOrbit } from '../shared/orbit.js';

export const meta = { id: 'surface', label: 'Paint on Mesh' };

export function mount(ctx, { panelRoot, infoRoot, state }) {
  const { THREE, renderer, scene, controls } = ctx;
  const abort = new AbortController();
  const { signal } = abort;
  const raycaster = new THREE.Raycaster();

  ctx.clearScene();

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
  renderer.domElement.style.cursor = 'crosshair';

  // --- target mesh (replaceable by GLB drop) ---
  // dark matte target so the chrome sigil reads against it
  const targetMaterial = new THREE.MeshStandardMaterial({
    color: 0x232328, metalness: 0.1, roughness: 0.85,
  });
  let target = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.7, 0.28, 256, 48), targetMaterial,
  );
  scene.add(target);

  // metal needs punctual highlights on top of the env or it reads black
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
  keyLight.position.set(2, 3, 4);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x8899ff, 0.8);
  fillLight.position.set(-3, -1, 2);
  scene.add(fillLight);

  const sigilMaterial = new THREE.MeshStandardMaterial({
    metalness: 1, roughness: 0.12,
    envMapIntensity: 2,
  });
  // The mesh is (re)created per rebuild: rendering it once with an empty
  // geometry bakes a dead pipeline into the WebGPU renderer cache, so it
  // only joins the scene when real geometry exists — with a fresh material.
  let sigilMesh = null;

  const strokes = [];           // committed strokes, target-local space
  let active = null;            // stroke being painted
  let previewLine = null;

  const local = { thickness: 0.18, falloff: 0.4, peak: 0.08, sigilize: 12 };

  function clearSigil() {
    if (!sigilMesh) return;
    scene.remove(sigilMesh);
    sigilMesh.geometry.dispose();
    sigilMesh.material.dispose();
    sigilMesh = null;
  }

  function rebuild() {
    const all = active ? [...strokes, active] : strokes;
    clearSigil();
    let verts = 0;
    if (all.length) {
      const geo = buildSurfaceSigilGeometry(target.geometry, all, {
        thickness: local.thickness,
        edgeFalloff: local.thickness * local.falloff,
        relief: state.relief ?? 'carve',
        reliefRange: state.reliefRange ?? 6,
        peakHeight: local.peak,
        sigilize: local.sigilize,
        heightSmooth: state.heightSmooth ?? 2,
      });
      verts = geo.getAttribute('position')?.count ?? 0;
      if (verts > 0) {
        sigilMesh = new THREE.Mesh(geo, sigilMaterial.clone());
        sigilMesh.position.copy(target.position);
        sigilMesh.quaternion.copy(target.quaternion);
        sigilMesh.scale.copy(target.scale);
        scene.add(sigilMesh);
      } else {
        geo.dispose();
      }
    }
    infoRoot.textContent = `${all.length} stroke(s) · ${verts} verts`;
  }

  function surfaceHit(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(target, false)[0];
    return hit ? target.worldToLocal(hit.point.clone()) : null;
  }

  function refreshPreview() {
    if (previewLine) { scene.remove(previewLine); previewLine.geometry.dispose(); previewLine = null; }
    if (!active || active.length < 2) return;
    const geo = new THREE.BufferGeometry().setFromPoints(
      active.map((p) => target.localToWorld(new THREE.Vector3(...p))),
    );
    previewLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff }));
    scene.add(previewLine);
  }

  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const p = surfaceHit(event);
    if (!p) return;
    active = [[p.x, p.y, p.z]];
    try {
      renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      // Some event sources do not create a capturable pointer.
    }
  }, { signal });

  renderer.domElement.addEventListener('pointermove', (event) => {
    if (!active) return;
    const p = surfaceHit(event);
    if (!p) return;
    const last = active[active.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1], p.z - last[2]) < local.thickness * 0.25) return;
    active.push([p.x, p.y, p.z]);
    refreshPreview();
  }, { signal });

  addEventListener('pointerup', () => {
    if (!active) return;
    if (active.length >= 2) strokes.push(active);
    active = null;
    refreshPreview();
    rebuild();
  }, { signal });

  // --- GLB drag & drop replaces the target ---
  renderer.domElement.addEventListener('dragover', (e) => e.preventDefault(), { signal });
  renderer.domElement.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    new GLTFLoader().parse(buffer, '', (gltf) => {
      let found = null;
      gltf.scene.traverse((o) => { if (!found && o.isMesh) found = o; });
      if (!found) return;
      let geo = found.geometry;
      if (!geo.getIndex()) geo = BufferGeometryUtils.mergeVertices(geo);
      if (!geo.getAttribute('normal')) geo.computeVertexNormals();
      // normalize to unit-ish size at the origin
      geo.computeBoundingSphere();
      const s = 1 / (geo.boundingSphere.radius || 1);
      scene.remove(target);
      target.geometry.dispose();
      target = new THREE.Mesh(geo, targetMaterial);
      target.scale.setScalar(s);
      scene.add(target);
      strokes.length = 0;
      rebuild();
    }, (err) => console.warn('GLB parse failed', err));
  }, { signal });

  bindRightDragOrbit(ctx, { signal, getCamera: () => camera });

  // --- minimal panel ---
  panelRoot.innerHTML = `
    <div class="section">PAINT ON MESH</div>
    <p style="font-size:11px;opacity:.7">Left-drag paints on the surface. Right-drag orbits.
    Drop a .glb on the canvas to replace the target.</p>`;
  const addSlider = (label, key, min, max, step) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:11px';
    row.innerHTML = `<span style="width:70px">${label}</span>`;
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min, max, step, value: local[key] });
    input.addEventListener('input', () => { local[key] = Number(input.value); rebuild(); }, { signal });
    row.appendChild(input);
    panelRoot.appendChild(row);
  };
  addSlider('Width', 'thickness', 0.02, 0.4, 0.005);
  addSlider('Falloff', 'falloff', 0.1, 1, 0.01);
  addSlider('Peak', 'peak', 0, 0.2, 0.002);
  addSlider('Melt', 'sigilize', 0, 40, 1);
  const clear = document.createElement('button');
  clear.textContent = 'CLEAR';
  clear.addEventListener('click', () => { strokes.length = 0; rebuild(); }, { signal });
  panelRoot.appendChild(clear);

  ctx.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
  rebuild();

  return () => {
    abort.abort();
    ctx.setAnimationLoop(null);
    if (previewLine) { scene.remove(previewLine); previewLine.geometry.dispose(); }
    clearSigil();
    sigilMaterial.dispose();
    target.geometry.dispose();
    targetMaterial.dispose();
    ctx.clearScene();
  };
}
