import type {
  Mesh,
  BufferGeometry,
  ColorRepresentation,
} from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';

export type Pt2 = [number, number];
export type Polyline = Pt2[];
/** One stroke or several. Loose inputs are normalized internally. */
export type PathInput =
  | number[]
  | Pt2[]
  | { x: number; y: number }[]
  | Array<number[] | Pt2[] | { x: number; y: number }[]>;

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
  /** Field grid cells across the largest dimension. @default 240 */
  resolution?: number;
  /** Stroke resample spacing. @default thickness*0.12 */
  resample?: number;
  /** Distance-field blur passes (smoothing). @default scales with resolution */
  smooth?: number;
  /** Point-position blur passes for a softer generated silhouette. @default 0 */
  sigilize?: number;
  /** Influence of each sigilize pass. @default 1 */
  sigilizeWeight?: number;
  /** Height field source. Boundary uses distance from the finished rim. @default 'boundary' */
  depthMode?: 'boundary' | 'centerline';
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
  /** Stacked rotational copies before radial symmetry (repeat-zone style). */
  spiroCopies?: number;
  /** Radians between stacked copies. @default TAU / spiroCopies */
  spiroAngleStep?: number;
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
  /** Extra curve width. @default 0 */
  spread?: number;
  /** Raised profile height in world units. @default 0.13 */
  peakHeight?: number;
  /** Stroke resample spacing. @default 0.03 */
  resample?: number;
  /** Polyline simplification tolerance. @default 0.006 */
  simplify?: number;
  /** Open-end taper length. @default 0.35 */
  taperLen?: number;
  /** Open-end taper exponent. @default 1.8 */
  taperPower?: number;
  /** Minimum half-width at open tips. @default 0.004 */
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
  fieldSigilize?: number;
  /** Melt influence per pass on the merged mesh. @default 0.75 */
  sigilizeWeight?: number;
  /** @deprecated Use sigilizeWeight */
  fieldBlendStrength?: number;
  /** When false, skip GPU SDF mesh and use sparse strips only. @default true for async */
  fieldMesh?: boolean;
  /** Normalized cross samples from -1 to 1. */
  profile?: number[];
}

export type SigilOptions = ShapeOptions & ChromeOptions;

export interface SigilState {
  minDrawStep: number;
  symmetry: number;
  mirror: boolean;
  phase: number;
  center: Pt2;
  thickness: number;
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
  mergeBlendScale: number;
  depthBlendScale: number;
  sigilize: number;
  sigilizeWeight: number;
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
    symmetry: number;
    mirror: boolean;
    phase: number;
    center: Pt2;
    thickness: number;
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
export function gpuSigilizePositions(
  renderer: WebGPURenderer,
  geometry: BufferGeometry,
  opts?: { iterations?: number; sigilize?: number; weight?: number; sigilizeWeight?: number; activeAttribute?: string },
): Promise<BufferGeometry>;
export function cpuSigilizePositions(
  geometry: BufferGeometry,
  iterations: number,
  weight?: number,
  activeAttribute?: string,
): BufferGeometry;
export function sigilizePositionsAsync(
  renderer: WebGPURenderer | null | undefined,
  geometry: BufferGeometry,
  opts?: { iterations?: number; sigilize?: number; weight?: number; sigilizeWeight?: number; activeAttribute?: string },
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
  },
): Promise<DistanceField>;

/**
 * Sample a uniform B-spline (Alias-style CV curve) into a polyline. Open
 * curves are clamped (pinned to the first/last CV); closed curves are
 * periodic. Degree adapts down when there are few CVs.
 */
export function bspline(
  cvs: Polyline,
  opts?: { closed?: boolean; degree?: number; samplesPerSpan?: number },
): Polyline;

export function spirograph(opts?: {
  R?: number;
  r?: number;
  d?: number;
  radius?: number;
  turns?: number;
  steps?: number;
}): Polyline;

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
  set: Polyline[];
  threshold: number;
  smooth: number;
  boundaryFalloff: number;
  fieldOpts: {
    resolution: number;
    margin: number;
    smooth: number;
    taper: number;
    taperPower: number;
  };
};

export function stackRotatedCopies(
  paths: PathInput,
  opts?: { copies?: number; center?: Pt2; angleStep?: number },
): Polyline[];

export function cullPointsByReference(
  set: Polyline[],
  reference: Pt2,
  minDistance: number,
): Polyline[];

export function emblemParamsToOptions(params?: {
  lineThickness?: number;
  thickness?: number;
  resolution?: number;
  spiroCopies?: number;
  SPIRO?: number;
  symmetry?: number;
  sigilize?: number;
  sigilizeWeight?: number;
  soften?: number;
  extrudeBase?: number;
  isoThreshold?: number;
  boundaryFalloffNorm?: number;
  gridBuffer?: number;
  referencePoint?: Pt2;
  referenceCullMin?: number;
  flatten?: boolean;
  depthMode?: 'boundary' | 'centerline';
  peakHeight?: number;
  peak?: number;
  peakHeightScale?: number;
}): ShapeOptions & Pick<ChromeOptions, 'peakHeight'>;

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
): {
  positions: Float32Array;
  depth: Float32Array;
  grad: Float32Array;
  indices: Uint32Array;
  boundary: Array<[number, number]>;
  count: number;
};

export function resampleByLength(poly: Polyline, step: number): Polyline;
export function toPolyline(path: PathInput): Polyline;
export function toPathSet(input: PathInput): Polyline[];
export function boundsOf(pathSet: Polyline[]): {
  minX: number; minY: number; maxX: number; maxY: number; width: number; height: number;
};
export function centroidOf(pathSet: Polyline[]): Pt2;
