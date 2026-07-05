# sigils

Procedural chrome-sigil meshes for three.js — draw strokes, get symmetric,
melted, mirror-finish emblems (Y2K cybersigilism / chrome-tribal aesthetic).
This is both a **library** (npm `sigils`, three.js peer dep) and an
**interactive drawing demo** (`examples/`). The end goal is a genuinely
beautiful, intuitive shape-drawing app: people draw curves, make them chrome,
and **export GLB into their own 3D scenes**. Runtime generation in a user's
three.js app is equally supported. Taste and speed are the product — changes
should feel fast (target: mindblowingly fast) and look considered.

## The one architecture rule

**Everything runs on the GPU except mesh topology.** Marching squares and
solidify emit variable topology, so they stay CPU-side; every uniform-grid or
per-vertex pass (field rasterization, blur, sigilize melt) belongs on WebGPU
compute with a CPU fallback. When adding a stage, default it to GPU unless it
creates variable topology.

- GPU code is written in **TSL** (`three/tsl` nodes, `Fn().compute()`), never raw WGSL.
- Every GPU path degrades gracefully: try GPU, catch, fall back to the CPU twin,
  record which ran in `geometry.userData` (`fieldBackend`, `sigilizeBackend`, `buildBackend`).
- CPU and GPU twins must match numerically (e.g. the GPU box blur replicates
  `blurArray` exactly: same edge-clamped 3-tap kernel, same pass order).
- **Batch dispatches.** `renderer.computeAsync()` accepts an ARRAY of compute
  nodes and runs them as one compute pass with ordered dispatches (storage
  writes visible to the next dispatch). Multi-pass loops (blur, sigilize melt)
  build two fixed ping-pong kernels and queue them N times into ONE
  computeAsync — never `await` per pass. Kernel builders live next to their
  awaiting wrappers (`rasterizeFieldKernel`/`rasterizeField`, `blurFieldKernel`/`blurFieldPass`).

## Pipeline

```
strokes → radial symmetry → distance field (taper weights) → filled marching squares
        → sigilize (Laplacian position melt) → boundary depth → solidify (dome+walls+base)
        → BufferGeometry with aDepth/aGrad/aNormal/aDome
        → TSL chrome material (peak displacement + analytic normals, live uniforms)
```

Displacement and normals are computed in the vertex stage from baked
attributes, so `peakHeight`/`roughness`/`profile` are **live** (no rebuild);
silhouette options (`symmetry`, `thickness`, `resolution`, `sigilize`, `base`…)
require a rebuild.

## Build paths (know which one you're touching)

| Path | Entry | Field | Topology | Use |
|---|---|---|---|---|
| Sync CPU | `buildSigilGeometry` / `createSigil` | CPU `DistanceField` | CPU | simplest, no renderer needed |
| Hybrid async | `buildSigilGeometryAsync` / `createSigilAsync` | WebGPU compute + readback | CPU | quality commits (`fieldBackend:'hybrid'`) |
| GPU field mesh | `buildGpuFieldMeshAsync` (via `buildSparseCurveGeometryAsync`) | WebGPU compute + readback | CPU | fast merged commits in the demo |
| Sparse strips | `buildSparseCurveGeometry` | none (curve-native strips) | CPU | live preview while drawing; never rasterizes empty space |
| Meshless raymarch | `meshlessField.js` + `tsl/raymarchSigilMaterial.js` | GPU-resident, **zero readback** | none | per-pixel height-field raymarch; not exportable; demo "meshless" mode |

The demo's interaction model: **sparse strip preview while the pointer is down,
merged SDF rebuild on release.** Preserve that split when changing draw flow.

## Source map

