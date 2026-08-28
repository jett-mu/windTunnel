import type { Vec2 } from "../gl/math";
import { add, sub, rotate } from "../gl/math";

export interface NACAParams {
  /** Max camber as % of chord (the "M" digit). 0 = symmetric airfoil. */
  maxCamberPct: number;
  /** Chordwise position of max camber, in tenths of chord (the "P" digit), e.g. 4 -> 0.4c. */
  camberPosTenths: number;
  /** Max thickness as % of chord (the "XX" digits). */
  thicknessPct: number;
  chord: number;
  /** Points per surface (upper/lower each get this many, cosine-spaced). */
  numPoints: number;
  controlSurfaces?: ControlSurfaceParams;
}

/**
 * Hinged control surfaces, each a rigid rotation of the skin aft/forward of a
 * fixed hinge station about the camber line. Slat sits at the leading edge
 * and droops its free (leading) tip down to open a slot ahead of the main
 * element; flap and aileron are trailing-edge hinges, with the aileron
 * nested inside the flap's deflected segment (an outer sub-hinge), similar
 * in spirit to how ailerons sit outboard of flaps on a real wing even though
 * here it's chordwise rather than spanwise.
 */
export interface ControlSurfaceParams {
  slatHingeFrac: number;
  slatDeg: number;
  flapHingeFrac: number;
  flapDeg: number;
  aileronHingeFrac: number;
  aileronDeg: number;
}

export const DEFAULT_CONTROL_SURFACES: ControlSurfaceParams = {
  slatHingeFrac: 0.12,
  slatDeg: 0,
  flapHingeFrac: 0.72,
  flapDeg: 0,
  aileronHingeFrac: 0.88,
  aileronDeg: 0,
};

export interface NACAGeometry {
  /** Upper surface points, leading edge (index 0) to trailing edge (last), local coords. */
  upper: Vec2[];
  /** Lower surface points, leading edge (index 0) to trailing edge (last), local coords. */
  lower: Vec2[];
  /** Closed outline for rasterization/force-integration: TE -> upper(TE..LE) -> LE -> lower(LE..TE) -> TE. */
  polygon: Vec2[];
}

function thicknessAt(xc: number, t: number, chord: number): number {
  const r = xc / chord;
  return (
    5 *
    t *
    chord *
    (0.2969 * Math.sqrt(r) - 0.126 * r - 0.3516 * r * r + 0.2843 * r * r * r - 0.1015 * r * r * r * r)
  );
}

/** Returns [camber y, dyc/dx] at chordwise position xc. */
function camberAt(xc: number, m: number, p: number, chord: number): [number, number] {
  if (m === 0) return [0, 0];
  const r = xc / chord;
  if (r < p) {
    const yc = (m / (p * p)) * (2 * p * r - r * r);
    const dyc = ((2 * m) / (p * p)) * (p - r);
    return [yc * chord, dyc];
  }
  const oneMinusP = 1 - p;
  const yc = (m / (oneMinusP * oneMinusP)) * (1 - 2 * p + 2 * p * r - r * r);
  const dyc = ((2 * m) / (oneMinusP * oneMinusP)) * (p - r);
  return [yc * chord, dyc];
}

/**
 * Rigidly rotates every point at index >= startIdx (trailing-edge-side
 * hinge, e.g. flap/aileron) about a hinge point taken as the current
 * upper/lower skin midpoint at that station — read from the arrays at call
 * time rather than the original undeflected camber line, so a second,
 * nested deflection (e.g. an aileron hinge inside an already-deflected flap)
 * pivots from where the skin actually is, keeping the surface connected.
 */
function deflectTrailing(upper: Vec2[], lower: Vec2[], xcs: number[], hingeFrac: number, deg: number, chord: number): void {
  if (deg === 0) return;
  const hingeX = hingeFrac * chord;
  const startIdx = xcs.findIndex((xc) => xc >= hingeX);
  if (startIdx === -1) return;
  const hinge: Vec2 = { x: (upper[startIdx].x + lower[startIdx].x) / 2, y: (upper[startIdx].y + lower[startIdx].y) / 2 };
  const rad = (deg * Math.PI) / 180;
  for (let i = startIdx; i < xcs.length; i++) {
    // Positive deflection = trailing (free) end rotates down (-y).
    upper[i] = add(hinge, rotate(sub(upper[i], hinge), -rad));
    lower[i] = add(hinge, rotate(sub(lower[i], hinge), -rad));
  }
}

