/** Simulation grid resolution — decoupled from canvas display resolution. */
export const GRID_W = 512;
export const GRID_H = 256;

/** "multigrid" (default) or "jacobi" (the v1 solver, selectable with `?solver=jacobi` for A/B comparison). */
export type PressureSolver = "multigrid" | "jacobi";
/** Two fused V-cycles per step cost what one unfused cycle used to and leave
 * ~7x less residual (relative ~1e-2 vs ~5e-2). */
export const MULTIGRID_CYCLES = 2;
export const JACOBI_ITERATIONS = 80;
/** Velocity safety clamp, as a multiple of freestream speed. */
export const MAX_SPEED_FACTOR = 6;

export type ViewMode = "pressure" | "speed" | "vorticity" | "schlieren" | "smoke" | "none";
export type ParticleColorMode = "white" | "speed";

/** The smoke and schlieren views stand alone, as in a real tunnel: no particles on top. */
export function viewShowsParticles(mode: ViewMode): boolean {
  return mode !== "smoke" && mode !== "schlieren";
}

/** Single source of truth for every tunable parameter, mutated by UIController. */
export interface SolverParams {
  /** Freestream airspeed, grid-texels/second. */
  airspeed: number;
  /** Air density (kg/m^3-ish, arbitrary sim units). Scales dimensional
   * forces only: the flow itself is incompressible, so coefficients are
   * independent of it. */
  density: number;
  /** Kinematic viscosity, grid-cells^2/second. Sets Re = V*c/nu, which drives
   * the wall model (boundary-layer slip), skin friction and diffusion. */
  viscosity: number;
  /** Vorticity confinement strength: artificial energy injected to offset
   * numerical diffusion of small vortices. Kept low by default, since the
   * MacCormack + RK2 advection already preserves the wake; 0 is the
   * physically "pure" setting. */
  vorticityEpsilon: number;
  /** Simulation timestep, seconds. Held fixed regardless of tick rate — see
   * `tickRate` for how simulation speed is actually controlled. */
  dt: number;
  /** Simulated seconds per wall-clock second. Implemented as more
   * fixed-size solver sub-steps per second rather than a larger `dt`, so
   * accuracy/stability per step is unaffected. */
  tickRate: number;
  particleCount: number;
  trailLength: number;
  /** Contrast of the background field visualization (all view modes). */
  pressureScale: number;
  viewMode: ViewMode;
  particleColor: ParticleColorMode;
  /** Smoke view: number of rake nozzles. */
  smokeStreams: number;
  /** Smoke view: rake span as a fraction of tunnel height, centred on the body. */
  smokeSpan: number;
}

export const TICK_RATE_MIN = 1;
export const TICK_RATE_MAX = 6;

export const DEFAULT_SOLVER_PARAMS: SolverParams = {
  airspeed: 120,
  density: 1.0,
  // Re ~ 8e5 at the default airspeed and chord: full-size-wing territory,
  // where flow stays attached at moderate angles of attack.
  viscosity: 0.02,
  vorticityEpsilon: 0.15,
  dt: 1 / 60,
  tickRate: 1,
  particleCount: 20000,
  trailLength: 0.975,
  pressureScale: 1.0,
  viewMode: "pressure",
  particleColor: "white",
  smokeStreams: 8,
  smokeSpan: 0.5,
};