- `src/index.js` — public API surface (keep exports curated; this is a library).
- `src/buildGeometry.js` — CPU finish pipeline: fill → sigilize → boundary depth → solidify.
- `src/distanceField.js` / `src/gpuDistanceField.js` — CPU vs WebGPU field twins (dist + taper weight, raw vs smoothed copies).
- `src/internal/gpuFieldCore.js` — shared TSL kernels: `FieldGrid`, `rasterizeField`, `blurFieldPass`.
- `src/gpuSigilize.js` — GPU/CPU Laplacian melt over mesh adjacency (default 36 passes).
- `src/sparseCurveGeometry.js` — curve-native strip mesher (preview path).
- `src/meshlessField.js` — GPU-resident field with a grow-only buffer pool (StorageBufferAttributes are not auto-freed; see `freeBuf`, `dispose(force)`).
- `src/tsl/chromeMaterial.js` — the chrome contract: peak displacement, analytic normal `normalize(-dH/dx,-dH/dy,1)`, metalness 1, PMREM env. `raymarchSigilMaterial.js` must match it byte-for-byte on shading.
- `src/strokePipeline.js` + `src/sigilDefaults.js` — stroke prep and the single source of defaults (`SIGIL_DEFAULTS`, `createSigilState`, `*OptionsFromState`). New params go here, not scattered.
- `src/bspline.js` — uniform B-spline sampling (clamped open / periodic closed) for Alias-style CV curves; feeds the normal pipeline as a polyline.
- `src/internal/paths.js` — input normalization (`toPathSet` accepts `[[x,y],…]`, `[{x,y},…]`, flat arrays, or arrays thereof).
- `examples/app.js` — mode registry (`realtime` = Freehand, default; `spline` = CV Curves; `meshless` = Raymarch); modes export `meta` + `mount(ctx, {panelRoot, infoRoot, state, strokes})` returning an unmount closure. State and strokes are shared across mode switches.
- `examples/modes/spline.js` — editable CV curves: click to place, drag any CV (committed ones too), first-CV click closes, dblclick/Enter commits. During a committed-CV drag the merged mesh hides and all curves render as strips; release triggers the merged rebuild.
- `examples/shared/` — demo context (WebGPURenderer + PMREM env), control panel, right-drag orbit (`orbit.js`), stroke session records (strokes capture their symmetry state at commit; spline records keep `cvs`/`closed` authoritative and re-sample via `updateSplineRecord`), GLB export.
- `docs/emblem-pipeline.md` — stage-by-stage parameter reference.

## Commands

```bash
npm install
npm run example          # vite dev server → http://localhost:5173/
npm test                 # standalone assert scripts (each prints "… OK")
```

Tests are plain assert scripts, **not** `node:test` — `node --test` will
misreport them; run files directly. GPU paths can't run in Node, so tests cover
CPU geometry invariants (solidify closure, mirror winding, stroke sessions,
GLB export, meshless constants). New CPU-side logic should get one.

## Conventions

- Plain ESM JavaScript with rich JSDoc (types in `src/index.d.ts`). No TypeScript, no build step for the lib — `src/` ships as-is.
- Zero runtime deps; `three >= 0.176` is a peer dependency. Import from `three`, `three/webgpu`, `three/tsl` as appropriate.
- Comments explain *why* (invariants, GPU/CPU matching, buffer lifetime rules) — the codebase leans on long header comments per file; keep that style.
- Options objects with `??` defaults everywhere; every knob documented in the function's JSDoc block.
- Geometry always carries the attribute contract (`aDepth`, `aGrad`, `aNormal`, `aDome`) so any material honoring it can replace the chrome.
- Dispose discipline: old geometries/materials are explicitly disposed on swap; version-counter guards (`rebuildVersion`) discard stale async builds.

## Roadmap / active intent

- **CV curve polish:** the mode ships with strip previews during CV drags; the
  meshless raymarch path (zero readback) is the natural next live view during
  manipulation, meshing on release. Possible follow-ups: CV insert/delete on a
  committed curve, per-CV weight.
- **Speed:** GPU dispatch batching landed (one computeAsync per build stage).
  The remaining commit-time cost is the single readback + CPU marching
  squares + solidify. Prefer keeping fields GPU-resident where possible.
- **Raymarch mode:** its real role is live manipulation + runtime-only
  generation (no export). Known scope limit: it matches field blur but not
  sigilize melt / heightSmooth (documented in `meshlessField.js`).
