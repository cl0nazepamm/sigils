/**
 * Right-drag orbit shared by the drawing modes. Left button stays free for
 * drawing/editing; OrbitControls only keeps middle-button pan, so this adds a
 * manual spherical orbit on the right button with pointer capture.
 *
 * A right press that never leaves a small slop fires optional `onClick` instead
 * of orbiting, so modes can use right-click for CV delete without losing drag-orbit.
 */
export function bindRightDragOrbit(ctx, {
  signal,
  getCamera,
  cursor = 'crosshair',
  onClick = null,
  clickSlopPx = 5,
} = {}) {
  const { THREE, renderer, controls } = ctx;
  const offset = new THREE.Vector3();
  const spherical = new THREE.Spherical();
  let orbiting = false;
  let pointer = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let moved = false;

  function rotateView(dx, dy) {
    const camera = getCamera();
    const rotateSpeed = 0.006;
    offset.copy(camera.position).sub(controls.target);
    spherical.setFromVector3(offset);
    spherical.theta -= dx * rotateSpeed;
    spherical.phi -= dy * rotateSpeed;
    spherical.makeSafe();
    offset.setFromSpherical(spherical);
    camera.position.copy(controls.target).add(offset);
    camera.lookAt(controls.target);
    controls.update();
  }

  function begin(event) {
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    orbiting = true;
    moved = false;
    pointer = event.pointerId;
    x = event.clientX;
    y = event.clientY;
    startX = event.clientX;
    startY = event.clientY;
    try {
      renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      // Some event sources do not create a capturable pointer.
    }
    renderer.domElement.style.cursor = 'grabbing';
  }

  function move(event) {
    if (!orbiting || event.pointerId !== pointer) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!moved) {
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if ((dx * dx) + (dy * dy) <= clickSlopPx * clickSlopPx) return;
      moved = true;
    }
    rotateView(event.clientX - x, event.clientY - y);
    x = event.clientX;
    y = event.clientY;
  }

  function end(event) {
    if (!orbiting || event.pointerId !== pointer) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Capture may already be gone after browser-level cancellation.
    }
    const wasClick = !moved;
    orbiting = false;
    pointer = null;
    renderer.domElement.style.cursor = cursor;
    if (wasClick) onClick?.(event);
  }

  renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });
  renderer.domElement.addEventListener('pointerdown', begin, { capture: true, signal });
  renderer.domElement.addEventListener('pointermove', move, { capture: true, signal });
  renderer.domElement.addEventListener('pointerup', end, { capture: true, signal });
  renderer.domElement.addEventListener('pointercancel', end, { capture: true, signal });

  return { isOrbiting: () => orbiting };
}
