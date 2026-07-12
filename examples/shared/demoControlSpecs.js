/** Demo control specs — keys map to {@link createSigilState}. */

export const DEMO_CONTROL_SPECS = [
  { type: 'section', label: 'Main', main: true, open: true },
  { key: 'thickness', label: 'Width', type: 'range', min: 0.04, max: 0.8, step: 0.005, main: true },
  { key: 'peak', label: 'Peak', type: 'range', min: 0, max: 0.45, step: 0.005, live: true, main: true },
  { key: 'resolution', label: 'Resolution', type: 'range', min: 160, max: 640, step: 10, int: true, main: true },

  // Draw interaction + chrome look sit together.
  { type: 'group' },
  { type: 'section', label: 'Stroke', open: true },
  { key: 'symmetry', label: 'Symmetry', type: 'range', min: 1, max: 12, step: 1, int: true },
  { key: 'mirror', label: 'Mirror', type: 'check' },
  { key: 'guides', label: 'Curves', type: 'check' },
  { key: 'previewStripOnly', label: 'Fast preview', type: 'check' },
  { key: 'orthographic', label: 'Flat view', type: 'check' },

  { type: 'section', label: 'Chrome', open: true },
  { key: 'color', label: 'Color', type: 'color', live: true },
  { key: 'metalness', label: 'Metalness', type: 'range', min: 0, max: 1, step: 0.01, live: true },
  { key: 'roughness', label: 'Rough', type: 'range', min: 0, max: 1, step: 0.01, live: true },
  { type: 'hostReset' },

  // Field build + mesh smoothing.
  { type: 'group' },
  { type: 'section', label: 'Field' },
  { key: 'backend', label: 'Compute', type: 'select', options: [['hybrid', 'GPU'], ['cpu', 'CPU']] },
  { key: 'smooth', label: 'Field blur', type: 'range', min: 0, max: 12, step: 1, int: true },
  { key: 'taper', label: 'Cap taper', type: 'range', min: 0, max: 1, step: 0.01 },
  { key: 'taperPower', label: 'Tip shape', type: 'range', min: 0.35, max: 2.4, step: 0.01 },
  { key: 'edgeFalloffNorm', label: 'Edge falloff', type: 'range', min: 0.18, max: 1.2, step: 0.01 },
  { key: 'relief', label: 'Relief', type: 'select', options: [['carve', 'Peaked'], ['plateau', 'Flat top']] },
  { key: 'base', label: 'Shell depth', type: 'range', min: 0, max: 0.16, step: 0.005 },

  { type: 'section', label: 'Smooth' },
  { key: 'laplacian', label: 'Mesh smooth', type: 'range', min: 0, max: 70, step: 1, int: true },
  { key: 'laplacianWeight', label: 'Smooth strength', type: 'range', min: 0, max: 1, step: 0.01 },
  { key: 'heightSmooth', label: 'Height blur', type: 'range', min: 0, max: 12, step: 1, int: true },
  { key: 'heightSmoothWeight', label: 'Height blur weight', type: 'range', min: 0, max: 1, step: 0.05 },
  { type: 'hostReset' },

  // Profile + advanced field knobs.
  { type: 'group' },
  { type: 'section', label: 'Surface' },
  { key: 'profile', label: 'Profile', type: 'select', options: [['linear', 'linear'], ['round', 'round']] },

  { type: 'section', label: 'Advanced' },
  { key: 'resampleFactor', label: 'Sample density', type: 'range', min: 0.04, max: 0.24, step: 0.01 },
  { key: 'gridBufferFactor', label: 'Field padding', type: 'range', min: 0.5, max: 3, step: 0.05 },
  { key: 'depthMode', label: 'Height from', type: 'select', options: [['boundary', 'Edges'], ['centerline', 'Center']] },
  { key: 'reliefRange', label: 'Peak width', type: 'range', min: 1, max: 12, step: 0.5 },
  { key: 'mergeBlendScale', label: 'Stroke blend', type: 'range', min: 4, max: 16, step: 1, int: true },
  { key: 'depthBlendScale', label: 'Height blend', type: 'range', min: 4, max: 16, step: 1, int: true },
  { type: 'hostReset' },
];