function deflectLeading(upper: Vec2[], lower: Vec2[], xcs: number[], hingeFrac: number, deg: number, chord: number): void {
  if (deg === 0) return;
  const hingeX = hingeFrac * chord;
  let endIdx = -1;
  for (let i = 0; i < xcs.length; i++) {
    if (xcs[i] <= hingeX) endIdx = i;
    else break;
  }
  if (endIdx === -1) return;
  const hinge: Vec2 = { x: (upper[endIdx].x + lower[endIdx].x) / 2, y: (upper[endIdx].y + lower[endIdx].y) / 2 };
  const rad = (deg * Math.PI) / 180;
  for (let i = 0; i <= endIdx; i++) {
    // Positive deflection = leading (free) end droops down (-y), opposite
    // rotation sense from the trailing-edge case since it's on the other
    // side of its hinge.
    upper[i] = add(hinge, rotate(sub(upper[i], hinge), rad));
    lower[i] = add(hinge, rotate(sub(lower[i], hinge), rad));
  }
}

/**
 * Generates a NACA 4-digit airfoil in local coordinates: chord runs along +x from
 * 0 (leading edge) to `chord` (trailing edge). Uses cosine point spacing so samples
 * cluster near the leading/trailing edges, where curvature is highest.
 */
export function generateNACA4(params: NACAParams): NACAGeometry {
  const m = params.maxCamberPct / 100;
  // Camber position must be > 0 for the piecewise camber formula to be well-defined
  // at the leading edge; clamp to a small minimum rather than special-casing p=0.
  const p = Math.max(params.camberPosTenths / 10, 0.05);
  const t = params.thicknessPct / 100;
  const c = params.chord;
  const n = Math.max(8, params.numPoints);

  const upper: Vec2[] = new Array(n);
  const lower: Vec2[] = new Array(n);
  const xcs: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const beta = (i / (n - 1)) * Math.PI;
    const xc = (c * (1 - Math.cos(beta))) / 2;
    xcs[i] = xc;

    const yt = thicknessAt(xc, t, c);
    const [yc, dyc] = camberAt(xc, m, p, c);
    const theta = Math.atan(dyc);

    upper[i] = { x: xc - yt * Math.sin(theta), y: yc + yt * Math.cos(theta) };
    lower[i] = { x: xc + yt * Math.sin(theta), y: yc - yt * Math.cos(theta) };
  }

  // Force an exactly-closed leading edge and trailing edge regardless of the
  // (nearly-but-not-quite-zero) thickness distribution's endpoint values.
  upper[0] = { x: 0, y: 0 };
  lower[0] = { x: 0, y: 0 };
  const [teCamber] = camberAt(c, m, p, c);
  upper[n - 1] = { x: c, y: teCamber };
  lower[n - 1] = { x: c, y: teCamber };

  const cs = params.controlSurfaces;
  if (cs) {
    deflectLeading(upper, lower, xcs, cs.slatHingeFrac, cs.slatDeg, c);
    deflectTrailing(upper, lower, xcs, cs.flapHingeFrac, cs.flapDeg, c);
    // Aileron hinge is nested inside the flap's segment, so it acts on the
    // already-flap-deflected points — a sub-hinge, like a flap with a
    // smaller control tab at its tip.
    deflectTrailing(upper, lower, xcs, cs.aileronHingeFrac, cs.aileronDeg, c);
  }

  const polygon: Vec2[] = [];
  for (let i = n - 1; i >= 0; i--) polygon.push(upper[i]); // TE -> LE along upper surface
  for (let i = 1; i < n; i++) polygon.push(lower[i]); // LE -> TE along lower surface

  return { upper, lower, polygon };
}
