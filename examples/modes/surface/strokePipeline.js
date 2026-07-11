/**
 * Paint-on-Mesh conform + field option builders.
 *
 * Takes mount-time deps so the algorithms stay free of panel/event wiring.
 */

import {
  buildSurfaceSigilGeometry,
  buildSurfaceVineFieldGeometry,
} from '../../../src/index.js';
import { clampCvRadiusScale } from '../../shared/strokeSession.js';
import {
  captureSurfaceDrawSettings,
  isSurfaceSplineRecord,
  sampleSurfaceSpline,
  surfaceStrokeCopyCount,
  transformSurfaceCopySample,
} from '../../shared/surfaceStrokeSession.js';
import { CONFORM_STEP, MAX_CONFORM_POINTS } from './config.js';

/** Manual meshing rebuilds one stroke at a time — keep field density lower. */
const MANUAL_FIELD_SCALE = 2 / 3;

function resampleRaw(raw, step, maxPoints) {
  if (raw.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < raw.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(
      raw[i].p[0] - raw[i - 1].p[0],
      raw[i].p[1] - raw[i - 1].p[1],
      raw[i].p[2] - raw[i - 1].p[2],
    ));
  }
  const total = cum[cum.length - 1];
  if (total < step * 2) return null;
  const count = Math.min(maxPoints, Math.max(6, Math.round(total / step) + 1));
  const out = [];
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const s = (total * i) / (count - 1);
    while (seg < raw.length - 2 && cum[seg + 1] < s) seg++;
    const span = cum[seg + 1] - cum[seg];
    const t = span > 0 ? (s - cum[seg]) / span : 0;
    const a = raw[seg], b = raw[seg + 1];
    out.push({
      p: [0, 1, 2].map((k) => a.p[k] + (b.p[k] - a.p[k]) * t),
      n: [0, 1, 2].map((k) => a.n[k] + (b.n[k] - a.n[k]) * t),
      radiusScale: clampCvRadiusScale(
        (a.radiusScale ?? 1) + ((b.radiusScale ?? 1) - (a.radiusScale ?? 1)) * t,
      ),
    });
  }
  return out;
}

/** Laplacian smooth of positions, endpoints pinned. */
function smoothPositions(pts, iterations, weight = 0.55) {
  for (let pass = 0; pass < iterations; pass++) {
    const prev = pts.map((pt) => pt.p);
    for (let i = 1; i < pts.length - 1; i++) {
      pts[i] = {
        ...pts[i],
        p: [0, 1, 2].map((k) =>
          prev[i][k] + ((prev[i - 1][k] + prev[i + 1][k]) * 0.5 - prev[i][k]) * weight),
      };
    }
  }
}

function smoothNormals(pts, iterations) {
  for (let pass = 0; pass < iterations; pass++) {
    const prev = pts.map((pt) => pt.n);
    for (let i = 1; i < pts.length - 1; i++) {
      const n = [0, 1, 2].map((k) => prev[i - 1][k] + prev[i][k] * 2 + prev[i + 1][k]);
      const l = Math.hypot(...n) || 1;
      pts[i] = { ...pts[i], n: n.map((v) => v / l) };
    }
  }
}

/**
 * @param {object} deps
 * @param {() => object} deps.getLocal
 * @param {() => import('three').Mesh} deps.getTarget
 * @param {() => object[]} deps.getCommitted
 * @param {() => object} deps.getMeshIndex
 * @param {() => number} deps.unit
 */
