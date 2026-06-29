/** Demo control specs — keys map to {@link createSigilState}. */

export const DEMO_CONTROL_SPECS = [
  { type: 'section', label: 'Stroke' },
  { key: 'symmetry', label: 'Symmetry', type: 'range', min: 1, max: 12, step: 1, int: true },
  { key: 'mirror', label: 'Mirror', type: 'check' },
  { key: 'thickness', label: 'Width', type: 'range', min: 0.04, max: 0.32, step: 0.005 },
  { key: 'guides', label: 'Curves', type: 'check' },
  { key: 'previewStripOnly', label: 'Preview strip', type: 'check' },
  { key: 'orthographic', label: 'No perspective', type: 'check' },

  { type: 'section', label: 'Field' },
  { key: 'backend', label: 'Backend', type: 'select', options: [['hybrid', 'hybrid gpu'], ['cpu', 'cpu']] },
  { key: 'resolution', label: 'Resolution', type: 'range', min: 160, max: 640, step: 10, int: true },
  { key: 'smooth', label: 'Field blur', type: 'range', min: 0, max: 12, step: 1, int: true },
  { key: 'taper', label: 'Cap taper', type: 'range', min: 0, max: 1, step: 0.01 },
  { key: 'taperPower', label: 'Tip taper', type: 'range', min: 0.35, max: 2.4, step: 0.01 },
  { key: 'edgeFalloffNorm', label: 'Falloff', type: 'range', min: 0.18, max: 1.2, step: 0.01 },
  { key: 'base', label: 'Base (cap)', type: 'range', min: 0, max: 0.16, step: 0.005 },

  { type: 'details', label: 'Field advanced' },
  { key: 'resampleFactor', label: 'Resample × width', type: 'range', min: 0.04, max: 0.24, step: 0.01 },
  { key: 'gridBufferFactor', label: 'Grid margin × threshold', type: 'range', min: 0.5, max: 3, step: 0.05 },
  { key: 'depthMode', label: 'Depth', type: 'select', options: [['boundary', 'boundary'], ['centerline', 'centerline']] },
  { key: 'mergeBlendScale', label: 'Merge blend scale', type: 'range', min: 4, max: 16, step: 1, int: true },
  { key: 'depthBlendScale', label: 'Depth blend scale', type: 'range', min: 4, max: 16, step: 1, int: true },
  { type: 'hostReset' },

  { type: 'section', label: 'Melt' },
  { key: 'sigilize', label: 'Smooth', type: 'range', min: 0, max: 70, step: 1, int: true },
  { key: 'sigilizeWeight', label: 'Strength', type: 'range', min: 0, max: 1, step: 0.01 },
  { key: 'heightSmooth', label: 'Height blur', type: 'range', min: 0, max: 12, step: 1, int: true },
  { key: 'heightSmoothWeight', label: 'Height blur weight', type: 'range', min: 0, max: 1, step: 0.05 },

  { type: 'details', label: 'Strip tuning' },
  { key: 'taperLen', label: 'End taper len', type: 'range', min: 0.05, max: 0.8, step: 0.01 },
  { key: 'previewTaperPower', label: 'End taper power', type: 'range', min: 0.5, max: 3, step: 0.05 },
  { key: 'tipRadius', label: 'Tip radius', type: 'range', min: 0.001, max: 0.02, step: 0.001 },
  { key: 'ridgePower', label: 'Ridge power', type: 'range', min: 0.4, max: 3, step: 0.05 },
  { key: 'bevel', label: 'Bevel', type: 'range', min: 0, max: 0.35, step: 0.01 },
  { key: 'previewHeightSmooth', label: 'Height smooth', type: 'range', min: 0, max: 8, step: 1, int: true },
  { key: 'previewHeightSmoothWeight', label: 'Height smooth wt', type: 'range', min: 0, max: 1, step: 0.05 },
  { key: 'previewResample', label: 'Resample', type: 'range', min: 0.01, max: 0.08, step: 0.005 },
  { key: 'simplify', label: 'Simplify', type: 'range', min: 0, max: 0.02, step: 0.001 },
  { type: 'hostReset' },

  { type: 'section', label: 'Surface' },
  { key: 'peak', label: 'Peak', type: 'range', min: 0, max: 0.45, step: 0.005, live: true },
  { key: 'profile', label: 'Profile', type: 'select', options: [['linear', 'linear'], ['round', 'round']] },

  { type: 'section', label: 'Chrome' },
  { key: 'roughness', label: 'Rough', type: 'range', min: 0, max: 0.35, step: 0.005, live: true },
  { key: 'envMapIntensity', label: 'Env strength', type: 'range', min: 0.4, max: 3, step: 0.05, live: true },
];
