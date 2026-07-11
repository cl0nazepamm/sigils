import type {
  Mesh,
  BufferGeometry,
  ColorRepresentation,
} from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';

export type Pt2 = [number, number];
export type Pt3 = [number, number, number];
/** 2D stroke point plus normalized half-width scale (enabled with pointRadius). */
export type Pt2Radius = [number, number, number];
/** 3D surface point plus normalized local half-width scale (enabled with pointRadius). */
export type Pt3Radius = [number, number, number, number];
export type Polyline = Pt2[];
export type RadiusPolyline = Pt2Radius[];
export type SurfacePolyline = Pt3[];
export type SurfaceRadiusPolyline = Pt3Radius[];
/** One stroke or several. Loose inputs are normalized internally. */
export type PathInput =
  | number[]
  | Pt2[]
  | Pt2Radius[]
  | { x: number; y: number }[]
  | Array<number[] | Pt2[] | Pt2Radius[] | { x: number; y: number }[]>;

export interface ShapeOptions {
  /** Radial symmetry copies. @default 1 */
  symmetry?: number;
  /** Global rotation applied to every copy, in radians. @default 0 */
  phase?: number;
  /** Also add mirrored copies (dihedral symmetry). @default false */
  mirror?: boolean;
  /** Symmetry pivot. Defaults to the stroke centroid. */
  center?: Pt2;
  /** Fat-stroke width in world units. @default 6% of the bounds */
  thickness?: number;
  /** Interpret point[2] as a normalized local half-width scale. @default false */
  pointRadius?: boolean;
  /** Field grid cells across the largest dimension. @default 240 */
  resolution?: number;
  /** Stroke resample spacing. @default thickness*0.12 */
  resample?: number;
  /** Distance-field blur passes (smoothing). @default scales with resolution */
  smooth?: number;
  /** Laplacian mesh-adjacency position-smooth passes. @default 0 */
  laplacian?: number;
  /** Influence of each laplacian pass. @default 1 */
  laplacianWeight?: number;
  /** Height field source. Boundary uses distance from the finished rim. @default 'boundary' */
  depthMode?: 'boundary' | 'centerline';
  /**
   * Boundary depth profile. Plateau clamps depth at 1 once edgeFalloff is
   * reached; carve keeps rising with rim distance so wide junctions become
   * smooth peaks with sharp medial ridges (CNC V-carve style). @default 'plateau'
   */
  relief?: 'plateau' | 'carve' | 'round';
  /** Carve depth cap in multiples of edgeFalloff. @default 6 */
  reliefRange?: number;
  /** Boundary distance that reaches full height. @default thickness*0.5 */
  edgeFalloff?: number;
  /** Extra blur passes on the generated height/depth attribute. @default smooth */
  heightSmooth?: number;
  /** Influence of each height blur pass on the baked depth field. @default 0.5 */
  heightSmoothWeight?: number;
  /** fieldSmooth divisor for fill implicit raw/smoothed blend. @default 8 */
  fieldMergeBlendScale?: number;
  /** fieldSmooth divisor for boundary depth raw/smoothed blend. @default 6 */
  fieldDepthBlendScale?: number;
  /** Iso cutoff on a normalized 0..1 field (used with fieldRangeMax). */
  isoThreshold?: number;
  /** World distance mapped to field value 1.0 (line thickness). */
  fieldRangeMax?: number;
  /** Boundary rim falloff in world units. */
  boundaryFalloff?: number;
  /** Boundary falloff as a fraction of fieldRangeMax. */
  boundaryFalloffNorm?: number;
  /** Grid margin beyond the stroke bounds. */
  gridBuffer?: number;
  /** Grid margin as a multiple of the threshold when gridBuffer is unset. @default 1.5 */
  gridBufferFactor?: number;
  /** Field grid cells across the largest dimension, preferred by resident field builds. */
  fieldResolution?: number;
  /** Optional reference position for point culling. */
  referencePoint?: Pt2;
  /** Keep stroke points with distance greater than this value. */
  referenceCullMin?: number;
  /** Squash 3D points to XY before processing. @default true */
  flatten?: boolean;
  /** Solid base depth; 0 = open shell (top surface only). @default 0 */
  base?: number;
  /** Distance-field backend. Async builds can use WebGPU compute. @default 'cpu' */
  fieldBackend?: 'cpu' | 'gpu' | 'hybrid';
  /** Required for async WebGPU distance-field builds. */
  renderer?: WebGPURenderer;
  /** Called when async GPU field generation falls back to CPU. */
  onGpuFallback?: (error: Error) => void;
}

