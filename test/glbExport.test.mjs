import assert from 'node:assert/strict';
import {
  BufferGeometry,
  Float32BufferAttribute,
} from 'three';
import { createSigilState } from '../src/index.js';
import {
  bakeChromeGeometryForGlb,
  buildCommittedGlb,
} from '../examples/shared/glbExport.js';
import {
  makeSplineRecord,
  makeStrokeRecord,
} from '../examples/shared/strokeSession.js';

globalThis.FileReader ??= class FileReader {
  result = null;
  onloadend = null;

  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = buffer;
      queueMicrotask(() => this.onloadend?.());
    });
  }
};

const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute([
  0, 0, 0,
  1, 0, 0,
  0, 1, -0.1,
], 3));
geometry.setAttribute('aDepth', new Float32BufferAttribute([1, 0.5, 0], 1));
geometry.setAttribute('aDome', new Float32BufferAttribute([1, 1, 0], 1));
geometry.setAttribute('aGrad', new Float32BufferAttribute([
  0, 0,
  1, 0,
  0, 0,
], 2));
geometry.setAttribute('aNormal', new Float32BufferAttribute([
  0, 0, 1,
  0, 0, 1,
  0, 0, -1,
], 3));

bakeChromeGeometryForGlb(geometry, { peakHeight: 0.2, profile: 'linear' });

assert.ok(close(geometry.getAttribute('position').getZ(0), 0.2), 'full-depth dome vertex is displaced');
assert.ok(close(geometry.getAttribute('position').getZ(1), 0.1), 'half-depth dome vertex is displaced');
assert.ok(close(geometry.getAttribute('position').getZ(2), -0.1), 'base vertex keeps baked z');
assert.ok(geometry.getAttribute('normal').getZ(1) < 1, 'gradient affects exported normal');
assert.ok(close(geometry.getAttribute('normal').getZ(2), -1), 'base normal is preserved');
assert.equal(geometry.getAttribute('aDepth'), undefined, 'export-only custom depth attribute removed');
assert.equal(geometry.getAttribute('aGrad'), undefined, 'export-only custom gradient attribute removed');
assert.ok(geometry.boundingBox, 'bounds recomputed after bake');

const state = createSigilState({
  symmetry: 1,
  mirror: false,
  resolution: 64,
  smooth: 1,
  laplacian: 2,
  heightSmooth: 1,
});
const strokes = [
  makeStrokeRecord([[-0.9, 0.2], [-0.5, 0.35], [-0.15, 0.1]], state),
  makeSplineRecord(
    [[0, -0.35], [0.35, -0.6], [0.7, -0.15], [0.95, -0.4]],
    false,
    state,
    [0.4, 1.2, 2.25, 0.7],
  ),
];
const glb = await buildCommittedGlb(strokes, state, null);
const header = String.fromCharCode(...new Uint8Array(glb, 0, 4));
assert.equal(header, 'glTF', 'binary GLB header is written');
assert.ok(glb.byteLength > 100, 'mixed freehand and spline records produce a binary mesh payload');

console.log('glb export OK');

function close(actual, expected) {
  return Math.abs(actual - expected) < 1e-6;
}
