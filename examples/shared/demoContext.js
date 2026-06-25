import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * Shared WebGPU renderer + scene shell for the unified sigils demo.
 */
export async function createDemoContext() {
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.domElement.id = 'stage';
  renderer.domElement.style.touchAction = 'none';
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0b0d);

  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.up.set(0, 1, 0);
  camera.position.set(0, -0.85, 3.7);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  let resizeHandler = null;
  let animationLoop = null;

  function setResizeHandler(fn) {
    resizeHandler = fn;
  }

  function setAnimationLoop(fn) {
    animationLoop = fn;
    renderer.setAnimationLoop(fn);
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    resizeHandler?.();
  }

  addEventListener('resize', onResize);

  function clearScene() {
    for (let i = scene.children.length - 1; i >= 0; i--) {
      const child = scene.children[i];
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
    renderer.setAnimationLoop(null);
    clearScene();
    pmrem.dispose();
    scene.environment?.dispose?.();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return {
    THREE,
    renderer,
    scene,
    camera,
    controls,
    pmrem,
    clearScene,
    setResizeHandler,
    setAnimationLoop,
    dispose,
  };
}

export function createDrawPlane(camera) {
  const raycaster = new THREE.Raycaster();
  const drawPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const ndc = new THREE.Vector2();
  const hit = new THREE.Vector3();

  function planePoint(event) {
    ndc.x = (event.clientX / window.innerWidth) * 2 - 1;
    ndc.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(drawPlane, hit)) return null;
    return [hit.x, hit.y];
  }

  return { planePoint };
}
