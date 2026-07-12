/**
 * Sigils Creator panel state and option builders.
 *
 * Not part of the published three-sigils API — lives with the demo under examples/.
 */

export const DRAW_MERGE_RESOLUTION = 390;
export const REALTIME_MERGE_RESOLUTION = 280;

/** Demo defaults matching the former draw.html commit path. */
export const DRAW_DEMO_DEFAULTS = {
  symmetry: 1,
  mirror: true,
  thickness: 0.295,
  center: [0, 0],
  resolution: DRAW_MERGE_RESOLUTION,
  backend: 'hybrid',
  smooth: 1,
  taper: 1,
  taperPower: 1.03,
  depthMode: 'boundary',
  edgeFalloffNorm: 0.5,
  relief: 'carve',
  reliefRange: 6,
  laplacian: 54,
  laplacianWeight: 0.87,
  heightSmooth: 2,
  base: 0.03,
  peak: 0.07,
  roughness: 0,
  profile: 'linear',
  color: '#ffffff',
  envMapIntensity: 1.6,
  minDrawStep: 0.015,
};

export const SIGIL_DEFAULTS = {
  interaction: {
    minDrawStep: DRAW_DEMO_DEFAULTS.minDrawStep,
  },
  stroke: {
    drawTool: 'freehand',
    symmetry: DRAW_DEMO_DEFAULTS.symmetry,
    mirror: DRAW_DEMO_DEFAULTS.mirror,
    phase: 0,
    center: DRAW_DEMO_DEFAULTS.center,
    thickness: DRAW_DEMO_DEFAULTS.thickness,
    cvRadiusScale: 1,
    showActiveCvs: true,
    guides: false,
    previewStripOnly: false,
    orthographic: false,
  },
  field: {
    backend: DRAW_DEMO_DEFAULTS.backend,
    resolution: DRAW_DEMO_DEFAULTS.resolution,
    smooth: DRAW_DEMO_DEFAULTS.smooth,
    taper: DRAW_DEMO_DEFAULTS.taper,
    taperPower: DRAW_DEMO_DEFAULTS.taperPower,
    edgeFalloffNorm: DRAW_DEMO_DEFAULTS.edgeFalloffNorm,
    base: DRAW_DEMO_DEFAULTS.base,
    resampleFactor: 0.12,
    gridBufferFactor: 1.5,
    depthMode: DRAW_DEMO_DEFAULTS.depthMode,
    relief: DRAW_DEMO_DEFAULTS.relief,
    reliefRange: DRAW_DEMO_DEFAULTS.reliefRange,
    mergeBlendScale: 8,
    depthBlendScale: 6,
  },
  melt: {
    laplacian: DRAW_DEMO_DEFAULTS.laplacian,
    laplacianWeight: DRAW_DEMO_DEFAULTS.laplacianWeight,
    heightSmooth: DRAW_DEMO_DEFAULTS.heightSmooth,
    heightSmoothWeight: 0.45,
  },
  preview: {
    taperLen: 0.35,
    taperPower: 1.05,
    tipRadius: 0.004,
    ridgePower: 1,
    bevel: 0.12,
    heightSmooth: 2,
    heightSmoothWeight: 0.65,
    resample: 0.03,
    simplify: 0.006,
    spread: 0,
  },
  surface: {
    peakHeight: DRAW_DEMO_DEFAULTS.peak,
    roughness: DRAW_DEMO_DEFAULTS.roughness,
    metalness: 1,
    profile: DRAW_DEMO_DEFAULTS.profile,
    color: DRAW_DEMO_DEFAULTS.color,
    envMapIntensity: DRAW_DEMO_DEFAULTS.envMapIntensity,
  },
};