export interface ChromeOptions {
  /** Bulge height in world units (live uniform). @default 0.4 */
  peakHeight?: number;
  /** 0 = perfect mirror (live uniform). @default 0.08 */
  roughness?: number;
  /** @default 1 */
  metalness?: number;
  /** Reflectance tint. @default 0xffffff */
  color?: ColorRepresentation;
  /** @default 1.5 */
  envMapIntensity?: number;
  /** Height profile. Linear follows baked boundary depth; round is tube-like. @default 'linear' */
  profile?: 'linear' | 'round';
}

export interface SparseCurveOptions {
  /** Radial symmetry copies. @default 1 */
  symmetry?: number;
  /** Global rotation applied to every copy, in radians. @default 0 */
  phase?: number;
  /** Also add mirrored copies. @default false */
  mirror?: boolean;
  /** Symmetry pivot. @default [0,0] */
  center?: Pt2;
  /** Curve width in world units. @default 0.07 */
  thickness?: number;
  /** Interpret point[2] as a normalized local half-width scale. @default false */
  pointRadius?: boolean;
  /** Extra curve width. @default 0 */
  spread?: number;
  /** Raised profile height in world units. @default 0.13 */
  peakHeight?: number;
  /** Stroke resample spacing. @default 0.03 */
  resample?: number;
  /** Polyline simplification tolerance. @default 0.006 */
  simplify?: number;
  /**
   * Field-style open-end blend (0 = round caps, 1 = tip to a point).
   * Prefer this over `taperLen` so strips match the SDF mesh.
   */
  taper?: number;
  /** Legacy tip taper length when `taper` is omitted. @default 0.35 */
  taperLen?: number;
  /** Open-end taper exponent. @default 0.6 with `taper`, 1.8 with `taperLen` */
  taperPower?: number;
  /** Minimum half-width at open tips. @default 0 with `taper`, 0.004 with `taperLen` */
  tipRadius?: number;
  /** Height falloff from center to rim. @default 1 */
  ridgePower?: number;
  /** Rim rounding width in normalized profile units. @default 0.12 */
  bevel?: number;
  /** Height blur iterations before normal generation. @default 0 */
  heightSmooth?: number;
  /** Height blur influence per pass. @default 1 */
  heightSmoothWeight?: number;
  /** Flat underside depth; 0 disables side/base triangles. @default 0.018 */
  baseDepth?: number;
  /** Grid resolution for GPU SDF merge. @default 220 */
  fieldResolution?: number;
  /** GPU blur passes on the SDF before marching squares. @default 4 */
  fieldSmooth?: number;
  /** Position-melt passes on the filled mesh. @default 36 */
  fieldLaplacian?: number;
  /** Melt influence per pass on the merged mesh. @default 0.75 */
  laplacianWeight?: number;
  /** @deprecated Use laplacianWeight */
  fieldBlendStrength?: number;
  /** When false, skip GPU SDF mesh and use sparse strips only. @default true for async */
  fieldMesh?: boolean;
  /** Called when async GPU mesh generation falls back to the CPU mesh path. */
  onGpuFallback?: (error: Error) => void;
  /** Normalized cross samples from -1 to 1. */
  profile?: number[];
}

export type SigilOptions = ShapeOptions & ChromeOptions;
export type DrawTool = 'freehand' | 'spline';

