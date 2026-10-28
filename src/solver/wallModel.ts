import { clamp } from "../gl/math";

/** At or above this boundary-layer thickness (grid cells) the grid resolves
 * the layer itself, so the wall is treated as plain no-slip. */
const RESOLVED_BL_CELLS = 3;
/** At or below this thickness the layer is entirely sub-cell: full slip. */
const THIN_BL_CELLS = 0.5;

/**
 * Laminar (Blasius) boundary-layer thickness, delta = 5 x / sqrt(Re_x),
 * evaluated at mid-chord, in grid cells (all lengths here are in cells).
 */
export function boundaryLayerCells(airspeed: number, viscosity: number, refLength: number): number {
  const x = refLength / 2;
  return 5 * Math.sqrt((viscosity * x) / Math.max(airspeed, 1e-3));
}

/**
 * Wall slip factor (0 = no-slip, 1 = free-slip) for the obstacle surface.
 *
 * A real boundary layer at full-scale Reynolds numbers is far thinner than
 * one grid cell. Imposing no-slip on the grid anyway smears it into a
 * slow layer several cells thick, whose momentum deficit makes the flow
 * separate far too early (the wind "peeling off" an airfoil at 5 degrees).
 * So the wall slips in proportion to how under-resolved the layer is: thin
 * (high-Re) layers slip, layers the grid can resolve get no-slip and develop
 * naturally. Skin friction is still accounted for, in the force integration.
 */
export function wallSlip(airspeed: number, viscosity: number, refLength: number): number {
  const delta = boundaryLayerCells(airspeed, viscosity, refLength);
  return clamp((RESOLVED_BL_CELLS - delta) / (RESOLVED_BL_CELLS - THIN_BL_CELLS), 0, 1);
}
