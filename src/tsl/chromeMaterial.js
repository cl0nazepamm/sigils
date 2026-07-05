/**
 * Chrome sigil material (TSL).
 *
 * All of the per-vertex "core math" runs here as TSL nodes, so the silhouette
 * geometry can be reused while the look stays fully parametric at runtime:
 *
 *   1. Peak displacement. The flat fill carries `aDepth` (0 at the rim, 1 at the
 *      interior). We push the top surface up along +Z. The default profile is
 *      linear boundary depth; `profile: 'round'` uses the older circular
 *      cross-section profile H = peak * sqrt(depth*(2-depth)).
 *
 *   2. Analytic normals. For a height field z = H(x, y) the unit normal is
 *      normalize(-dH/dx, -dH/dy, 1). We have dH/d(depth) in closed form and the
 *      gradient of `depth` baked in `aGrad`, so the chrome reflects smoothly
 *      without finite differences or a normal map.
 *
 *   3. The base + side walls (aDome = 0) keep their flat baked normals.
 *
 * Shading is a metal: metalness 1, low roughness, lit entirely by the scene
 * environment (set `scene.environment` to a PMREM for the mirror finish).
 */

import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  attribute,
  uniform,
  positionLocal,
  vec3,
  float,
  mix,
  transformNormalToView,
} from 'three/tsl';
import { Color, DoubleSide } from 'three';

/**
 * @param {object} [opts]
 * @param {number} [opts.peakHeight=0.4] - height of the bulge (world units)
 * @param {number} [opts.roughness=0.08] - 0 = perfect mirror
 * @param {number} [opts.metalness=1]
 * @param {THREE.ColorRepresentation} [opts.color=0xffffff] - reflectance tint
 * @param {number} [opts.envMapIntensity=1.5]
 * @param {'linear'|'round'} [opts.profile='linear'] - height profile
 * @returns {MeshStandardNodeMaterial} material with `.sigilUniforms` for live tweaks
 */
export function createChromeMaterial(opts = {}) {
  const material = new MeshStandardNodeMaterial();

  const uPeak = uniform(opts.peakHeight ?? 0.4);
  const uRough = uniform(opts.roughness ?? 0.08);

  // --- attributes baked by buildGeometry ---
  // The round profile needs depth in [0,1]; linear passes carve depths > 1
  // through so junction peaks keep their full height.
  const roundProfile = opts.profile === 'round';
  const rawDepth = attribute('aDepth', 'float');
  const depth = roundProfile ? rawDepth.clamp(0, 1) : rawDepth.max(0);
  const grad = attribute('aGrad', 'vec2');
  const dome = attribute('aDome', 'float');
  const baseNormal = attribute('aNormal', 'vec3');

  // --- 1) height profile, applied only on the dome (aDome = 1) ---
  const s = depth.mul(float(2).sub(depth)).max(1e-5).sqrt();
  const heightProfile = roundProfile ? s : depth;
  const height = uPeak.mul(heightProfile).mul(dome);

  material.positionNode = positionLocal.add(vec3(0, 0, height));

  // --- 2) analytic normal of the displaced height field ---
  // Chain dH/d(depth) through grad(depth) for dH/dx and dH/dy.
  const dHdd = roundProfile ? uPeak.mul(depth.oneMinus()).div(s) : uPeak;
  const domeNormal = vec3(
    dHdd.mul(grad.x).negate(),
    dHdd.mul(grad.y).negate(),
    1.0,
  ).normalize();

  // dome surfaces use the analytic normal; base + walls keep their flat normal.
  const finalNormal = mix(baseNormal, domeNormal, dome).normalize();
  material.normalNode = transformNormalToView(finalNormal);

  // --- 3) chrome shading ---
  material.color = new Color(opts.color ?? 0xffffff);
  material.metalness = opts.metalness ?? 1.0;
  material.roughnessNode = uRough;
  material.envMapIntensity = opts.envMapIntensity ?? 1.5;
  material.side = DoubleSide;
  material.flatShading = false;

  material.sigilUniforms = { peakHeight: uPeak, roughness: uRough };
  return material;
}

/** Convenience setter for live material controls. */
export function updateChromeMaterial(material, { peakHeight, roughness, envMapIntensity } = {}) {
  const u = material.sigilUniforms;
  if (!u) return;
  if (peakHeight !== undefined) u.peakHeight.value = peakHeight;
  if (roughness !== undefined) u.roughness.value = roughness;
  if (envMapIntensity !== undefined) {
    material.envMapIntensity = envMapIntensity;
    material.needsUpdate = true;
  }
}