export interface SigilState {
  minDrawStep: number;
  drawTool: DrawTool;
  symmetry: number;
  mirror: boolean;
  phase: number;
  center: Pt2;
  thickness: number;
  cvRadiusScale: number;
  showActiveCvs: boolean;
  guides: boolean;
  previewStripOnly: boolean;
  orthographic: boolean;
  backend: 'hybrid' | 'cpu';
  resolution: number;
  smooth: number;
  taper: number;
  taperPower: number;
  edgeFalloffNorm: number;
  base: number;
  resample: number | null;
  resampleFactor: number;
  gridBuffer: number | null;
  gridBufferFactor: number;
  depthMode: 'boundary' | 'centerline';
  relief: 'plateau' | 'carve';
  reliefRange: number;
  mergeBlendScale: number;
  depthBlendScale: number;
  laplacian: number;
  laplacianWeight: number;
  heightSmooth: number;
  heightSmoothWeight: number;
  taperLen: number;
  previewTaperPower: number;
  tipRadius: number;
  ridgePower: number;
  bevel: number;
  previewHeightSmooth: number;
  previewHeightSmoothWeight: number;
  previewResample: number;
  simplify: number;
  spread: number;
  peak: number;
  roughness: number;
  metalness: number;
  profile: 'linear' | 'round';
  color: ColorRepresentation;
  envMapIntensity: number;
}

export const SIGIL_DEFAULTS: {
  interaction: { minDrawStep: number };
  stroke: {
    drawTool: DrawTool;
    symmetry: number;
    mirror: boolean;
    phase: number;
    center: Pt2;
    thickness: number;
    cvRadiusScale: number;
    showActiveCvs: boolean;
    guides: boolean;
    previewStripOnly: boolean;
    orthographic: boolean;
  };
  field: Record<string, number | string>;
  melt: Record<string, number>;
  preview: Record<string, number>;
  surface: Record<string, number | string>;
};

export function createSigilState(overrides?: Partial<SigilState>): SigilState;
export function createDrawDemoState(overrides?: Partial<SigilState>): SigilState;
export const DRAW_DEMO_DEFAULTS: Partial<SigilState> & {
  center: Pt2;
  resolution: number;
  minDrawStep: number;
};
export function shapeOptionsFromState(state: SigilState): ShapeOptions;
export function sparsePreviewOptionsFromState(state: SigilState): SparseCurveOptions;
export function chromeOptionsFromState(state: SigilState): ChromeOptions;

export interface ChromeNodeMaterial extends MeshStandardNodeMaterial {
  sigilUniforms: { peakHeight: any; roughness: any };
}

export interface SigilMesh extends Mesh {
  material: ChromeNodeMaterial;
  userData: {
    sigil: {
      material: ChromeNodeMaterial;
      uniforms: ChromeNodeMaterial['sigilUniforms'];
      rebuild(paths?: PathInput, opts?: SigilOptions): SigilMesh;
      rebuildAsync(paths?: PathInput, opts?: SigilOptions): Promise<SigilMesh>;
    };
  };
}

export function createSigil(paths: PathInput, opts?: SigilOptions): SigilMesh;
export function createSigilAsync(paths: PathInput, opts?: SigilOptions): Promise<SigilMesh>;
export function mergedSigilShapeOptions(overrides?: ShapeOptions): ShapeOptions;
export function realtimeMergedShapeOptions(overrides?: ShapeOptions): ShapeOptions;
export const DRAW_MERGE_RESOLUTION: number;
export const REALTIME_MERGE_RESOLUTION: number;

