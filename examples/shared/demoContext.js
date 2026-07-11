import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { color, float, fract, fwidth, normalView, positionGeometry, positionView, positionWorld, smoothstep } from 'three/tsl';

const FORCE_WEBGL_KEY = 'sigils.forceWebGL';

/**
 * Shared renderer + scene shell for the unified sigils demo.
 *
 * Prefers WebGPU; falls back to Three's WebGL2 backend when WebGPU is missing,
 * init/probe fails, the device is lost mid-session, or the user passes
 * `?forceWebGL=1` / `?gl=1`. Field compute stays WebGPU-only — callers should
 * use `computeRenderer` (null on the GL path) and keep `backend: 'cpu'`.
 */
export async function createDemoContext() {
  const cameraHome = new THREE.Vector3(0, -0.85, 3.7);
  const cameraFov = 38;
  const cameraNear = 0.1;
  const cameraFar = 100;
  const orthographicDistance = cameraHome.length();
  const { renderer, renderBackend } = await createRenderer();
  // Only pass this into GPU field / laplacian / meshless paths.
  const computeRenderer = renderBackend === 'webgpu' ? renderer : null;

  // Broken Intel WebGPU often inits, then dies on first real work or later.
  // Reload into forced WebGL once — sessionStorage stops a reload loop.
  if (renderBackend === 'webgpu') {
    renderer.onDeviceLost = (info) => {
      console.error('sigils demo: WebGPU device lost', info);
      if (info?.reason === 'destroyed') return;
      fallBackToForcedWebGL('device-lost');
    };
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const rasterBackdrop = createRasterBackdrop();
  const rasterBackdropHiders = new Set();
  scene.add(rasterBackdrop);

  const perspectiveCamera = new THREE.PerspectiveCamera(cameraFov, window.innerWidth / window.innerHeight, cameraNear, cameraFar);
  const orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, cameraNear, cameraFar);
  let camera = perspectiveCamera;
  perspectiveCamera.up.set(0, 1, 0);
  perspectiveCamera.position.copy(cameraHome);
  orthographicCamera.up.set(0, 1, 0);
  orthographicCamera.position.set(0, 0, orthographicDistance);
  orthographicCamera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.target.set(0, 0, 0);
  // One finger is reserved for drawing/painting in every mode (matching
  // LEFT: null on the mouse map). Flat modes use the drawing-app convention:
  // two fingers pan + pinch-zoom. Paint on Mesh temporarily swaps this to
  // orbit + pinch-zoom and uses the shared three-finger pan below.
  controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_PAN };

  // OrbitControls has no three-finger mapping. Add one small screen-space pan
  // layer so 3D paint mode can keep two-finger orbit without losing pan.
  const panTouches = new Map();
  const panRight = new THREE.Vector3();
  const panUp = new THREE.Vector3();
  const panOffset = new THREE.Vector3();
  let panCentroid = null;

  function touchCentroid() {
    let x = 0, y = 0;
    for (const point of panTouches.values()) { x += point.x; y += point.y; }
    const count = Math.max(1, panTouches.size);
    return { x: x / count, y: y / count };
  }

  function panCameraByPixels(dx, dy) {
    const rect = renderer.domElement.getBoundingClientRect();
    if (!(rect.height > 0)) return;
    camera.updateMatrixWorld();
    panRight.setFromMatrixColumn(camera.matrixWorld, 0);
    panUp.setFromMatrixColumn(camera.matrixWorld, 1);
    const worldPerPixel = camera.isOrthographicCamera
      ? (camera.top - camera.bottom) / Math.max(1e-6, camera.zoom) / rect.height
      : 2 * camera.position.distanceTo(controls.target)
        * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) / rect.height;
    panOffset.copy(panRight).multiplyScalar(-dx * worldPerPixel)
      .addScaledVector(panUp, dy * worldPerPixel);
    camera.position.add(panOffset);
    controls.target.add(panOffset);
    controls.update();
  }

  function trackPanPointerDown(event) {
    if (event.pointerType !== 'touch') return;
    panTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (panTouches.size >= 3) {
      panCentroid = touchCentroid();
      // OrbitControls should never register the third pointer; its first two
      // resume normally after the third lifts.
      event.stopImmediatePropagation();
    }
  }

  function trackPanPointerMove(event) {
    if (event.pointerType !== 'touch' || !panTouches.has(event.pointerId)) return;
    panTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (panTouches.size < 3) { panCentroid = null; return; }
    const next = touchCentroid();
    if (panCentroid) panCameraByPixels(next.x - panCentroid.x, next.y - panCentroid.y);
    panCentroid = next;
    event.stopImmediatePropagation();
  }

  function trackPanPointerEnd(event) {
    if (event.pointerType !== 'touch') return;
    panTouches.delete(event.pointerId);
    panCentroid = panTouches.size >= 3 ? touchCentroid() : null;
  }

  renderer.domElement.addEventListener('pointerdown', trackPanPointerDown, true);
  renderer.domElement.addEventListener('pointermove', trackPanPointerMove, true);
  renderer.domElement.addEventListener('pointerup', trackPanPointerEnd, true);
  renderer.domElement.addEventListener('pointercancel', trackPanPointerEnd, true);

  function syncRasterBackdropVisibility() {
    rasterBackdrop.visible = rasterBackdropHiders.size === 0;
  }

  function updateRasterBackdrop() {
    // Keep the finite carrier centered under the active work area. The grid
    // pattern itself uses world position, so panning never makes it swim.
    rasterBackdrop.position.x = controls.target.x;
    rasterBackdrop.position.y = controls.target.y;
  }

  function updateCameraProjection() {
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    perspectiveCamera.aspect = aspect;
    perspectiveCamera.updateProjectionMatrix();

    const distance = Math.max(0.001, orthographicCamera.position.distanceTo(controls.target));
    const height = 2 * distance * Math.tan(THREE.MathUtils.degToRad(cameraFov * 0.5));
    const width = height * aspect;
    orthographicCamera.left = -width / 2;
    orthographicCamera.right = width / 2;
    orthographicCamera.top = height / 2;
    orthographicCamera.bottom = -height / 2;
    orthographicCamera.updateProjectionMatrix();
  }

  function alignOrthographicCamera() {
    orthographicCamera.up.set(0, 1, 0);
    orthographicCamera.position.set(controls.target.x, controls.target.y, controls.target.z + orthographicDistance);
    orthographicCamera.lookAt(controls.target);
  }

  function setOrthographicView(enabled) {
    const next = enabled ? orthographicCamera : perspectiveCamera;
    if (enabled) alignOrthographicCamera();
    if (next !== camera) camera = next;
    controls.object = camera;
    updateCameraProjection();
    controls.update();
    return camera;
  }

  function setCameraHome() {
    camera.up.set(0, 1, 0);
    if (camera.isOrthographicCamera) {
      alignOrthographicCamera();
    } else {
      camera.position.copy(cameraHome);
      camera.lookAt(controls.target);
    }
    updateCameraProjection();
    controls.update();
    return camera;
  }

  function getActiveCamera() {
    return camera;
  }

  updateCameraProjection();

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  let resizeHandler = null;
  let animationLoop = null;

  function setResizeHandler(fn) {
    resizeHandler = fn;
  }

  function setAnimationLoop(fn) {
    animationLoop = fn;
    renderer.setAnimationLoop(fn ? (...args) => {
      updateRasterBackdrop();
      fn(...args);
    } : null);
  }

  function onResize() {
    updateCameraProjection();
    // Re-read the DPR: the window may have moved to a monitor with a
    // different pixel ratio (or the browser zoom changed) since init.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    resizeHandler?.();
  }

  addEventListener('resize', onResize);

  function clearScene({ includePersistent = false } = {}) {
    for (let i = scene.children.length - 1; i >= 0; i--) {
      const child = scene.children[i];
      if (!includePersistent && child.userData?.demoPersistent) continue;
      scene.remove(child);
      child.traverse?.((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
    }
  }

  function dispose() {
    removeEventListener('resize', onResize);
    renderer.domElement.removeEventListener('pointerdown', trackPanPointerDown, true);
    renderer.domElement.removeEventListener('pointermove', trackPanPointerMove, true);
    renderer.domElement.removeEventListener('pointerup', trackPanPointerEnd, true);
    renderer.domElement.removeEventListener('pointercancel', trackPanPointerEnd, true);
    renderer.setAnimationLoop(null);
    clearScene({ includePersistent: true });
    pmrem.dispose();
    scene.environment?.dispose?.();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return {
    THREE,
    renderer,
    computeRenderer,
    renderBackend,
    scene,
    get camera() {
      return camera;
    },
    controls,
    pmrem,
    getActiveCamera,
    setCameraHome,
    setOrthographicView,
    updateCameraProjection,
    setRasterBackdropHidden(owner, hidden) {
      if (hidden) rasterBackdropHiders.add(owner);
      else rasterBackdropHiders.delete(owner);
      syncRasterBackdropVisibility();
    },
    clearScene,
    setResizeHandler,
    setAnimationLoop,
    dispose,
  };
}

function createRasterBackdrop() {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true });
  const subdivisions = gridLine(0.2, 0.0015).mul(0.03);
  const major = gridLine(1, 0.006).mul(0.1);
  const intersections = gridDot(1, 0.009).mul(0.72);
  const axes = axisLine(positionWorld.x, 0.008)
    .max(axisLine(positionWorld.y, 0.008))
    .mul(0.22);

  // Fade by view-space Z so grid lines receding from the camera dissolve into
  // black, then guarantee the finite carrier is invisible before its boundary.
  const depthFade = smoothstep(float(32), float(8), positionView.z.abs());
  const angleFade = smoothstep(float(0.08), float(0.35), normalView.z.abs());
  const edgeDistance = positionGeometry.x.abs().max(positionGeometry.y.abs());
  const edgeFade = smoothstep(float(72), float(42), edgeDistance);

  material.colorNode = color(0x888888);
  material.opacityNode = subdivisions.max(major).max(intersections).max(axes)
    .mul(depthFade).mul(angleFade).mul(edgeFade);
  material.depthTest = true;
  material.depthWrite = false;
  material.toneMapped = false;
  material.side = THREE.DoubleSide;
  material.forceSinglePass = true;

  const grid = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), material);
  grid.name = 'raster-reference-grid';
  grid.position.z = -0.6;
  grid.renderOrder = -1000;
  grid.frustumCulled = false;
  grid.raycast = () => {};
  grid.userData.demoPersistent = true;
  grid.userData.pathTraceExclude = true;
  return grid;
}

