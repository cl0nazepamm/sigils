/**
 * Meshless chrome sigil material (TSL raymarch).
 *
 * This is the meshless counterpart of {@link createChromeMaterial}. Instead of a
 * solidified marching-squares mesh carrying baked `aDepth`/`aGrad` attributes,
 * the surface is found per-pixel by RAYMARCHING the GPU-resident 2D distance
 * field on an identity-transform proxy box, then shaded with the IDENTICAL
 * analytic-normal / PBR-metal contract so the look matches the mesh version:
 *
 *   1. Proxy box. One BoxGeometry authored directly in field/world coordinates
 *      with an identity transform, so object-local == world == field space:
 *      `positionWorld` of a box fragment IS a field-space point and
 *      `cameraPosition` is already in field space (no inverse matrices).
 *
 *   2. Height-field raymarch. base=0 open shell — the surface is the two-sided
 *      height field z = H(x, y) over the implicit region g(x, y) < 0. A fixed
 *      coarse step finds the first sign crossing of (z - H) inside the region;
 *      a short bisection refines the hit. Orbits correctly from above or below.
 *
 *   3. Analytic normal. Same math as chromeMaterial.js: normalize(-dH/dx,
 *      -dH/dy, 1) with dH/d(depth) in closed form and grad(depth) by central
 *      differences of the smoothed field. `transformNormalToView` feeds the
 *      same view-space normal into the standard metal/PMREM shading.
 *
 * The GPU field stays resident: the same StorageBufferAttribute the compute pass
 * wrote is read READ-ONLY in the fragment stage (no getArrayBufferAsync). Only
 * `normalNode` is overridden; everything else (metalness, roughness, env, ACES)
 * is the stock MeshStandardNodeMaterial chrome, byte-for-byte with the mesh path.
 */

import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  Fn,
  Loop,
  If,
  Break,
  uniform,
  float,
  int,
  vec3,
  storage,
  cameraPosition,
  positionWorld,
  cameraViewMatrix,
  cameraNear,
  cameraFar,
  viewZToPerspectiveDepth,
  transformNormalToView,
  floor,
  clamp,
  mix,
  select,
  sqrt,
  max,
  min,
  vec4,
} from 'three/tsl';
import { Color, BackSide, BoxGeometry, Vector2, Vector3 } from 'three';

/** Fixed proxy-box top (world units). Must be >= the `peak` control max (0.45). */
export const PEAK_MAX = 0.5;
/** Coarse march steps across the box interval. */
const STEPS = 96;
/** Bisection iterations refining the first sign crossing. */
const REFINE = 6;
/** Exposed for the demo stats line. */
export const RAYMARCH_STEPS = STEPS;

/**
 * Deterministic proxy-volume AABB in field/world space, recomputed identically
 * by the geometry builder and the material so the box and the march agree.
 * @param {{minX:number,minY:number,cell:number,width:number,height:number}} g
 */
function aabb(g) {
  const p = g.cell;
  const maxX = g.minX + (g.width - 1) * g.cell;
  const maxY = g.minY + (g.height - 1) * g.cell;
  return {
    minX: g.minX - p,
    minY: g.minY - p,
    maxX: maxX + p,
    maxY: maxY + p,
    zBot: -2 * p,
    zTop: PEAK_MAX + 2 * p,
    padZ: 2 * p,
  };
}

/**
 * Build the identity-transform proxy box for a resident field. The box top is
 * fixed at PEAK_MAX so live `peak` drags never rebuild geometry (the march
 * ceiling tracks the live peak uniform inline instead).
 *
 * @param {{grid:{minX:number,minY:number,cell:number,width:number,height:number}}} field
 * @returns {BoxGeometry}
 */
export function buildProxyBoxGeometry(field) {
  const a = aabb(field.grid);
  const geo = new BoxGeometry(a.maxX - a.minX, a.maxY - a.minY, a.zTop - a.zBot);
  geo.translate((a.minX + a.maxX) / 2, (a.minY + a.maxY) / 2, (a.zBot + a.zTop) / 2);
  return geo;
}