export function buildSigilGeometry(paths: PathInput, opts?: ShapeOptions): BufferGeometry;
export function buildSigilGeometryAsync(paths: PathInput, opts?: ShapeOptions): Promise<BufferGeometry>;
export function buildSparseCurveGeometry(paths: PathInput, opts?: SparseCurveOptions): BufferGeometry;
export function buildSparseCurveGeometryAsync(
  renderer: WebGPURenderer,
  paths: PathInput,
  opts?: SparseCurveOptions,
): Promise<BufferGeometry>;
export function finishSigilGeometryFromField(field: object, opts?: ShapeOptions): BufferGeometry;
export function finishSigilGeometryFromFieldAsync(field: object, opts?: ShapeOptions): Promise<BufferGeometry>;
export function buildGpuFieldMeshAsync(
  renderer: WebGPURenderer,
  paths: PathInput,
  opts?: SparseCurveOptions,
): Promise<BufferGeometry>;
export function buildGpuBlurredField(
  renderer: WebGPURenderer,
  paths: PathInput,
  opts?: SparseCurveOptions,
): Promise<object | null>;
export function gpuLaplacianPositions(
  renderer: WebGPURenderer,
  geometry: BufferGeometry,
  opts?: { iterations?: number; laplacian?: number; weight?: number; laplacianWeight?: number; activeAttribute?: string },
): Promise<BufferGeometry>;
export function cpuLaplacianPositions(
  geometry: BufferGeometry,
  iterations: number,
  weight?: number,
  activeAttribute?: string,
): BufferGeometry;
export function laplacianPositionsAsync(
  renderer: WebGPURenderer | null | undefined,
  geometry: BufferGeometry,
  opts?: { iterations?: number; laplacian?: number; weight?: number; laplacianWeight?: number; activeAttribute?: string },
): Promise<BufferGeometry>;
export function buildGpuDistanceField(
  renderer: WebGPURenderer,
  paths: PathInput,
  opts?: {
    resolution?: number;
    margin?: number;
    smooth?: number;
    taper?: number;
    taperPower?: number;
    pointRadius?: boolean;
  },
): Promise<DistanceField>;

/**
 * Sample a uniform B-spline (Alias-style CV curve) into a polyline. Open
 * curves are clamped (pinned to the first/last CV); closed curves are
 * periodic. Degree adapts down when there are few CVs.
 */
export function bspline(
  cvs: Polyline,
  opts: { closed?: boolean; degree?: number; samplesPerSpan?: number; radiusScales: ArrayLike<number> },
): RadiusPolyline;
export function bspline(
  cvs: Polyline,
  opts?: { closed?: boolean; degree?: number; samplesPerSpan?: number; radiusScales?: null },
): Polyline;
export function bspline(
  cvs: SurfacePolyline,
  opts: { closed?: boolean; degree?: number; samplesPerSpan?: number; radiusScales: ArrayLike<number> },
): SurfaceRadiusPolyline;
export function bspline(
  cvs: SurfacePolyline,
  opts?: { closed?: boolean; degree?: number; samplesPerSpan?: number; radiusScales?: null },
): SurfacePolyline;

export function createChromeMaterial(opts?: ChromeOptions): ChromeNodeMaterial;
export function updateChromeMaterial(
  material: ChromeNodeMaterial,
  opts?: { peakHeight?: number; roughness?: number; envMapIntensity?: number },
): void;

export function radialSymmetry(
  paths: PathInput,
  opts?: { symmetry?: number; center?: Pt2; phase?: number; mirror?: boolean },
): Polyline[];

export function prepareStrokes(
  paths: PathInput,
  opts?: ShapeOptions,
): {
  set: Array<Polyline | RadiusPolyline>;
  threshold: number;
  smooth: number;
  boundaryFalloff: number;
  fieldOpts: {
    resolution: number;
    margin: number;
    smooth: number;
    taper: number;
    taperPower: number;
    pointRadius: boolean;
  };
};

export function cullPointsByReference(
  set: Polyline[],
  reference: Pt2,
  minDistance: number,
): Polyline[];

export function resolveFieldThreshold(
  opts: Pick<ShapeOptions, 'isoThreshold' | 'fieldRangeMax' | 'thickness'>,
  fallbackSize: number,
): number;

export function resolveBoundaryFalloff(
  opts: Pick<ShapeOptions, 'edgeFalloff' | 'boundaryFalloff' | 'boundaryFalloffNorm' | 'fieldRangeMax'>,
  threshold: number,
): number;

