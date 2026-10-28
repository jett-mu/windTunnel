import { TICK_RATE_MIN, TICK_RATE_MAX } from "../solver/SolverParams";
import {
  AOA_MIN_DEG,
  AOA_MAX_DEG,
  SLAT_MIN_DEG,
  SLAT_MAX_DEG,
  FLAP_MIN_DEG,
  FLAP_MAX_DEG,
  AILERON_MIN_DEG,
  AILERON_MAX_DEG,
} from "../airfoil/Airfoil";

export interface Range {
  min: number;
  max: number;
  step: number;
  /** Slider moves along a logarithmic scale (for quantities spanning decades). */
  log?: boolean;
}

const r = (min: number, max: number, step: number, log = false): Range => ({ min, max, step, log });

/**
 * Valid range and UI step for every user-tunable number, shared by the
 * panel sliders and URL-state validation so the two can't drift apart.
 * Chord and position are in percent, as the UI shows them.
 */
export const RANGES = {
  airspeed: r(10, 400, 1),
  density: r(0.1, 3, 0.05),
  viscosity: r(0.005, 2, 0.001, true),
  vorticityEpsilon: r(0, 1.5, 0.05),
  tickRate: r(TICK_RATE_MIN, TICK_RATE_MAX, 1),
  particleCount: r(1000, 50000, 1000),
  trailLength: r(0.8, 0.99, 0.005),
  pressureScale: r(0.1, 4, 0.1),
  aoaDeg: r(AOA_MIN_DEG, AOA_MAX_DEG, 0.5),
  maxCamberPct: r(0, 9, 0.5),
  camberPosTenths: r(1, 9, 0.5),
  thicknessPct: r(4, 24, 0.5),
  chordPct: r(10, 45, 1),
  posXPct: r(5, 90, 0.5),
  posYPct: r(5, 95, 0.5),
  slatDeg: r(SLAT_MIN_DEG, SLAT_MAX_DEG, 1),
  flapDeg: r(FLAP_MIN_DEG, FLAP_MAX_DEG, 1),
  aileronDeg: r(AILERON_MIN_DEG, AILERON_MAX_DEG, 1),
} satisfies Record<string, Range>;
