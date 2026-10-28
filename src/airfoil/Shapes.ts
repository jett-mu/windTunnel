import type { Vec2 } from "../gl/math";

export type ShapeKind = "naca" | "cylinder" | "plate" | "ellipse";

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  naca: "NACA 4-digit airfoil",
  cylinder: "Cylinder",
  plate: "Flat plate",
  ellipse: "Ellipse",
};

/** Cylinder diameter as a fraction of the chord setting, so the default
 * size sheds a clean von Kármán street without choking the tunnel. */
export const CYLINDER_DIAMETER_FRAC = 0.4;
const PLATE_THICKNESS_FRAC = 0.03;
const PLATE_MIN_THICKNESS = 3;

/** Chordwise pitch-axis position (fraction of chord) for each shape. */
export function pivotFrac(shape: ShapeKind): number {
  return shape === "naca" || shape === "plate" ? 0.25 : 0.5;
}

/**
 * Length coefficients are normalized by: chord, except the cylinder, which
 * conventionally uses its diameter (so Cd ~ 1.2 is directly comparable to
 * textbook values).
 */
export function referenceLength(shape: ShapeKind, chord: number): number {
  return shape === "cylinder" ? chord * CYLINDER_DIAMETER_FRAC : chord;
}

/**
 * Non-airfoil bodies, in the same local frame as the NACA generator: chord
 * along +x from 0 to `chord`, centered on y = 0, wound counter-clockwise.
 */
export function generateShape(shape: Exclude<ShapeKind, "naca">, chord: number, thicknessPct: number, n = 160): Vec2[] {
  const pts: Vec2[] = [];
  if (shape === "plate") {
    // Thin rectangle with semicircular ends, so the mask has no sub-texel
    // slivers at the corners.
    const half = Math.max(chord * PLATE_THICKNESS_FRAC, PLATE_MIN_THICKNESS) / 2;
    const arc = Math.max(4, Math.floor(n / 8));
    for (let i = 0; i <= arc; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / arc;
      pts.push({ x: chord - half + half * Math.cos(a), y: half * Math.sin(a) });
    }
    for (let i = 0; i <= arc; i++) {
      const a = Math.PI / 2 + (Math.PI * i) / arc;
      pts.push({ x: half + half * Math.cos(a), y: half * Math.sin(a) });
    }
    return pts;
  }

  const rx = shape === "cylinder" ? (chord * CYLINDER_DIAMETER_FRAC) / 2 : chord / 2;
  const ry = shape === "cylinder" ? rx : Math.max((chord * thicknessPct) / 200, 1.5);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push({ x: chord / 2 + rx * Math.cos(a), y: ry * Math.sin(a) });
  }
  return pts;
}
