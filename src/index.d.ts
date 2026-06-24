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
  /** point-position point-position blur passes. @default 0 */
  sigilize?: number;
  /** Influence of each sigilize pass. @default 1 */
  sigilizeWeight?: number;
  /** Height field source. Boundary matches the default shape profile. @default 'boundary' */
  depthMode?: 'boundary' | 'centerline';
  /** Boundary distance that reaches full height. @default thickness*0.5 */
  edgeFalloff?: number;
  /** Extra blur passes on the generated height/depth attribute. @default smooth */
  heightSmooth?: number;
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
  /** Height profile. Linear matches the default shape profile. @default 'linear' */
  profile?: 'linear' | 'round';
}

export type SigilOptions = ShapeOptions & ChromeOptions;

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

export function buildSigilGeometry(paths: PathInput, opts?: ShapeOptions): BufferGeometry;
export function buildSigilGeometryAsync(paths: PathInput, opts?: ShapeOptions): Promise<BufferGeometry>;
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
  opts?: { peakHeight?: number; roughness?: number },
): void;

export function radialSymmetry(
  paths: PathInput,
  opts?: { symmetry?: number; center?: Pt2; phase?: number; mirror?: boolean },
): Polyline[];

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