/**
 * @param {object} field - descriptor from buildResidentField
 * @param {object} [opts] - chrome options (chromeOptionsFromState shape)
 * @param {number} [opts.peakHeight=0.14]
 * @param {number} [opts.roughness=0.05]
 * @param {number} [opts.metalness=1]
 * @param {THREE.ColorRepresentation} [opts.color=0xffffff]
 * @param {number} [opts.envMapIntensity=1.6]
 * @param {'linear'|'round'} [opts.profile='linear']
 * @returns {MeshStandardNodeMaterial} material with `.sigilUniforms` and `.gridUniforms`
 */
export function createRaymarchSigilMaterial(field, opts = {}) {
  const g = field.grid;
  const a = aabb(g);
  const cap = field.capacity;
  const round = opts.profile === 'round';

  const material = new MeshStandardNodeMaterial();

  // --- GPU-resident field, read READ-ONLY in the fragment stage ---
  const RAW = storage(field.rawAttr, 'vec2', cap).toReadOnly();
  const SM = field.smoothAttr === field.rawAttr
    ? RAW
    : storage(field.smoothAttr, 'vec2', cap).toReadOnly();

  // --- live surface uniforms (peak/roughness) ---
  const uPeak = uniform(opts.peakHeight ?? 0.14);
  const uRough = uniform(opts.roughness ?? 0.05);

  // --- field grid + iso uniforms (updated in place on reused rebuilds) ---
  const uMinX = uniform(g.minX);
  const uMinY = uniform(g.minY);
  const uCell = uniform(g.cell);
  const uW = uniform(g.width);
  const uH = uniform(g.height);
  const uThr = uniform(field.threshold);
  const uFall = uniform(field.boundaryFalloff);
  const uMerge = uniform(field.mergeBlend);
  const uDepthBlend = uniform(field.depthBlend);
  const uBoxMin = uniform(new Vector3(a.minX, a.minY, a.zBot));
  const uBoxMaxXY = uniform(new Vector2(a.maxX, a.maxY));
  const uPadZ = uniform(a.padZ);

  // --- manual bilinear sampler closure over each buffer (mirrors
  //     ReadbackField._bilinear: tx/ty from raw floor, indices edge-clamped).
  //     A storage node is NEVER passed as an Fn arg; the closure captures it. ---
  const makeSampler = (buf) => Fn(([x, y]) => {
    const fx = x.sub(uMinX).div(uCell);
    const fy = y.sub(uMinY).div(uCell);
    const fi = floor(fx);
    const fj = floor(fy);
    const tx = fx.sub(fi);
    const ty = fy.sub(fj);
    const wInt = int(uW);
    const i = int(clamp(fi, float(0), uW.sub(2)));
    const j = int(clamp(fj, float(0), uH.sub(2)));
    const base = j.mul(wInt).add(i).toVar();
    const c00 = buf.element(base);
    const c10 = buf.element(base.add(1));
    const c01 = buf.element(base.add(wInt));
    const c11 = buf.element(base.add(wInt).add(1));
    return mix(mix(c00, c10, tx), mix(c01, c11, tx), ty); // vec2(dist, weight)
  });
  const sampleRaw = makeSampler(RAW);
  const sampleSm = makeSampler(SM);

  // --- depth from the smoothed field, blended with the boundary-distance rim
  //     analogue (mirrors applyBoundaryDepth's depthBlend) ---
  const depthOf = Fn(([sm]) => {
    const w = sm.y;
    const dist = sm.x;
    const fieldD = select(
      w.lessThanEqual(1e-4),
      float(0),
      clamp(float(1).sub(dist.div(uThr.mul(w).max(1e-6))), float(0), float(1)),
    );
    const bD = clamp(uThr.mul(w).sub(dist).div(uFall), float(0), float(1));
    // Match the mesh's applyBoundaryDepth: mix(boundary, field, depthBlend) so
    // boundary dominates at blend=0 and the field at blend=1 (was inverted).
    return mix(bD, fieldD, uDepthBlend);
  });
  const depthAt = Fn(([x, y]) => depthOf(sampleSm(x, y)));

  // --- height profile H(depth); shared s also denominates the round dHdd ---
  const Hd = Fn(([d]) => {
    const s = sqrt(max(d.mul(float(2).sub(d)), float(1e-5)));
    return uPeak.mul(round ? s : d);
  });
  const heightAt = Fn(([x, y]) => Hd(depthAt(x, y)));

  // --- shared raymarch: identity box, sign-crossing height field + bisection.
  //     Returns the world/field-space hit point and discards on a miss. Called
  //     by BOTH normalNode and depthNode so the shaded surface and the depth it
  //     writes are sampled from the SAME marched hit (no box-back-face depth). ---
  const marchHit = Fn(() => {
    const ro = cameraPosition;
    const rd = positionWorld.sub(cameraPosition).normalize();

    // slab/AABB intersection; march ceiling tracks the LIVE peak uniform.
    const bmax = vec3(uBoxMaxXY.x, uBoxMaxXY.y, uPeak.add(uPadZ));
    const inv = vec3(1, 1, 1).div(rd);
    const ta = uBoxMin.sub(ro).mul(inv);
    const tb = bmax.sub(ro).mul(inv);
    const tmn = min(ta, tb);
    const tmx = max(ta, tb);
    const t0 = max(max(tmn.x, max(tmn.y, tmn.z)), float(0)).toVar();
    const t1 = min(tmx.x, min(tmx.y, tmx.z)).toVar();
    t0.greaterThan(t1).discard();

    const dt = t1.sub(t0).div(float(STEPS)).toVar();
    const t = t0.toVar();
    const p0 = ro.add(rd.mul(t0));
    const dPrev = p0.z.sub(heightAt(p0.x, p0.y)).toVar();
    const tHit = float(-1).toVar();
    const tA = t0.toVar();

    Loop(STEPS, () => {
      t.addAssign(dt);
      const p = ro.add(rd.mul(t));
      const sm = sampleSm(p.x, p.y);
      const rw = sampleRaw(p.x, p.y);
      // silhouette implicit: raw-vs-smoothed merge (matches fillRegion g_eff).
      const gEff = mix(rw.x.sub(uThr.mul(rw.y)), sm.x.sub(uThr.mul(sm.y)), uMerge);
      const d = p.z.sub(Hd(depthOf(sm)));
      // accept the first crossing INSIDE the region (g<0); the z=0 flat outside
      // the sigil has H=0 and g>=0, so it never produces a spurious hit.
      If(gEff.lessThan(0).and(d.mul(dPrev).lessThan(0)).and(tHit.lessThan(0)), () => {
        tHit.assign(t);
        tA.assign(t.sub(dt));
        Break();
      });
      dPrev.assign(d);
    });

    tHit.lessThan(0).discard();

    // bisection refine of f(t) = z - H on [tA, tHit], orientation independent.
    const lo = tA.toVar();
    const hi = tHit.toVar();
    const pa = ro.add(rd.mul(lo));
    const fa = pa.z.sub(heightAt(pa.x, pa.y)).toVar();
    Loop(REFINE, () => {
      const tm = lo.add(hi).mul(0.5);
      const pm = ro.add(rd.mul(tm));
      const fm = pm.z.sub(heightAt(pm.x, pm.y));
      If(fm.mul(fa).lessThan(0), () => {
        hi.assign(tm);
      }).Else(() => {
        lo.assign(tm);
        fa.assign(fm);
      });
    });

    return ro.add(rd.mul(lo.add(hi).mul(0.5)));
  });

  // March ONCE per fragment and share the hit between the normal and depth
  // outputs. Both compile into the same fragment shader, so a single .toVar() for
  // the marched hit is emitted once and reused — instead of the two separate
  // marchHit() calls (one per output) the shader ran before, which doubled the
  // 96-step march. Built inline (not wrapped in Fn) so the shared `hp` var lives
  // in the same scope both outputs read from.
  const hp = marchHit().toVar();

  // analytic height-field normal (identical to chromeMaterial.js:58-76).
  const dHit = clamp(depthAt(hp.x, hp.y), float(0), float(1)).toVar();
  const s = sqrt(max(dHit.mul(float(2).sub(dHit)), float(1e-5)));
  const dHdd = round ? uPeak.mul(dHit.oneMinus()).div(s) : uPeak;
  const h = uCell.mul(1.25); // gradient step >= cell to stay as de-noised as the mesh
  const gx = depthAt(hp.x.add(h), hp.y).sub(depthAt(hp.x.sub(h), hp.y)).div(h.mul(2));
  const gy = depthAt(hp.x, hp.y.add(h)).sub(depthAt(hp.x, hp.y.sub(h))).div(h.mul(2));
  const n = vec3(dHdd.mul(gx).negate(), dHdd.mul(gy).negate(), float(1)).normalize();
  // Mesh parity: chromeMaterial does NOT flip the analytic normal on back faces,
  // so we keep +Z too rather than orienting toward the camera.
  material.normalNode = transformNormalToView(n);

  // Marched-hit perspective depth (NOT the proxy box back-face depth) so the sigil
  // composites correctly; identity model matrix means hp is already view-space-transformable.
  material.depthNode = viewZToPerspectiveDepth(cameraViewMatrix.mul(vec4(hp, 1)).z, cameraNear, cameraFar);

  // --- chrome shading (stock MeshStandardNodeMaterial metal vs PMREM) ---
  material.color = new Color(opts.color ?? 0xffffff);
  material.metalness = opts.metalness ?? 1.0;
  material.roughnessNode = uRough;
  material.envMapIntensity = opts.envMapIntensity ?? 1.6;
  material.side = BackSide; // always produce a fragment even if camera dollies inside
  material.flatShading = false;
  material.depthTest = true;
  material.depthWrite = true;
  material.transparent = false;

  material.sigilUniforms = { peakHeight: uPeak, roughness: uRough };
  material.gridUniforms = {
    uMinX, uMinY, uCell, uW, uH,
    uThr, uFall, uMerge, uDepthBlend,
    uBoxMin, uBoxMaxXY, uPadZ,
  };
  return material;
}

