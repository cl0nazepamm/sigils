/**
 * High-level convenience: strokes in, chrome `THREE.Mesh` out.
 *
 * Shape options (symmetry, thickness, resolution, base...) rebuild the geometry.
 * Look options (peakHeight, roughness, color...) feed the TSL material and can
 * be changed live via `mesh.userData.sigil.uniforms` without a rebuild.
 */

import { Mesh } from 'three';
import { buildSigilGeometry } from './buildGeometry.js';
import { createChromeMaterial } from './tsl/chromeMaterial.js';

/**
 * @param {*} paths - one stroke or an array of strokes
 * @param {object} [opts] - merged shape + look options (see buildGeometry / chromeMaterial)
 * @returns {Mesh}
 */
export function createSigil(paths, opts = {}) {
  const geometry = buildSigilGeometry(paths, opts);
  const material = createChromeMaterial(opts);
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
  };

  return mesh;
}
