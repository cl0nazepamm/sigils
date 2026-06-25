/**
 * Central defaults and option builders for the sigils pipeline.
 */

export const DRAW_MERGE_RESOLUTION = 460;
export const REALTIME_MERGE_RESOLUTION = 280;

export const SIGIL_DEFAULTS = {
  interaction: {
    minDrawStep: 0.012,
  },
  stroke: {
    symmetry: 6,
    mirror: false,
    phase: 0,
    center: [0, 0],
    thickness: 0.14,
    guides: true,
  },
  field: {
    backend: 'hybrid',
    resolution: REALTIME_MERGE_RESOLUTION,
    smooth: 3,
    taper: 1,
    taperPower: 1.05,
    edgeFalloffNorm: 0.5,
    base: 0,
    resampleFactor: 0.12,
    gridBufferFactor: 1.5,
    depthMode: 'boundary',
    mergeBlendScale: 8,
    depthBlendScale: 6,
  },
  melt: {
    sigilize: 36,
    sigilizeWeight: 0.75,
    heightSmooth: 2,
    heightSmoothWeight: 0.5,
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
    peakHeight: 0.14,
    roughness: 0.05,
    metalness: 1,
    profile: 'linear',
    color: 0xffffff,
    envMapIntensity: 1.6,
  },
};

/** @param {object} [overrides] Flat demo/runtime overrides. */
export function createSigilState(overrides = {}) {
  const d = SIGIL_DEFAULTS;
  return {
    minDrawStep: overrides.minDrawStep ?? d.interaction.minDrawStep,
    symmetry: overrides.symmetry ?? d.stroke.symmetry,
    mirror: overrides.mirror ?? d.stroke.mirror,
    phase: overrides.phase ?? d.stroke.phase,
    center: overrides.center ?? d.stroke.center,
    thickness: overrides.thickness ?? d.stroke.thickness,
    guides: overrides.guides ?? d.stroke.guides,
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
    mergeBlendScale: overrides.mergeBlendScale ?? d.field.mergeBlendScale,
    depthBlendScale: overrides.depthBlendScale ?? d.field.depthBlendScale,
    sigilize: overrides.sigilize ?? d.melt.sigilize,
    sigilizeWeight: overrides.sigilizeWeight ?? d.melt.sigilizeWeight,
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
    edgeFalloff: thickness * (state.edgeFalloffNorm ?? SIGIL_DEFAULTS.field.edgeFalloffNorm),
    sigilize: state.sigilize,
    sigilizeWeight: state.sigilizeWeight,
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

/** Sparse strip preview while drawing. */
export function sparsePreviewOptionsFromState(state) {
  return {
    symmetry: state.symmetry,
    mirror: state.mirror,
    phase: state.phase,
    center: state.center,
    thickness: thicknessOf(state),
    spread: state.spread,
    peakHeight: state.peak,
    resample: state.previewResample,
    simplify: state.simplify,
    taperLen: state.taperLen,
    taperPower: state.previewTaperPower,
    tipRadius: state.tipRadius,
    ridgePower: state.ridgePower,
    bevel: state.bevel,
    heightSmooth: state.previewHeightSmooth,
    heightSmoothWeight: state.previewHeightSmoothWeight,
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
