/** Simulation grid resolution — decoupled from canvas display resolution. */
export const GRID_W = 512;
export const GRID_H = 256;

export const PRESSURE_ITERATIONS = 80;
export const DIFFUSE_ITERATIONS = 20;

/** Single source of truth for every tunable parameter, mutated by UIController. */
export interface SolverParams {
  /** Freestream airspeed, grid-texels/second. */
  airspeed: number;
  /** Air density (kg/m^3-ish, arbitrary sim units). */
  density: number;
  /** Kinematic viscosity, used both in diffusion and Re = V*c/nu. */
  viscosity: number;
  /** Vorticity confinement strength. */
  vorticityEpsilon: number;
  /** Simulation timestep, seconds. Held fixed regardless of tick rate — see
   * `tickRate` for how simulation speed is actually controlled. */
  dt: number;
  /** Number of fixed-size solver sub-steps run per rendered frame. Raising
   * this speeds up simulated time without changing the timestep itself, so
   * accuracy/stability per step is unaffected — unlike increasing `dt`,
   * which would degrade quality. */
  tickRate: number;
  particleCount: number;
  trailLength: number;
  pressureScale: number;
}

export const TICK_RATE_MIN = 1;
export const TICK_RATE_MAX = 6;

export const DEFAULT_SOLVER_PARAMS: SolverParams = {
  airspeed: 120,
  density: 1.0,
  viscosity: 0.4,
  vorticityEpsilon: 0.4,
  dt: 1 / 60,
  tickRate: 1,
  particleCount: 20000,
  trailLength: 0.975,
  pressureScale: 1.2,
};
