import {
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
} from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import {
  buildSigilGeometryAsync,
  chromeOptionsFromState,
} from '../../src/index.js';
import {
  buildOptionsForSession,
  committedBuildPaths,
} from './strokeSession.js';

const EXPORTER = new GLTFExporter();

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

export function bindGlbExportButton(button, { strokes, state, renderer, signal }) {
  const setLabel = makeButtonLabeler(button, signal);

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    if (strokes.length === 0) {
      setLabel('No strokes', 1200);
      return;
    }

    button.disabled = true;
    setLabel('Exporting...');
    try {
      const glb = await buildCommittedGlb(strokes, state, renderer);
      downloadGlb(glb, makeFilename());
      setLabel('Saved', 1200);
    } catch (error) {
      console.error('GLB export failed', error);
      setLabel('Export failed', 1600);
    } finally {
      button.disabled = false;
    }
  }, { signal });
}

/**
 * Export button for modes whose result is already a plain mesh (e.g. the
 * paint-on-mesh vines). `getMesh` returns the object to export or null when
 * there is nothing yet.
 */
export function bindMeshGlbExportButton(button, { getMesh, signal }) {
  const setLabel = makeButtonLabeler(button, signal);

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    const mesh = getMesh();
    if (!mesh) {
      setLabel('No strokes', 1200);
      return;
    }

    button.disabled = true;
    setLabel('Exporting...');
    try {
      const glb = await EXPORTER.parseAsync(mesh, { binary: true, onlyVisible: false });
      downloadGlb(glb, makeFilename());
      setLabel('Saved', 1200);
    } catch (error) {
      console.error('GLB export failed', error);
      setLabel('Export failed', 1600);
    } finally {
      button.disabled = false;
    }
  }, { signal });
}

export async function buildCommittedGlb(strokes, state, renderer) {
  const paths = committedBuildPaths(strokes);
  if (paths.length === 0) throw new Error('No committed strokes to export.');

  const geometry = await buildSigilGeometryAsync(paths, {
    ...buildOptionsForSession(state),
    renderer,
    onGpuFallback: (error) => console.warn('sigils: export field fallback', error),
  });
  const chrome = chromeOptionsFromState(state);
  bakeChromeGeometryForGlb(geometry, chrome);

  const material = new MeshStandardMaterial({
    color: chrome.color,
    metalness: chrome.metalness ?? 1,
    roughness: chrome.roughness ?? 0.05,
    side: DoubleSide,
  });
  material.name = 'polished-metal';

  const mesh = new Mesh(geometry, material);
  mesh.name = 'sigil';
  mesh.frustumCulled = false;

  const result = await EXPORTER.parseAsync(mesh, {
    binary: true,
    onlyVisible: false,
  });

  geometry.dispose();
  material.dispose();
  return result;
}

export function bakeChromeGeometryForGlb(geometry, opts = {}) {
  const position = geometry.getAttribute('position');
  if (!position) return geometry;

  const depth = geometry.getAttribute('aDepth');
  const grad = geometry.getAttribute('aGrad');
  const dome = geometry.getAttribute('aDome');
  const baseNormal = geometry.getAttribute('aNormal');
  const normal = new Float32Array(position.count * 3);
  const peak = opts.peakHeight ?? 0.4;
  const roundProfile = opts.profile === 'round';

  for (let i = 0; i < position.count; i++) {
    const d = clamp01(depth?.getX(i) ?? 0);
    const m = clamp01(dome?.getX(i) ?? 1);
    const height = peak * profileHeight(d, roundProfile) * m;
    position.setZ(i, position.getZ(i) + height);

    const n = bakedNormal(i, d, m, peak, roundProfile, grad, baseNormal);
    normal[i * 3] = n[0];
    normal[i * 3 + 1] = n[1];
    normal[i * 3 + 2] = n[2];
  }

  position.needsUpdate = true;
  geometry.setAttribute('normal', new Float32BufferAttribute(normal, 3));
  geometry.deleteAttribute('aDepth');
  geometry.deleteAttribute('aGrad');
  geometry.deleteAttribute('aDome');
  geometry.deleteAttribute('aNormal');
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function bakedNormal(i, depth, dome, peak, roundProfile, grad, baseNormal) {
  const bx = baseNormal?.getX(i) ?? 0;
  const by = baseNormal?.getY(i) ?? 0;
  const bz = baseNormal?.getZ(i) ?? 1;
  const s = Math.sqrt(Math.max(depth * (2 - depth), 1e-5));
  const dhdd = roundProfile ? peak * (1 - depth) / s : peak;
  const dx = -(grad?.getX(i) ?? 0) * dhdd;
  const dy = -(grad?.getY(i) ?? 0) * dhdd;
  const domeNormal = normalize(dx, dy, 1);
  return normalize(
    bx * (1 - dome) + domeNormal[0] * dome,
    by * (1 - dome) + domeNormal[1] * dome,
    bz * (1 - dome) + domeNormal[2] * dome,
  );
}

function profileHeight(depth, roundProfile) {
  return roundProfile ? Math.sqrt(Math.max(depth * (2 - depth), 0)) : depth;
}

function normalize(x, y, z) {
  const inv = 1 / (Math.hypot(x, y, z) || 1);
  return [x * inv, y * inv, z * inv];
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function downloadGlb(buffer, filename) {
  const blob = new Blob([buffer], { type: 'model/gltf-binary' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function makeFilename() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `sigil-${stamp}.glb`;
}