/** @param {object} [overrides] Flat demo/runtime overrides. */
export function createSigilState(overrides = {}) {
  const d = SIGIL_DEFAULTS;
  return {
    minDrawStep: overrides.minDrawStep ?? d.interaction.minDrawStep,
    drawTool: overrides.drawTool === 'spline' || overrides.drawTool === 'freehand'
      ? overrides.drawTool
      : d.stroke.drawTool,
    symmetry: overrides.symmetry ?? d.stroke.symmetry,
    mirror: overrides.mirror ?? d.stroke.mirror,
    phase: overrides.phase ?? d.stroke.phase,
    center: overrides.center ?? d.stroke.center,
    thickness: overrides.thickness ?? d.stroke.thickness,
    cvRadiusScale: overrides.cvRadiusScale ?? d.stroke.cvRadiusScale,
    showActiveCvs: overrides.showActiveCvs ?? d.stroke.showActiveCvs,
    guides: overrides.guides ?? d.stroke.guides,
    previewStripOnly: overrides.previewStripOnly ?? d.stroke.previewStripOnly,
    orthographic: overrides.orthographic ?? d.stroke.orthographic,
    backend: overrides.backend ?? d.field.backend,
    resolution: overrides.resolution ?? overrides.resolutionQuality ?? overrides.resolutionFast ?? d.field.resolution,
    smooth: overrides.smooth ?? d.field.smooth,
    taper: overrides.taper ?? d.field.taper,
    taperPower: overrides.taperPower ?? d.field.taperPower,
    edgeFalloffNorm: overrides.edgeFalloffNorm ?? d.field.edgeFalloffNorm,
    base: overrides.base ?? d.field.base,
    resample: overrides.resample ?? null,
    resampleFactor: overrides.resampleFactor ?? d.field.resampleFactor,
    gridBuffer: overrides.gridBuffer ?? null,
    gridBufferFactor: overrides.gridBufferFactor ?? d.field.gridBufferFactor,
    depthMode: overrides.depthMode ?? d.field.depthMode,
    relief: overrides.relief ?? d.field.relief,
    reliefRange: overrides.reliefRange ?? d.field.reliefRange,
    mergeBlendScale: overrides.mergeBlendScale ?? d.field.mergeBlendScale,
    depthBlendScale: overrides.depthBlendScale ?? d.field.depthBlendScale,
    laplacian: overrides.laplacian ?? d.melt.laplacian,
    laplacianWeight: overrides.laplacianWeight ?? d.melt.laplacianWeight,
    heightSmooth: overrides.heightSmooth ?? d.melt.heightSmooth,
    heightSmoothWeight: overrides.heightSmoothWeight ?? d.melt.heightSmoothWeight,
    taperLen: overrides.taperLen ?? d.preview.taperLen,
    previewTaperPower: overrides.previewTaperPower ?? d.preview.taperPower,
    tipRadius: overrides.tipRadius ?? d.preview.tipRadius,
    ridgePower: overrides.ridgePower ?? d.preview.ridgePower,
    bevel: overrides.bevel ?? d.preview.bevel,
    previewHeightSmooth: overrides.previewHeightSmooth ?? d.preview.heightSmooth,
    previewHeightSmoothWeight: overrides.previewHeightSmoothWeight ?? d.preview.heightSmoothWeight,
    previewResample: overrides.previewResample ?? d.preview.resample,
    simplify: overrides.simplify ?? d.preview.simplify,
    spread: overrides.spread ?? d.preview.spread,
    peak: overrides.peak ?? d.surface.peakHeight,
    roughness: overrides.roughness ?? d.surface.roughness,
    metalness: overrides.metalness ?? d.surface.metalness,
    profile: overrides.profile ?? d.surface.profile,
    color: overrides.color ?? d.surface.color,
    envMapIntensity: overrides.envMapIntensity ?? d.surface.envMapIntensity,
  };
}

/** Alias for {@link createSigilState} — former draw.html defaults. */
export function createDrawDemoState(overrides = {}) {
  return createSigilState(overrides);
}

function thicknessOf(state) {
  return state.thickness ?? SIGIL_DEFAULTS.stroke.thickness;
}

function resampleSpacing(state) {
  if (state.resample != null) return state.resample;
  return thicknessOf(state) * (state.resampleFactor ?? SIGIL_DEFAULTS.field.resampleFactor);
}

/**
 * Shared SDF / marching-squares shape options.
 * @param {object} state
 */
