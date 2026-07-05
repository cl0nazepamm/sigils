# Shape pipeline reference

How the **sigils** CPU path maps stroke controls to generated geometry.

## Stage mapping

| Stage | sigils module | Notes |
|---|---|---|
| Flatten to XY | `prepareStrokes` → `flattenPaths` | Default on; strips Z from 3D points |
| Stacked spiro copies | `stackRotatedCopies` / `opts.spiroCopies` | Repeat-zone style, before symmetry |
| Radial symmetry | `radialSymmetry` / `opts.symmetry` | Kaleidoscope copies around pivot |
| Resample | `resampleByLength` | Spacing ≈ `thickness × 0.12` |
| Reference cull | `cullPointsByReference` | Optional proximity gate |
| Distance field | `DistanceField` | Taper + optional smooth |
| Normalized iso | `isoThreshold × fieldRangeMax` | Default iso ≈ **0.555** |
| Filled marching squares | `fillRegion` | Sharp silhouette |
| Sigilize | `blurRegionPositions` | Mesh adjacency position melt |
| Boundary height | `applyBoundaryDepth` | Rim distance → `aDepth`; `relief: 'carve'` leaves the ramp unclamped |
| Height soften | `heightSmooth` | Blur on depth attribute |
| Solidify | `solidify` | Base + walls + dome attrs |
| Chrome shading | `createChromeMaterial` | TSL peak from `aDepth` |

## Quick API

```js
import { createSigil, emblemParamsToOptions, spirograph } from 'sigils';

const stroke = spirograph({ R: 7, r: 4, d: 6, radius: 1.2 });

const sigil = createSigil(stroke, {
  ...emblemParamsToOptions({
    lineThickness: 0.16,
    resolution: 320,
    SPIRO: 3,
    sigilize: 36,
    soften: 2,
    peakHeight: 300,
    peakHeightScale: 1000,
    extrudeBase: 0.08,
  }),
  profile: 'linear',
  roughness: 0.06,
});
```

## Parameter reference

| Control | Option | Default |
|---|---|---|
| Line thickness | `fieldRangeMax` / `thickness` | 6% of bounds |
| Iso threshold | `isoThreshold` | 0.555 (with `fieldRangeMax`) |
| Boundary falloff | `boundaryFalloffNorm` | 0.345 × range |
| Relief | `relief` / `reliefRange` | `carve`, cap 6 × falloff |
| Grid padding | `gridBuffer` | 1.5 × threshold |
| Spiro stack | `spiroCopies` / `SPIRO` in helper | 1 |
| Sigilize blur | `sigilize` | 0 |
| Height soften | `heightSmooth` / `soften` | 3 |
| Peak (large units) | `peakHeight / peakHeightScale` | scale 1000 |
| Shell depth | `base` / `extrudeBase` | 0 |

## JSON presets

See [`presets/emblem-default.json`](presets/emblem-default.json) for a machine-readable default parameter block.
