# sigils

Procedural **chrome-sigil meshes** for [three.js](https://threejs.org/). Feed it a
stroke (or a few), and it grows a symmetric, rounded, mirror-finish emblem — the
look of liquid-chrome lettering and occult sigils.

The default geometry path is synchronous CPU code. The async hybrid path can
rasterize the raw distance field with WebGPU compute, then keeps
marching-squares topology on the CPU. Displacement, surface normals and chrome
shading are expressed in **TSL** (Three Shading Language), so the silhouette can
be reused while the look stays parametric on the GPU.

> The chrome material and hybrid field path target `WebGPURenderer`. The async
> hybrid builder falls back to CPU field rasterization if GPU compute/readback is
> unavailable.

## Pipeline

```
strokes ─▶ radial symmetry ─▶ distance field (CPU or WebGPU compute) ─▶ filled marching squares
        ─▶ sigilize blur ─▶ boundary height ─▶ solidify (dome + walls + base)
        ─▶ BufferGeometry
                                              │
                            TSL material ◀────┘   peak displacement
                                                  analytic normals
                                                  metal / chrome shading
```

1. **Radial symmetry** — N rotated copies of the stroke around a pivot.
2. **Distance field** — distance-to-stroke sampled on a grid.
3. **Filled marching squares** — threshold the field into a smooth "fat stroke"
   region and triangulate it (interpolated edges → clean silhouette).
4. **Sigilize blur** — point-position blur of point positions on the generated
   mesh, turning the raw fat stroke into the melted sigil surface.
5. **Boundary height** — derive height from distance to the finished boundary
   edge, not just distance to the original stroke.
6. **Solidify + TSL material** — extrude a flat base and side walls into a
   closed solid, push the top surface up from the baked height field, derive
   smooth normals analytically, and shade it as a mirror metal lit by the scene
   environment.

## Install

```bash
npm install sigils three
```

`three` is a peer dependency (`>=0.176`).

## Quick start

```js
import * as THREE from 'three/webgpu';
import { createSigil } from 'sigils';

const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();

const scene = new THREE.Scene();
// chrome needs something to reflect — set scene.environment to a PMREM.

const sigil = createSigil(stroke, {
  symmetry: 6,        // radial copies
  center: [0, 0],     // symmetry pivot
  thickness: 0.16,    // fat-stroke width
  resolution: 320,    // field grid density
  sigilize: 36,        // point-position point-position blur
  depthMode: 'boundary',
  base: 0.08,         // solid base depth (0 = open shell)
  peakHeight: 0.30,   // bulge height (live)
  profile: 'linear',  // 'linear' matches the GN reference; 'round' is tube-like
  roughness: 0.06,    // 0 = perfect mirror (live)
});
scene.add(sigil);
```

`stroke` is a polyline. Accepted shapes: `[[x,y], ...]`, `[{x,y}, ...]`,
a flat `[x0,y0,x1,y1,...]`, or an array of any of those for multiple strokes.

### Hybrid WebGPU field

Use the async API when you want WebGPU compute to build the raw distance/taper
field. The generated mesh is the same `BufferGeometry`; `geometry.userData`
records whether that build used `gpu` or fell back to `cpu`.

```js
import { createSigilAsync } from 'sigils';

const sigil = await createSigilAsync(stroke, {
  renderer,
  fieldBackend: 'hybrid',
  thickness: 0.16,
  resolution: 460,
  sigilize: 36,
  depthMode: 'boundary',
});

console.log(sigil.geometry.userData.fieldBackend); // 'gpu' or 'cpu'
```

### Live tweaks (no rebuild)

```js
import { updateChromeMaterial } from 'sigils';

updateChromeMaterial(sigil.material, { peakHeight: 0.5, roughness: 0.02 });
// or directly: sigil.userData.sigil.uniforms.peakHeight.value = 0.5;
```

Shape options (`symmetry`, `thickness`, `resolution`, `sigilize`, `depthMode`,
`base`, `center`) change the silhouette or baked attributes and need a rebuild:

```js
sigil.userData.sigil.rebuild(newStroke, { symmetry: 8, thickness: 0.2 });
```

## Lower-level API

```js
import {
  buildSigilGeometry,   // strokes -> BufferGeometry (with aDepth/aGrad/aNormal/aDome)
  buildSigilGeometryAsync, // optional WebGPU compute distance-field backend
  buildGpuDistanceField, // raw WebGPU distance/taper field + CPU readback
  createChromeMaterial, // TSL chrome NodeMaterial
  spirograph,           // hypotrochoid stroke (cusps + loops)
  radialSymmetry,       // strokes -> N rotated copies
  DistanceField,        // grid distance field with sample()/gradient()
  fillRegion,           // filled marching squares
  resampleByLength,
} from 'sigils';
```

The sharp-cusped, woven look comes from feeding a spirograph in:

```js
import { createSigil, spirograph } from 'sigils';

const stroke = spirograph({ R: 7, r: 4, d: 6, radius: 1.2 });
const sigil = createSigil(stroke, { thickness: 0.24, peakHeight: 0.15, smooth: 2 });
// d ≈ r → sharp cusps · d > r → looping web · low `smooth` keeps cusps crisp
```

Bring your own material? The geometry exposes these vertex attributes:

| attribute | type  | meaning |
|-----------|-------|---------|
| `aDepth`  | float | 0 at the rim, 1 in the raised interior (`boundary`) or stroke centerline (`centerline`) |
| `aGrad`   | vec2  | gradient of `aDepth` (for analytic normals) |
| `aNormal` | vec3  | flat normal for the base + walls |
| `aDome`   | float | 1 on the top surface, 0 on base/walls |

## Run the demo

```bash
npm install
npm run example
```

Drag to orbit. Keys: `1–6` spirograph preset · `[ ]` peak height · `- =`
roughness · `r` cycle presets.

Want to draw your own stroke? Open `/draw.html` on the dev server — left-drag to
sketch a curve, release to forge it into chrome. Strokes accumulate, and the
**Symmetry** control turns a single stroke into a full radial emblem.

### Realtime GPU-SDF demo

`/realtime.html` is the state-of-the-art path: the sigil is **never meshed on the
CPU**. Your strokes become a segment buffer, and a single TSL material evaluates
the whole emblem as a signed-distance field every frame — kaleidoscope symmetry
by domain-folding, a smooth-union (`smin`) melt, dome displacement with analytic
normals, and a per-pixel silhouette. Drawing, symmetry, mirror, width, melt, peak
and roughness are all live uniforms; nothing rebuilds, so the chrome forges under
your cursor as you draw.

The per-pixel field is the dominant cost, so it's gated by a **vertex pre-reject**:
the field is sampled once per vertex and interpolated, and any fragment that's
confidently inside/outside the stroke (beyond the triangle's Lipschitz slack) skips
the loop — only the thin boundary band evaluates the field per pixel. That keeps a
light sigil near ~180 fps and roughly halves the cost of dense ones.

## Notes

- The distance field is brute-force (grid × segments). For very high resolution
  or huge stroke counts, swap in a Euclidean distance transform.
- `peakHeight` is in world units — scale it to your stroke coordinates.

## License

MIT