export function shapeOptionsFromState(state) {
  const thickness = thicknessOf(state);
  const resolution = state.resolution ?? SIGIL_DEFAULTS.field.resolution;

  const opts = {
    symmetry: state.symmetry,
    mirror: state.mirror,
    phase: state.phase,
    center: state.center,
    thickness,
    resolution,
    fieldResolution: resolution,
    resample: resampleSpacing(state),
    fieldBackend: state.backend,
    smooth: state.smooth,
    taper: state.taper,
    taperPower: state.taperPower,
    depthMode: state.depthMode,
    relief: state.relief,
    reliefRange: state.reliefRange,
    edgeFalloff: thickness * (state.edgeFalloffNorm ?? SIGIL_DEFAULTS.field.edgeFalloffNorm),
    laplacian: state.laplacian,
    laplacianWeight: state.laplacianWeight,
    heightSmooth: state.heightSmooth,
    heightSmoothWeight: state.heightSmoothWeight,
    base: state.base,
    fieldMergeBlendScale: state.mergeBlendScale,
    fieldDepthBlendScale: state.depthBlendScale,
  };

  if (state.gridBuffer != null) opts.gridBuffer = state.gridBuffer;
  else opts.gridBufferFactor = state.gridBufferFactor;

  return opts;
}

/** @deprecated Use {@link shapeOptionsFromState} */
export function mergedSigilShapeOptions(overrides = {}) {
  return shapeOptionsFromState(createSigilState({ resolution: DRAW_MERGE_RESOLUTION, ...overrides }));
}

/** @deprecated Use {@link shapeOptionsFromState} */
export function realtimeMergedShapeOptions(overrides = {}) {
  return shapeOptionsFromState(createSigilState({ resolution: REALTIME_MERGE_RESOLUTION, ...overrides }));
}

/** Sparse strip preview while drawing — derived from field/surface knobs. */
export function sparsePreviewOptionsFromState(state) {
  const thickness = thicknessOf(state);
  const taper = Math.min(1, Math.max(0, Number(state.taper) || 0));
  const taperPower = Number(state.taperPower);
  const resample = resampleSpacing(state);
  const carve = state.relief !== 'plateau';
  const falloff = Math.min(1.2, Math.max(0.18, Number(state.edgeFalloffNorm) || 0.5));
  // Map field falloff into strip ridge/bevel so carve stays peaked and plateau
  // stays flatter without a separate Strip tuning panel. Narrower falloff →
  // sharper carve ridge; plateau stays sub-linear for a flatter top.
  const ridgePower = carve
    ? Math.min(3, 0.75 + 0.85 / falloff)
    : Math.max(0.35, 0.35 + falloff * 0.35);
  const bevel = carve
    ? Math.min(0.18, 0.03 + (1.2 - falloff) * 0.06)
    : Math.min(0.32, 0.14 + (1.2 - falloff) * 0.12);

  return {
    symmetry: state.symmetry,
    mirror: state.mirror,
    phase: state.phase,
    center: state.center,
    thickness,
    spread: state.spread ?? 0,
    peakHeight: state.peak,
    resample,
    simplify: Math.min(resample * 0.25, thickness * 0.02),
    // Same open-end model as DistanceField / GPU field (arc sine blend).
    taper,
    taperPower: Number.isFinite(taperPower) ? taperPower : SIGIL_DEFAULTS.field.taperPower,
    tipRadius: 0,
    ridgePower,
    bevel,
    heightSmooth: state.heightSmooth ?? SIGIL_DEFAULTS.melt.heightSmooth,
    heightSmoothWeight: state.heightSmoothWeight ?? SIGIL_DEFAULTS.melt.heightSmoothWeight,
    baseDepth: state.base,
  };
}

/** TSL chrome material options. */
export function chromeOptionsFromState(state) {
  return {
    peakHeight: state.peak,
    roughness: state.roughness,
    metalness: state.metalness,
    profile: state.profile,
    color: state.color,
    envMapIntensity: state.envMapIntensity,
  };
}