export class DistanceField {
  constructor(paths: PathInput, opts?: {
    resolution?: number;
    margin?: number;
    smooth?: number;
    taper?: number;
    taperPower?: number;
    pointRadius?: boolean;
  });
  width: number;
  height: number;
  cell: number;
  minX: number;
  minY: number;
  dist: Float32Array;
  weight: Float32Array;
  distS: Float32Array;
  weightS: Float32Array;
  sample(x: number, y: number): number;
  sampleWeight(x: number, y: number): number;
  depth(x: number, y: number, threshold: number): number;
  depthGradient(x: number, y: number, threshold: number, h: number): Pt2;
  implicitAt(i: number, j: number, threshold: number): number;
  distAt(i: number, j: number): number;
}

export function fillRegion(
  field: DistanceField,
  threshold: number,
  fieldSmooth?: number,
  mergeBlendScale?: number,
  sampleDepth?: boolean,
): {
  positions: Float32Array;
  depth: Float32Array;
  grad: Float32Array;
  indices: Uint32Array;
  boundary: Array<[number, number]>;
  count: number;
};

export function resampleByLength(poly: RadiusPolyline, step: number): RadiusPolyline;
export function resampleByLength(poly: Polyline, step: number): Polyline;
export function toPolyline(path: PathInput, opts: { pointRadius: true }): RadiusPolyline;
export function toPolyline(path: PathInput, opts?: { pointRadius?: false; preserveTrailing?: boolean }): Polyline;
export function toPathSet(input: PathInput, opts: { pointRadius: true }): RadiusPolyline[];
export function toPathSet(input: PathInput, opts?: { pointRadius?: false; preserveTrailing?: boolean }): Polyline[];
export function boundsOf(pathSet: Polyline[]): {
  minX: number; minY: number; maxX: number; maxY: number; width: number; height: number;
};
export function centroidOf(pathSet: Polyline[]): Pt2;

export interface SurfaceSigilOptions {
  /** Fat-stroke width in world units. @default 0.1 */
  thickness?: number;
  /** Interpret each surface path point as [x,y,z,radiusScale]. @default false */
  pointRadius?: boolean;
  /** Join each path's last point to its first without an explicit seam sample. @default false */
  closed?: boolean;
  /** Rim distance reaching depth 1. @default thickness*0.5 */
  edgeFalloff?: number;
  /** Boundary depth profile on the surface. @default 'carve' */
  relief?: 'plateau' | 'carve' | 'round';
  /** Carve depth cap in falloff units. @default 6 */
  reliefRange?: number;
  /** Displacement along the surface normal at depth 1. @default 0.05 */
  peakHeight?: number;
  /** Pull into the mesh along −normal, as a fraction of peakHeight. @default 0 */
  conform?: number;
  /** Seam-safe scalar relief smoothing passes. @default 12 */
  laplacian?: number;
  /** Melt influence per pass. @default 0.75 */
  laplacianWeight?: number;
  /** Depth blur passes, rim pinned. @default 2 */
  heightSmooth?: number;
  /** Depth blur influence per pass. @default 0.5 */
  heightSmoothWeight?: number;
  /** Brush-relative stroke-field precision multiplier. @default 1 */
  fieldResolution?: number;
  /** Open-end taper length in half-width units. 0 disables taper. @default 0 */
  taper?: number;
  /** Open-end taper profile exponent. @default 1 */
  taperPower?: number;
  /** Liquid shading-normal polish passes. @default 0 */
  normalSmooth?: number;
  /** Reusable target index; avoids rebuilding the dense-mesh broad phase. */
  meshIndex?: MeshIndex;
}

export type SurfacePathInput =
  | SurfacePolyline
  | SurfacePolyline[]
  | SurfaceRadiusPolyline
  | SurfaceRadiusPolyline[];

export const SURFACE_SIGIL_DEFAULTS: Readonly<{
  thickness: number;
  relief: 'carve';
  reliefRange: number;
  peakHeight: number;
  laplacian: number;
  laplacianWeight: number;
  heightSmooth: number;
  heightSmoothWeight: number;
  fieldResolution: number;
  taper: number;
  taperPower: number;
  normalSmooth: number;
  pointRadius: boolean;
  closed: boolean;
}>;

/** Grow a sigil fill directly on a target mesh from strokes painted on its surface. */
export function buildSurfaceSigilGeometry(
  target: BufferGeometry,
  strokes: SurfacePathInput,
  opts?: SurfaceSigilOptions,
): BufferGeometry;

