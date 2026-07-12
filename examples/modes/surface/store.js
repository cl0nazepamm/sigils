/**
 * Paint-on-Mesh persistence: settings, stroke authority, optional dense target.
 */

import { BufferAttribute, BufferGeometry } from 'three';
import { loadDemoAsset } from '../../shared/demoPersistence.js';
import { cleanSurfaceStrokeRecords } from '../../shared/surfaceStrokeSession.js';

export const SURFACE_DEFAULTS = {
  drawTool: 'freehand',
  cvRadiusScale: 1,
  showActiveCvs: true,
  guides: true,     // centerline overlays for selection / active stroke
  surfaceBackend: 'welded',
  manualMeshing: false, // separate per-stroke meshes until explicitly merged
  width: 0.06,      // lateral half-width, world units
  peak: 0.9,        // section height as a RATIO of width
  // Pull the whole band into the mesh along −normal (fraction of peak / patch height).
  // Lets seating depth be dialed without raising peak just to bury the underside.
  conform: 0,
  relief: 'round',  // section shape: carve (peaked) | plateau | round
  thorns: 0,        // 0 = bare vine, 1 = bristling
  spike: 1,         // thorn length in ornament units
  wobble: 0.6,
  melt: 0.39,       // molten field feel: weld gooeyness + section rounding
  taper: 8,         // tip taper length in ornament units (field-length tips)
  taperPower: 1.04, // tip profile exponent, field default: flowing tapers
  res: 0.75,        // field resolution multiplier
  flow: 3,          // smoothing passes on the painted line
  mirror: false,    // captured per stroke with symmetry (like Drawing)
  symmetry: 1,      // N-fold radial copies around the target center, per stroke
  rough: 0,         // vine chrome roughness (0 = mirror)
  color: '#ffffff', // vine chrome tint
  metalness: 1,
  patchRelief: 'round',
  patchHeight: 0.08,   // absolute world-unit displacement, independent of width
  patchFalloff: 0.4,   // fraction of the full stroke width
  patchMelt: 12,       // seam-safe scalar relief smoothing
  patchResolution: 0.5, // 0.5 preserves authored topology; higher values refine the field
  patchTaper: 4,       // open-end taper length in half-width units
  patchTaperPower: 1.15,
  patchPolish: 10,     // shading-normal diffusion; positions stay untouched
  targetColor: '#232328',
  targetMetalness: 0.1,
  targetRoughness: 0.85,
  targetEnvIntensity: 1,
};

export const TARGET_ASSET_KEY = 'paint-on-mesh-target-v1';

function finiteTuple(value, size) {
  return Array.isArray(value)
    && value.length === size
    && value.every(Number.isFinite)
    ? value.slice()
    : null;
}

export function cleanSettings(value) {
  const settings = {};
  for (const [key, fallback] of Object.entries(SURFACE_DEFAULTS)) {
    const saved = value?.[key];
    settings[key] = typeof saved === typeof fallback
      && (typeof saved !== 'number' || Number.isFinite(saved))
      ? saved
      : fallback;
  }
  return settings;
}

function snapshotAttribute(attribute) {
  if (!attribute) return null;
  if (!ArrayBuffer.isView(attribute.array)) {
    const SourceArray = attribute.data?.array?.constructor ?? Float32Array;
    const array = new SourceArray(attribute.count * attribute.itemSize);
    const getters = ['getX', 'getY', 'getZ', 'getW'];
    if (attribute.itemSize > getters.length) return null;
    for (let i = 0; i < attribute.count; i++) {
      for (let component = 0; component < attribute.itemSize; component++) {
        array[i * attribute.itemSize + component] = attribute[getters[component]](i);
      }
    }
    return { array, itemSize: attribute.itemSize, normalized: attribute.normalized };
  }
  return {
    array: attribute.array.slice(),
    itemSize: attribute.itemSize,
    normalized: attribute.normalized,
  };
}

export function snapshotTargetGeometry(geometry) {
  return {
    position: snapshotAttribute(geometry.getAttribute('position')),
    normal: snapshotAttribute(geometry.getAttribute('normal')),
    index: snapshotAttribute(geometry.getIndex()),
  };
}

export function restoreTargetGeometry(snapshot) {
  if (!snapshot?.position || !ArrayBuffer.isView(snapshot.position.array)) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(
    snapshot.position.array, snapshot.position.itemSize, snapshot.position.normalized,
  ));
  if (snapshot.normal && ArrayBuffer.isView(snapshot.normal.array)) {
    geometry.setAttribute('normal', new BufferAttribute(
      snapshot.normal.array, snapshot.normal.itemSize, snapshot.normal.normalized,
    ));
  } else {
    geometry.computeVertexNormals();
  }
  if (snapshot.index && ArrayBuffer.isView(snapshot.index.array)) {
    geometry.setIndex(new BufferAttribute(
      snapshot.index.array, snapshot.index.itemSize, snapshot.index.normalized,
    ));
  }
  geometry.computeBoundingSphere();
  return geometry;
}

/** JSON-safe Paint-on-Mesh state; dense target geometry lives in IndexedDB. */
export function serializeStore(store = {}) {
  const serialized = {
    settings: cleanSettings(store.settings),
    committed: cleanSurfaceStrokeRecords(store.committed),
    redo: cleanSurfaceStrokeRecords(store.redo),
  };
  for (const [key, size] of [
    ['targetScale3', 3],
    ['targetQuaternion', 4],
    ['targetPosition', 3],
  ]) {
    const tuple = finiteTuple(store[key], size);
    if (tuple) serialized[key] = tuple;
  }
  if (store.targetAssetKey === TARGET_ASSET_KEY) serialized.targetAssetKey = TARGET_ASSET_KEY;
  return serialized;
}

/** Restore portable state and, when present, the separately stored dense mesh. */
export async function restoreStore(value = {}) {
  const store = serializeStore(value);
  if (store.targetAssetKey === TARGET_ASSET_KEY) {
    try {
      const snapshot = await loadDemoAsset(TARGET_ASSET_KEY);
      store.targetGeometry = restoreTargetGeometry(snapshot);
      if (!store.targetGeometry) delete store.targetAssetKey;
    } catch (error) {
      console.warn('Paint-on-Mesh target restore failed', error);
      delete store.targetAssetKey;
    }
  }
  return store;
}
