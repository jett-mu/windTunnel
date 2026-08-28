import { generateNACA4, DEFAULT_CONTROL_SURFACES } from "./NACA";
import type { NACAGeometry, ControlSurfaceParams } from "./NACA";
import type { Vec2 } from "../gl/math";
import { add, sub, rotate, perp, normalize, scale, length } from "../gl/math";

export interface AirfoilParams {
  maxCamberPct: number;
  camberPosTenths: number;
  thicknessPct: number;
  /** Chord length as a fraction of the grid width (0..1). */
  chordFrac: number;
  /** Angle of attack in degrees. Positive = nose up (generates positive lift). */
  aoaDeg: number;
  /** Airfoil position as a fraction of grid dimensions (0..1 each). */
  posXFrac: number;
  posYFrac: number;
  /** Leading-edge slat and trailing-edge flap/aileron deflections. */
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

export interface SurfaceSample {
  /** World-space (grid texel) midpoint of this surface segment. */
  point: Vec2;
  /** Outward-pointing unit normal. */
  normal: Vec2;
  /** Segment length in grid texels. */
  length: number;
}

export const DEFAULT_AIRFOIL_PARAMS: AirfoilParams = {
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

/**
 * Owns the airfoil's geometric state and derives world-space (grid-texel-space)
 * geometry from it: the local NACA point cloud is regenerated whenever shape
 * parameters change, then rotated about the quarter-chord point (the
 * conventional pitch axis) and translated into the simulation grid.
 */
export class Airfoil {
  params: AirfoilParams;
  private gridW: number;
  private gridH: number;
  private localGeometry: NACAGeometry;
  private worldPolygon: Vec2[] = [];
  private surfaceSamples: SurfaceSample[] = [];
  /** Bumped whenever geometry changes, so dependents (mask, force sampler) know to rebuild. */
  version = 0;

  constructor(gridW: number, gridH: number, params: AirfoilParams = DEFAULT_AIRFOIL_PARAMS) {
    this.gridW = gridW;
    this.gridH = gridH;
    this.params = { ...params, controlSurfaces: { ...params.controlSurfaces } };
    this.localGeometry = generateNACA4({
      maxCamberPct: this.params.maxCamberPct,
      camberPosTenths: this.params.camberPosTenths,
      thicknessPct: this.params.thicknessPct,
      chord: this.chord(),
      numPoints: NUM_SURFACE_POINTS,
      controlSurfaces: this.params.controlSurfaces,
    });
    this.rebuildWorldGeometry();
  }

  private chord(): number {
    return this.params.chordFrac * this.gridW;
  }

  setParams(partial: AirfoilParamsPatch): void {
    const { controlSurfaces: csPartial, ...rest } = partial;
    const shapeChanged =
      (rest.maxCamberPct !== undefined && rest.maxCamberPct !== this.params.maxCamberPct) ||
      (rest.camberPosTenths !== undefined && rest.camberPosTenths !== this.params.camberPosTenths) ||
      (rest.thicknessPct !== undefined && rest.thicknessPct !== this.params.thicknessPct) ||
      (rest.chordFrac !== undefined && rest.chordFrac !== this.params.chordFrac) ||
      csPartial !== undefined;

    Object.assign(this.params, rest);
    if (csPartial !== undefined) {
      Object.assign(this.params.controlSurfaces, csPartial);
    }
    if (rest.aoaDeg !== undefined) {
      this.params.aoaDeg = Math.min(AOA_MAX_DEG, Math.max(AOA_MIN_DEG, this.params.aoaDeg));
    }

    if (shapeChanged) {
      this.localGeometry = generateNACA4({
        maxCamberPct: this.params.maxCamberPct,
        camberPosTenths: this.params.camberPosTenths,
        thicknessPct: this.params.thicknessPct,
        chord: this.chord(),
        numPoints: NUM_SURFACE_POINTS,
        controlSurfaces: this.params.controlSurfaces,
      });
    }
    this.rebuildWorldGeometry();
  }

  private rebuildWorldGeometry(): void {
    const chord = this.chord();
    const pivot: Vec2 = { x: 0.25 * chord, y: 0 };
    const aoaRad = (-this.params.aoaDeg * Math.PI) / 180; // negative: nose-up rotates flow onto the lower surface
    const worldOffset: Vec2 = {
      x: this.params.posXFrac * this.gridW,
      y: this.params.posYFrac * this.gridH,
    };

    const toWorld = (p: Vec2): Vec2 => add(rotate(sub(p, pivot), aoaRad), worldOffset);

    this.worldPolygon = this.localGeometry.polygon.map(toWorld);
    this.surfaceSamples = this.computeSurfaceSamples(this.worldPolygon);
    this.version++;
  }

  private computeSurfaceSamples(polygon: Vec2[]): SurfaceSample[] {
    const n = polygon.length;
    let cx = 0;
    let cy = 0;
    for (const p of polygon) {
      cx += p.x;
      cy += p.y;
    }
    const centroid: Vec2 = { x: cx / n, y: cy / n };

    const samples: SurfaceSample[] = [];
    for (let i = 0; i < n; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % n];
      const edge = sub(b, a);
      const segLen = length(edge);
      if (segLen < 1e-6) continue;
      const dir = normalize(edge);
      let normal = normalize(perp(dir));
      const mid: Vec2 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const towardOutside = sub(mid, centroid);
      if (normal.x * towardOutside.x + normal.y * towardOutside.y < 0) {
        normal = scale(normal, -1);
      }
      samples.push({ point: mid, normal, length: segLen });
    }
    return samples;
  }

  getWorldPolygon(): Vec2[] {
    return this.worldPolygon;
  }

  getSurfaceSamples(): SurfaceSample[] {
    return this.surfaceSamples;
  }

  getChordLength(): number {
    return this.chord();
  }
}
