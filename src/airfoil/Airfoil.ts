import { generateNACA4, formatNACA4, DEFAULT_CONTROL_SURFACES } from "./NACA";
import type { ControlSurfaceParams } from "./NACA";
import { generateShape, pivotFrac, referenceLength } from "./Shapes";
import type { ShapeKind } from "./Shapes";
import type { Vec2 } from "../gl/math";
import { add, sub, rotate, normalize, length, clamp } from "../gl/math";

export interface AirfoilParams {
  shape: ShapeKind;
  maxCamberPct: number;
  camberPosTenths: number;
  thicknessPct: number;
  /** Chord length as a fraction of the grid width (0..1). */
  chordFrac: number;
  /** Angle of attack in degrees. Positive = nose up (generates positive lift). */
  aoaDeg: number;
  /** Pitch-axis position as a fraction of grid dimensions (0..1 each). */
  posXFrac: number;
  posYFrac: number;
  /** Leading-edge slat and trailing-edge flap/aileron deflections (NACA only). */
  controlSurfaces: ControlSurfaceParams;
}

export type AirfoilParamsPatch = Partial<Omit<AirfoilParams, "controlSurfaces">> & {
  controlSurfaces?: Partial<ControlSurfaceParams>;
};

export const AOA_MIN_DEG = -90;
export const AOA_MAX_DEG = 90;

export const SLAT_MIN_DEG = 0;
export const SLAT_MAX_DEG = 30;
export const FLAP_MIN_DEG = -10;
export const FLAP_MAX_DEG = 40;
export const AILERON_MIN_DEG = -25;
export const AILERON_MAX_DEG = 25;

/** Keep the body this many grid cells clear of the inlet column and tunnel walls. */
const WALL_MARGIN = 8;

export interface SurfaceSample {
  /** World-space (grid texel) midpoint of this surface segment. */
  point: Vec2;
  /** Outward-pointing unit normal. */
  normal: Vec2;
  /** Segment length in grid texels. */
  length: number;
}

export const DEFAULT_AIRFOIL_PARAMS: AirfoilParams = {
  shape: "naca",
  maxCamberPct: 2,
  camberPosTenths: 4,
  thicknessPct: 12,
  chordFrac: 0.25,
  aoaDeg: 5,
  posXFrac: 0.32,
  posYFrac: 0.5,
  controlSurfaces: { ...DEFAULT_CONTROL_SURFACES },
};

const NUM_SURFACE_POINTS = 100;

/** Params whose change requires regenerating the local outline (vs. just re-placing it). */
const SHAPE_KEYS = ["shape", "maxCamberPct", "camberPosTenths", "thicknessPct", "chordFrac"] as const;

/**
 * Owns the body's geometric state and derives world-space (grid-texel-space)
 * geometry from it: the local outline is regenerated whenever shape
 * parameters change, then rotated about the pitch axis (quarter chord for
 * airfoils and plates, center for round bodies) and translated into the
 * simulation grid.
 */
export class Airfoil {
  params: AirfoilParams;
  private gridW: number;
  private gridH: number;
  private localPolygon: Vec2[] = [];
  private worldPolygon: Vec2[] = [];
  private surfaceSamples: SurfaceSample[] = [];
  /** Bumped whenever world geometry changes, so dependents (mask, force sampler, outline) know to rebuild. */
  version = 0;

  constructor(gridW: number, gridH: number, params: AirfoilParams = DEFAULT_AIRFOIL_PARAMS) {
    this.gridW = gridW;
    this.gridH = gridH;
    this.params = { ...params, controlSurfaces: { ...params.controlSurfaces } };
    this.regenerateLocal();
    this.rebuildWorldGeometry();
  }

  private chord(): number {
    return this.params.chordFrac * this.gridW;
  }

  setParams(partial: AirfoilParamsPatch): void {
    const { controlSurfaces: csPartial, ...given } = partial;
    const rest = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) as typeof given;
    if (rest.aoaDeg !== undefined) rest.aoaDeg = clamp(rest.aoaDeg, AOA_MIN_DEG, AOA_MAX_DEG);