/** A stroke point conformed to a surface: position + outward unit normal. */
export interface SurfaceSample {
  /** Position, optionally packing radiusScale as its fourth channel. */
  p: Pt3 | Pt3Radius;
  n: Pt3;
  /** Normalized local half-width/height multiplier. Missing values are uniform at 1. */
  radiusScale?: number;
}

export interface SurfaceVineStroke {
  /** Surface-conformed centerline; radiusScale is interpolated per segment. */
  samples: SurfaceSample[];
  /** Deterministic thorn/wobble seed. */
  seed?: number;
  /** Per-stroke closure; overrides the field-level closed option. */
  closed?: boolean;
}

export interface SurfaceVineOptions {
  /** Base lateral half-width; multiplied by each sample's radiusScale. @default 0.03 */
  radius?: number;
  /** Base section height off the skin; also multiplied by radiusScale. @default radius*1.5 */
  peak?: number;
  /** Section shape: peaked ridge, flat band, or elliptical wire. @default 'round' */
  relief?: 'carve' | 'plateau' | 'round';
  /** Organic section undulation, 0..1. @default 0.35 */
  wobble?: number;
  /** Section-corner rounding, 0..1 — the molten field look. @default 0 */
  melt?: number;
  /** Tip taper length, in ornament units (max(radius, peak*0.75)). @default 3 */
  taper?: number;
  /** Tip profile exponent: <1 blunt, >1 needle. @default 0.72 */
  taperPower?: number;
  /** Arc distance between thorns, in ornament units. 0 disables thorns. @default 0 */
  thornSpacing?: number;
  /** Thorn length, in ornament units. @default 3 */
  thornLength?: number;
  /** Pull whole section into the mesh along −normal, as a fraction of peak. @default 0 */
  conform?: number;
  /** RNG seed for thorn placement / wobble phases. @default 1 */
  seed?: number;
  /** Join the last sample to the first without open-end taper caps. @default false */
  closed?: boolean;
}

/**
 * Sweep a surface-conformed stroke into a tapered chrome vine with pointed
 * tips and procedural thorn offshoots. Deterministic for a given seed.
 * Fast and un-welded — the live-preview builder.
 */
export function buildSurfaceVineGeometry(
  samples: SurfaceSample[],
  opts?: SurfaceVineOptions,
): BufferGeometry;

export interface SurfaceVineFieldOptions extends SurfaceVineOptions {
  /** Smooth-min weld softness at crossings, in ornament units. @default 0.9 */
  blend?: number;
  /** Grid cells across the smallest full section axis. @default 3.2 */
  detail?: number;
  /** Soft cap on shell cells ≈ output verts; extreme sections coarsen and
   * fatten gracefully to stay inside it. @default 100000 */
  cellBudget?: number;
}

/**
 * Volume-style union of many vines: tubes and thorns become round-cone SDFs,
 * smooth-min blended, and the iso-surface is extracted with sparse surface
 * nets. Crossing strokes weld into one continuous chrome body.
 */
export function buildSurfaceVineFieldGeometry(
  strokes: SurfaceVineStroke[],
  opts?: SurfaceVineFieldOptions,
): BufferGeometry;

export interface MeshIndex {
  /** Closest surface point within `maxDist` of (x, y, z), or null. */
  closestPoint(
    x: number,
    y: number,
    z: number,
    maxDist: number,
    opts?: { normal?: [number, number, number]; minNormalDot?: number },
  ): {
    point: [number, number, number];
    normal: [number, number, number];
    distance: number;
  } | null;
  /** Conservative triangle candidates inside a capsule around a segment. */
  trianglesNearSegment(
    a: [number, number, number],
    b: [number, number, number],
    radius: number,
  ): number[];
  triangleCount: number;
}

/**
 * Uniform-grid triangle index for fast closest-point queries against a mesh
 * (built once in O(tris); queries only touch nearby cells).
 */
export function createMeshIndex(
  geometry: BufferGeometry,
  opts?: { cellsPerAxis?: number },
): MeshIndex;