function gridLine(period, halfWidth) {
  const coord = positionWorld.xy.div(period);
  const distance = float(0.5).sub(fract(coord).sub(0.5).abs());
  const aa = fwidth(coord).max(0.0001);
  const width = float(halfWidth / period);
  const line = smoothstep(width.add(aa), width.sub(aa), distance);
  return line.x.max(line.y);
}

function gridDot(period, radius) {
  const coord = positionWorld.xy.div(period);
  const center = fract(coord.add(0.5)).sub(0.5);
  const distance = center.length().mul(period);
  const aa = fwidth(positionWorld.xy).length().max(0.0001);
  return smoothstep(float(radius).add(aa), float(radius).sub(aa), distance);
}

function axisLine(coord, halfWidth) {
  const aa = fwidth(coord).max(0.0001);
  return smoothstep(float(halfWidth).add(aa), float(halfWidth).sub(aa), coord.abs());
}

function wantsForceWebGL() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('forceWebGL') || q.get('gl') === '1') return true;
  } catch {
    /* ignore */
  }
  try {
    return sessionStorage.getItem(FORCE_WEBGL_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberForceWebGL() {
  try {
    sessionStorage.setItem(FORCE_WEBGL_KEY, '1');
  } catch {
    /* ignore */
  }
}

/** Persist + hard-reload into WebGL2. Safe to call from device-lost callbacks. */
function fallBackToForcedWebGL(reason) {
  if (wantsForceWebGL()) return; // already on / requesting GL — don't loop
  rememberForceWebGL();
  console.warn(`sigils demo: falling back to WebGL2 (${reason}). Reloading…`);
  try {
    const url = new URL(location.href);
    url.searchParams.set('forceWebGL', '1');
    location.replace(url.toString());
  } catch {
    location.reload();
  }
}

async function createRenderer() {
  const forceWebGL = wantsForceWebGL();
  if (!forceWebGL) {
    let renderer = null;
    try {
      renderer = await initRenderer({ forceWebGL: false });
      if (renderer.backend?.isWebGLBackend === true) {
        console.warn('sigils demo: WebGPU unavailable, using WebGL2 backend.');
        rememberForceWebGL();
        return { renderer, renderBackend: 'webgl' };
      }
      // Init succeeded — poke a real frame. Some Intel stacks only fail here.
      if (!(await probeRenderer(renderer))) {
        console.warn('sigils demo: WebGPU probe render failed, retrying with WebGL2.');
        disposeRenderer(renderer);
        rememberForceWebGL();
      } else {
        return { renderer, renderBackend: 'webgpu' };
      }
    } catch (error) {
      console.warn('sigils demo: WebGPU init failed, retrying with WebGL2.', error);
      disposeRenderer(renderer);
      try {
        document.getElementById('stage')?.remove();
      } catch {
        /* ignore */
      }
      rememberForceWebGL();
    }
  } else {
    console.info('sigils demo: forceWebGL — using WebGL2 backend.');
  }

  const renderer = await initRenderer({ forceWebGL: true });
  return { renderer, renderBackend: 'webgl' };
}

async function probeRenderer(renderer) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
  camera.position.z = 2;
  try {
    if (typeof renderer.renderAsync === 'function') await renderer.renderAsync(scene, camera);
    else renderer.render(scene, camera);
    return !renderer._isDeviceLost;
  } catch (error) {
    console.warn('sigils demo: probe render error', error);
    return false;
  }
}

function disposeRenderer(renderer) {
  if (!renderer) return;
  try {
    renderer.setAnimationLoop?.(null);
    renderer.dispose?.();
  } catch {
    /* ignore */
  }
  try {
    renderer.domElement?.remove?.();
  } catch {
    /* ignore */
  }
}

async function initRenderer({ forceWebGL }) {
  const renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true, forceWebGL });
  renderer.setClearAlpha?.(0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.domElement.id = 'stage';
  renderer.domElement.style.touchAction = 'none';
  document.body.appendChild(renderer.domElement);
  await renderer.init();
  return renderer;
}

export function createDrawPlane(camera) {
  const raycaster = new THREE.Raycaster();
  const drawPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const ndc = new THREE.Vector2();
  const hit = new THREE.Vector3();

  function planePoint(event) {
    ndc.x = (event.clientX / window.innerWidth) * 2 - 1;
    ndc.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(ndc, typeof camera === 'function' ? camera() : camera);
    if (!raycaster.ray.intersectPlane(drawPlane, hit)) return null;
    return [hit.x, hit.y];
  }

  return { planePoint };
}
