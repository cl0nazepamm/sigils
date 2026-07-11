import { toPathSet } from './paths.js';
import { radialSymmetry } from '../symmetry.js';

export function symmetrizePaths(paths, opts = {}) {
  const { symmetry = 1, mirror = false, phase = 0, center } = opts;
  if (symmetry > 1 || mirror) {
    return radialSymmetry(paths, { symmetry, mirror, phase, center: center ?? [0, 0] });
  }
  return toPathSet(paths);
}