    let shapeChanged = SHAPE_KEYS.some((k) => rest[k] !== undefined && rest[k] !== this.params[k]);
    let changed = shapeChanged || (Object.keys(rest) as (keyof typeof rest)[]).some((k) => rest[k] !== this.params[k]);
    if (csPartial) {
      const cs = this.params.controlSurfaces;
      const csChanged = (Object.keys(csPartial) as (keyof ControlSurfaceParams)[]).some(
        (k) => csPartial[k] !== undefined && csPartial[k] !== cs[k]
      );
      // Control surfaces only exist on the NACA outline.
      if (csChanged && (rest.shape ?? this.params.shape) === "naca") shapeChanged = true;
      changed ||= csChanged;
    }
    if (!changed) return;

    Object.assign(this.params, rest);
    if (csPartial) Object.assign(this.params.controlSurfaces, csPartial);
    if (shapeChanged) this.regenerateLocal();
    this.rebuildWorldGeometry();
  }

  /** Current designation, e.g. "2412", or null for non-NACA shapes. */
  nacaCode(): string | null {
    const p = this.params;
    return p.shape === "naca" ? formatNACA4(p.maxCamberPct, p.camberPosTenths, p.thicknessPct) : null;
  }

  private regenerateLocal(): void {
    const p = this.params;
    this.localPolygon =
      p.shape === "naca"
        ? generateNACA4({
            maxCamberPct: p.maxCamberPct,
            camberPosTenths: p.camberPosTenths,
            thicknessPct: p.thicknessPct,
            chord: this.chord(),
            numPoints: NUM_SURFACE_POINTS,
            controlSurfaces: p.controlSurfaces,
          }).polygon
        : generateShape(p.shape, this.chord(), p.thicknessPct);
  }

  private rebuildWorldGeometry(): void {
    const pivot: Vec2 = { x: pivotFrac(this.params.shape) * this.chord(), y: 0 };
    const aoaRad = (-this.params.aoaDeg * Math.PI) / 180; // negative: nose-up rotates flow onto the lower surface
    const rotated = this.localPolygon.map((p) => rotate(sub(p, pivot), aoaRad));

    // Keep the whole body inside the tunnel: clamp the pitch-axis position
    // so the rotated outline's bounding box stays clear of the inlet and
    // walls (centering it if it can't fit at all), and write the clamped
    // position back so the UI reflects where the body actually is.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of rotated) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const fit = (pos: number, lo: number, hi: number, size: number) =>
      hi - lo <= size - 2 * WALL_MARGIN ? clamp(pos, WALL_MARGIN - lo, size - WALL_MARGIN - hi) : (size - lo - hi) / 2;
    const ox = fit(this.params.posXFrac * this.gridW, minX, maxX, this.gridW);
    const oy = fit(this.params.posYFrac * this.gridH, minY, maxY, this.gridH);
    this.params.posXFrac = ox / this.gridW;
    this.params.posYFrac = oy / this.gridH;

    const offset: Vec2 = { x: ox, y: oy };
    this.worldPolygon = rotated.map((p) => add(p, offset));
    this.surfaceSamples = this.computeSurfaceSamples(this.worldPolygon);
    this.version++;
  }

  private computeSurfaceSamples(polygon: Vec2[]): SurfaceSample[] {
    const n = polygon.length;
    // Outward normals from the winding direction (sign of the polygon's
    // area), not "away from the centroid": that test is ambiguous near a
    // thin trailing edge or on a deflected flap, where the vector from the
    // centroid runs almost parallel to the surface.
    let area2 = 0;
    for (let i = 0; i < n; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % n];
      area2 += a.x * b.y - b.x * a.y;
    }
    const outwardSign = area2 >= 0 ? 1 : -1;

    const samples: SurfaceSample[] = [];
    for (let i = 0; i < n; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % n];
      const edge = sub(b, a);
      const segLen = length(edge);
      if (segLen < 1e-6) continue;
      // Right-hand perpendicular of a counter-clockwise edge points outward.
      const normal = normalize({ x: edge.y * outwardSign, y: -edge.x * outwardSign });
      samples.push({ point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, normal, length: segLen });
    }
    return samples;
  }

  getWorldPolygon(): Vec2[] {
    return this.worldPolygon;
  }

  getSurfaceSamples(): SurfaceSample[] {
    return this.surfaceSamples;
  }

  /** Pitch axis in world space: the rotation center, force-arrow anchor and moment reference. */
  getPivotWorld(): Vec2 {
    return { x: this.params.posXFrac * this.gridW, y: this.params.posYFrac * this.gridH };
  }

  getChordLength(): number {
    return this.chord();
  }

  /** Length that force/moment coefficients are normalized by. */
  getReferenceLength(): number {
    return referenceLength(this.params.shape, this.chord());
  }
}
