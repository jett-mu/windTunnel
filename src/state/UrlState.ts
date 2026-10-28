import type { SolverParams, ViewMode, ParticleColorMode } from "../solver/SolverParams";
import { DEFAULT_SOLVER_PARAMS } from "../solver/SolverParams";
import type { AirfoilParams } from "../airfoil/Airfoil";
import { DEFAULT_AIRFOIL_PARAMS } from "../airfoil/Airfoil";
import type { ShapeKind } from "../airfoil/Shapes";
import { clamp } from "../gl/math";
import { RANGES } from "./ranges";
import type { Range } from "./ranges";

export interface AppState {
  solver: SolverParams;
  airfoil: AirfoilParams;
}

interface NumField {
  key: string;
  range: Range;
  get: (s: AppState) => number;
  set: (s: AppState, v: number) => void;
}

interface EnumField {
  key: string;
  values: readonly string[];
  get: (s: AppState) => string;
  set: (s: AppState, v: string) => void;
}

const num = (key: string, range: Range, get: NumField["get"], set: NumField["set"]): NumField => ({ key, range, get, set });

/** Short, stable URL keys. Changing one breaks old shared links. */
const NUM_FIELDS: NumField[] = [
  num("spd", RANGES.airspeed, (s) => s.solver.airspeed, (s, v) => (s.solver.airspeed = v)),
  num("rho", RANGES.density, (s) => s.solver.density, (s, v) => (s.solver.density = v)),
  num("nu", RANGES.viscosity, (s) => s.solver.viscosity, (s, v) => (s.solver.viscosity = v)),
  num("vc", RANGES.vorticityEpsilon, (s) => s.solver.vorticityEpsilon, (s, v) => (s.solver.vorticityEpsilon = v)),
  num("tick", RANGES.tickRate, (s) => s.solver.tickRate, (s, v) => (s.solver.tickRate = Math.round(v))),
  num("n", RANGES.particleCount, (s) => s.solver.particleCount, (s, v) => (s.solver.particleCount = Math.round(v))),
  num("trail", RANGES.trailLength, (s) => s.solver.trailLength, (s, v) => (s.solver.trailLength = v)),
  num("fs", RANGES.pressureScale, (s) => s.solver.pressureScale, (s, v) => (s.solver.pressureScale = v)),
  num("sn", RANGES.smokeStreams, (s) => s.solver.smokeStreams, (s, v) => (s.solver.smokeStreams = Math.round(v))),
  num("ss", RANGES.smokeSpanPct, (s) => s.solver.smokeSpan * 100, (s, v) => (s.solver.smokeSpan = v / 100)),
  num("aoa", RANGES.aoaDeg, (s) => s.airfoil.aoaDeg, (s, v) => (s.airfoil.aoaDeg = v)),
  num("m", RANGES.maxCamberPct, (s) => s.airfoil.maxCamberPct, (s, v) => (s.airfoil.maxCamberPct = v)),
  num("p", RANGES.camberPosTenths, (s) => s.airfoil.camberPosTenths, (s, v) => (s.airfoil.camberPosTenths = v)),
  num("t", RANGES.thicknessPct, (s) => s.airfoil.thicknessPct, (s, v) => (s.airfoil.thicknessPct = v)),
  num("c", RANGES.chordPct, (s) => s.airfoil.chordFrac * 100, (s, v) => (s.airfoil.chordFrac = v / 100)),
  num("x", RANGES.posXPct, (s) => s.airfoil.posXFrac * 100, (s, v) => (s.airfoil.posXFrac = v / 100)),
  num("y", RANGES.posYPct, (s) => s.airfoil.posYFrac * 100, (s, v) => (s.airfoil.posYFrac = v / 100)),
  num("slat", RANGES.slatDeg, (s) => s.airfoil.controlSurfaces.slatDeg, (s, v) => (s.airfoil.controlSurfaces.slatDeg = v)),
  num("flap", RANGES.flapDeg, (s) => s.airfoil.controlSurfaces.flapDeg, (s, v) => (s.airfoil.controlSurfaces.flapDeg = v)),
  num("ail", RANGES.aileronDeg, (s) => s.airfoil.controlSurfaces.aileronDeg, (s, v) => (s.airfoil.controlSurfaces.aileronDeg = v)),
];

const ENUM_FIELDS: EnumField[] = [
  {
    key: "view",
    values: ["pressure", "speed", "vorticity", "schlieren", "smoke", "none"],
    get: (s) => s.solver.viewMode,
    set: (s, v) => (s.solver.viewMode = v as ViewMode),
  },
  {
    key: "pc",
    values: ["white", "speed"],
    get: (s) => s.solver.particleColor,
    set: (s, v) => (s.solver.particleColor = v as ParticleColorMode),
  },
  {
    key: "shape",
    values: ["naca", "cylinder", "plate", "ellipse"],
    get: (s) => s.airfoil.shape,
    set: (s, v) => (s.airfoil.shape = v as ShapeKind),
  },
];

const DEFAULTS: AppState = {
  solver: DEFAULT_SOLVER_PARAMS,
  airfoil: DEFAULT_AIRFOIL_PARAMS,
};

/** Trims float noise (0.30000000000000004) without losing slider precision. */
function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/**
 * Serializes only the values that differ from the defaults, so an untouched
 * setup shares as a bare URL and links stay short.
 */
export function encodeState(state: AppState): string {
  const params = new URLSearchParams();
  for (const f of NUM_FIELDS) {
    const v = fmt(f.get(state));
    if (v !== fmt(f.get(DEFAULTS))) params.set(f.key, v);
  }
  for (const f of ENUM_FIELDS) {
    const v = f.get(state);
    if (v !== f.get(DEFAULTS)) params.set(f.key, v);
  }
  return params.toString();
}

/**
 * Applies a hash string onto `state` in place. Unknown keys, non-numeric
 * values and unknown enum values are ignored, and numbers are clamped to
 * their valid range, so a hand-edited or stale link can't produce an
 * invalid configuration.
 */
export function decodeState(hash: string, state: AppState): void {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  for (const f of NUM_FIELDS) {
    const raw = params.get(f.key);
    if (raw === null || raw.trim() === "") continue;
    const v = Number(raw);
    if (Number.isFinite(v)) f.set(state, clamp(v, f.range.min, f.range.max));
  }
  for (const f of ENUM_FIELDS) {
    const raw = params.get(f.key);
    if (raw !== null && f.values.includes(raw)) f.set(state, raw);
  }
}