export function createStrokePipeline({
  getLocal,
  getTarget,
  getCommitted,
  getMeshIndex,
  unit,
}) {
  /**
   * Weld smoothed points back onto the surface with the closest-point index.
   * Points that slid too far (past the query cap) keep the smoothed position
   * — the vine's lift hides it.
   */
  function weldToSurface(pts, alignNormals = false) {
    const local = getLocal();
    const index = getMeshIndex();
    const maxDist = Math.max(0.03, local.width * 6) * unit();
    for (const pt of pts) {
      const hit = index.closestPoint(
        pt.p[0], pt.p[1], pt.p[2], maxDist,
        alignNormals ? { normal: pt.n, minNormalDot: -0.25 } : undefined,
      );
      if (!hit) continue;
      pt.p = hit.point;
      pt.n = hit.normal;
    }
  }

  function conformFreehand(raw, { alignNormals = false } = {}) {
    const local = getLocal();
    const pts = resampleRaw(raw, CONFORM_STEP * unit(), MAX_CONFORM_POINTS);
    if (!pts) return null;
    smoothPositions(pts, local.flow);
    weldToSurface(pts, alignNormals);
    smoothNormals(pts, 2);
    return pts;
  }

  function projectSplinePoint(p, { normal, alignNormal = false }) {
    const local = getLocal();
    const target = getTarget();
    const index = getMeshIndex();
    if (!target.geometry.boundingSphere) target.geometry.computeBoundingSphere();
    const limit = Math.max(0.1, (target.geometry.boundingSphere?.radius ?? 1) * 2.1);
    let reach = Math.max(0.03, local.width * 6) * unit();
    while (reach < limit) {
      const hit = index.closestPoint(
        p[0], p[1], p[2], reach,
        alignNormal ? { normal, minNormalDot: -0.25 } : undefined,
      );
      if (hit) return { p: hit.point, n: hit.normal };
      reach *= 2;
    }
    const hit = index.closestPoint(
      p[0], p[1], p[2], limit,
      alignNormal ? { normal, minNormalDot: -0.25 } : undefined,
    ) ?? (alignNormal ? index.closestPoint(p[0], p[1], p[2], limit) : null);
    return hit ? { p: hit.point, n: hit.normal } : { p, n: normal };
  }

  function conformSpline(cvs, closed, cvRadiusScales, { alignNormals = false } = {}) {
    const sampled = sampleSurfaceSpline(cvs, {
      closed,
      radiusScales: cvRadiusScales,
      project: (p, meta) => projectSplinePoint(p, { ...meta, alignNormal: alignNormals }),
    });
    const pts = resampleRaw(sampled, CONFORM_STEP * unit(), MAX_CONFORM_POINTS);
    if (!pts) return null;
    weldToSurface(pts, alignNormals);
    smoothNormals(pts, 2);
    return pts;
  }

  function conformRecord(record) {
    return isSurfaceSplineRecord(record)
      ? conformSpline(record.cvs, record.closed, record.cvRadiusScales)
      : conformFreehand(record.raw);
  }

  function geometryCenter() {
    const target = getTarget();
    if (!target.geometry.boundingSphere) target.geometry.computeBoundingSphere();
    const c = target.geometry.boundingSphere?.center;
    return c ? [c.x, c.y, c.z] : [0, 0, 0];
  }

  function liveDrawSettings() {
    return captureSurfaceDrawSettings(getLocal(), geometryCenter());
  }

  function recordDraw(record) {
    return record?.draw ?? liveDrawSettings();
  }

  /**
   * Rigid symmetry/mirror puts samples in empty space on non-symmetric meshes.
   * Project each transformed sample back onto the target so copies stay on-skin.
   */
  function projectCopySample(sample, draw, copyIndex) {
    if (copyIndex === 0) return sample;
    const transformed = transformSurfaceCopySample(sample, draw, copyIndex);
    const hit = projectSplinePoint(transformed.p, {
      normal: transformed.n,
      alignNormal: true,
    });
    return {
      p: hit.p,
      n: hit.n,
      ...(transformed.radiusScale == null ? {} : { radiusScale: transformed.radiusScale }),
    };
  }

  function clearCopyCache(record) {
    if (record) record.copyCache = null;
  }

  /**
   * Build the on-surface polyline for one symmetry/mirror copy.
   * Authority (copy 0) reuses the cached conform; other copies are re-conformed
   * from the transformed stroke so crossing the mirror plane cannot feed the
   * field builder a path that tunnels through the mesh.
   */
  function samplesForCopy(record, copyIndex = 0) {
    if (!record) return null;
    if (copyIndex === 0) return record.conformed ?? null;
    const cache = record.copyCache ??= new Map();
    if (cache.has(copyIndex)) return cache.get(copyIndex);

    const draw = recordDraw(record);
    let samples = null;
    if (isSurfaceSplineRecord(record)) {
      const cvs = record.cvs.map((cv) => projectCopySample(cv, draw, copyIndex));
      samples = conformSpline(cvs, record.closed, record.cvRadiusScales, { alignNormals: true });
    } else if (Array.isArray(record.raw) && record.raw.length >= 2) {
      const raw = record.raw.map((sample) => transformSurfaceCopySample(sample, draw, copyIndex));
      samples = conformFreehand(raw, { alignNormals: true });
    }
    cache.set(copyIndex, samples);
    return samples;
  }

  function vineOptions() {
    const local = getLocal();
    // Manual mode pays per stroke; keep field density down so appends stay snappy.
    const res = local.manualMeshing ? local.res * MANUAL_FIELD_SCALE : local.res;
    return {
      radius: local.width * unit(),
      peak: local.width * local.peak * unit(), // peak = ratio × width
      relief: local.relief,
      wobble: local.wobble,
      melt: local.melt,
      taper: local.taper,
      taperPower: local.taperPower,
      thornSpacing: local.thorns > 0.01 ? 13 - 10.5 * local.thorns : 0,
      thornLength: local.spike,
      // melt drives the weld softness too — one molten dial, like the field
      blend: 0.35 + 1.35 * local.melt,
      conform: local.conform,
      detail: 3.2 * res,
      // Keep the old quadratic budget at ≤1×, then grow faster so high-res
      // settings aren't clawed back by the soft cell cap on dense drawings.
      cellBudget: Math.round(100000 * res * res * Math.max(res, 1)),
    };
  }

  function patchOptions() {
    const local = getLocal();
    const thickness = local.width * 2 * unit();
    const fieldResolution = local.manualMeshing
      ? local.patchResolution * MANUAL_FIELD_SCALE
      : local.patchResolution;
    return {
      thickness,
      edgeFalloff: thickness * local.patchFalloff,
      relief: local.patchRelief,
      reliefRange: 6,
      peakHeight: local.patchHeight * unit(),
      conform: local.conform,
      laplacian: local.patchMelt,
      heightSmooth: 2,
      fieldResolution,
      meshIndex: getMeshIndex(),
      taper: local.patchTaper,
      taperPower: local.patchTaperPower,
      normalSmooth: local.patchPolish,
      pointRadius: true,
    };
  }

  /** Conformed strokes (+ per-stroke symmetry/mirror copies). */
  function fieldStrokes(records = getCommitted()) {
    const list = [];
    for (const rec of records) {
      if (!rec.conformed) continue;
      const draw = recordDraw(rec);
      const copies = surfaceStrokeCopyCount(draw);
      const closed = isSurfaceSplineRecord(rec) && rec.closed;
      for (let copyIndex = 0; copyIndex < copies; copyIndex++) {
        const samples = samplesForCopy(rec, copyIndex);
        if (!samples || samples.length < 2) continue;
        list.push({
          samples,
          seed: rec.seed + copyIndex * 101,
          closed,
          record: rec,
          copyIndex,
        });
      }
    }
    return list;
  }

  function buildCommittedGeometry(strokes) {
    const local = getLocal();
    const target = getTarget();
    if (local.surfaceBackend === 'patch') {
      const paths = strokes.map(({ samples }) =>
        samples.map(({ p, radiusScale = 1 }) => [...p, radiusScale]));
      return buildSurfaceSigilGeometry(target.geometry, paths, patchOptions());
    }
    return buildSurfaceVineFieldGeometry(strokes, vineOptions());
  }

  return {
    projectSplinePoint,
    conformFreehand,
    conformSpline,
    conformRecord,
    geometryCenter,
    liveDrawSettings,
    recordDraw,
    clearCopyCache,
    samplesForCopy,
    vineOptions,
    patchOptions,
    fieldStrokes,
    buildCommittedGeometry,
  };
}