/** Live setter for the surface uniforms (peak/roughness), no rebuild. */
export function updateRaymarchSigilMaterial(material, { peakHeight, roughness } = {}) {
  // The meshless mode creates this material LAZILY (null until the first stroke
  // is committed), so guard against a null material from live slider drags.
  if (!material) return;
  const u = material.sigilUniforms;
  if (!u) return;
  if (peakHeight !== undefined) u.peakHeight.value = peakHeight;
  if (roughness !== undefined) u.roughness.value = roughness;
}

/**
 * Push a (reused) resident field's grid + iso scalars into an existing
 * material's uniforms, so a rebuild that kept the same storage buffers does not
 * need to recreate the node graph.
 */
export function updateRaymarchFieldUniforms(material, field) {
  if (!material) return;
  const u = material.gridUniforms;
  if (!u) return;
  const g = field.grid;
  const a = aabb(g);
  u.uMinX.value = g.minX;
  u.uMinY.value = g.minY;
  u.uCell.value = g.cell;
  u.uW.value = g.width;
  u.uH.value = g.height;
  u.uThr.value = field.threshold;
  u.uFall.value = field.boundaryFalloff;
  u.uMerge.value = field.mergeBlend;
  u.uDepthBlend.value = field.depthBlend;
  u.uBoxMin.value.set(a.minX, a.minY, a.zBot);
  u.uBoxMaxXY.value.set(a.maxX, a.maxY);
  u.uPadZ.value = a.padZ;
}
