/**
 * Save a transparent PNG of the current view (raster or path-traced).
 *
 * Beauty is captured as shown, then a white coverage pass of the same camera
 * supplies the matte so void / background pixels export clear — including
 * path tracing, whose blit always writes opaque alpha.
 */

function makeButtonLabeler(button, signal) {
  let timer = 0;
  const idleLabel = button.textContent;
  signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return function setLabel(text, delay = 0) {
    clearTimeout(timer);
    button.textContent = text;
    if (delay > 0) {
      timer = setTimeout(() => {
        button.textContent = idleLabel;
      }, delay);
    }
  };
}

function makeFilename() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `sigil-${stamp}.png`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function canvasImageData(source) {
  const w = source.width;
  const h = source.height;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  return { off, ctx, data: ctx.getImageData(0, 0, w, h) };
}

function renderCoverage(renderer, scene, camera, THREE) {
  const cover = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const prevOverride = scene.overrideMaterial;
  const prevAutoClear = renderer.autoClear;
  const prevBg = scene.background;
  scene.background = null;
  scene.overrideMaterial = cover;
  renderer.autoClear = true;
  renderer.setClearColor?.(0x000000, 0);
  renderer.setClearAlpha?.(0);
  renderer.render(scene, camera);
  scene.overrideMaterial = prevOverride;
  scene.background = prevBg;
  renderer.autoClear = prevAutoClear;
  cover.dispose();
}

/**
 * @param {HTMLButtonElement} button
 * @param {object} opts
 * @param {AbortSignal} [opts.signal]
 * @param {() => ({
 *   renderer: object,
 *   scene: object,
 *   camera: object,
 *   THREE: object,
 * })} opts.getView
 * @param {() => (() => void)} opts.prepareCapture
 *   Hide editor chrome / grid; return a restore callback.
 * @param {() => void} opts.drawBeauty
 *   Draw the beauty frame into the renderer canvas (raster or PT present).
 */
export function bindSaveImageButton(button, {
  signal,
  getView,
  prepareCapture,
  drawBeauty,
}) {
  const setLabel = makeButtonLabeler(button, signal);

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    setLabel('Saving…');
    let restore = null;
    try {
      const view = getView();
      if (!view?.renderer || !view?.scene || !view?.camera || !view?.THREE) {
        setLabel('Nothing to save', 1200);
        return;
      }
      const { renderer, scene, camera, THREE } = view;
      restore = prepareCapture?.() ?? (() => {});

      const prevBg = scene.background;
      const prevClearAlpha = renderer.getClearAlpha?.() ?? 0;
      scene.background = null;
      renderer.setClearColor?.(0x000000, 0);
      renderer.setClearAlpha?.(0);

      drawBeauty();
      const beauty = canvasImageData(renderer.domElement);

      renderCoverage(renderer, scene, camera, THREE);
      const cover = canvasImageData(renderer.domElement);
      const out = beauty.data;
      const mask = cover.data.data;
      for (let i = 0; i < out.data.length; i += 4) {
        if (mask[i] < 8) {
          out.data[i] = 0;
          out.data[i + 1] = 0;
          out.data[i + 2] = 0;
          out.data[i + 3] = 0;
        } else {
          out.data[i + 3] = 255;
        }
      }
      beauty.ctx.putImageData(out, 0, 0);
      const blob = await new Promise((resolve) => beauty.off.toBlob(resolve, 'image/png'));

      // Restore the on-screen beauty after the coverage pass overwrote it.
      scene.background = prevBg;
      renderer.setClearAlpha?.(prevClearAlpha);
      restore?.();
      restore = null;
      drawBeauty();

      if (!blob) throw new Error('PNG encode failed');
      downloadBlob(blob, makeFilename());
      setLabel('Saved', 1200);
    } catch (error) {
      console.error('PNG save failed', error);
      setLabel('Save failed', 1600);
      try { restore?.(); } catch { /* ignore */ }
    } finally {
      button.disabled = false;
    }
  }, { signal });
}
