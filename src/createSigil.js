/**
 * High-level convenience: strokes in, chrome `THREE.Mesh` out.
 *
 * Shape options (symmetry, thickness, resolution, base...) rebuild the geometry.
 * Look options (peakHeight, roughness, color...) feed the TSL material and can
 * be changed live via `mesh.userData.sigil.uniforms` without a rebuild.
 */

import { Mesh } from 'three';
import { buildSigilGeometry, buildSigilGeometryAsync } from './buildGeometry.js';
import { createChromeMaterial } from './tsl/chromeMaterial.js';

/**
 * @param {*} paths - one stroke or an array of strokes
 * @param {object} [opts] - merged shape + look options (see buildGeometry / chromeMaterial)
 * @returns {Mesh}
 */
export function createSigil(paths, opts = {}) {
  const geometry = buildSigilGeometry(paths, opts);
  const material = createChromeMaterial(opts);
  return createSigilMesh(paths, opts, geometry, material);
}

/**
 * Async convenience constructor. Use this when `opts.fieldBackend` is `'gpu'`
 * or `'hybrid'` so the raw distance-field pass can run as WebGPU compute.
 *
 * @param {*} paths - one stroke or an array of strokes
 * @param {object} [opts] - merged shape + look options
 * @returns {Promise<Mesh>}
 */
export async function createSigilAsync(paths, opts = {}) {
  const geometry = await buildSigilGeometryAsync(paths, opts);
  const material = createChromeMaterial(opts);
  return createSigilMesh(paths, opts, geometry, material);
}

function createSigilMesh(paths, opts, geometry, material) {
  const mesh = new Mesh(geometry, material);
  mesh.name = 'Sigil';

  mesh.userData.sigil = {
    material,
    uniforms: material.sigilUniforms,
    /** Rebuild geometry for new shape options (keeps the same material). */
    rebuild(nextPaths = paths, nextOpts = opts) {
      const next = buildSigilGeometry(nextPaths, nextOpts);
      mesh.geometry.dispose();
      mesh.geometry = next;
      return mesh;
    },
    async rebuildAsync(nextPaths = paths, nextOpts = opts) {
      const next = await buildSigilGeometryAsync(nextPaths, nextOpts);
      mesh.geometry.dispose();
      mesh.geometry = next;
      return mesh;
    },
  };

  return mesh;
}
