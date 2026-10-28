import type { Airfoil } from "../airfoil/Airfoil";
import type { ForceResult } from "../forces/ForceCalculator";

export interface SweepConfig {
  fromDeg: number;
  toDeg: number;
  stepDeg: number;
  /** Simulated seconds to let the flow adapt after each AoA change before averaging. */
  settleS: number;
  /** Simulated seconds to average coefficients over at each AoA. */
  averageS: number;
}

export interface PolarPoint {
  aoaDeg: number;
  cl: number;
  cd: number;
  cm: number;
}

export const DEFAULT_SWEEP: SweepConfig = { fromDeg: -6, toDeg: 14, stepDeg: 2, settleS: 2, averageS: 2 };

/**
 * Automated angle-of-attack sweep, the wind-tunnel equivalent of a polar
 * run: steps the body through a range of AoAs, lets the flow settle at each,
 * then time-averages Cl/Cd/Cm. Driven by simulated time (not wall time), so
 * it gives the same results at any tick rate or frame rate.
 */
export class PolarSweep {
  points: PolarPoint[] = [];
  private airfoil: Airfoil;
  private cfg: SweepConfig = DEFAULT_SWEEP;
  private angles: number[] = [];
  private index = 0;
  private phaseStart = 0;
  private averaging = false;
  private sums = { cl: 0, cd: 0, cm: 0, n: 0 };
  private restoreAoA = 0;
  private active = false;
  /** Called whenever progress or results change. */
  onChange: () => void = () => {};

  constructor(airfoil: Airfoil) {
    this.airfoil = airfoil;
  }

  get running(): boolean {
    return this.active;
  }

  /** 0..1 */
  get progress(): number {
    if (!this.active || this.angles.length === 0) return this.points.length > 0 ? 1 : 0;
    return this.index / this.angles.length;
  }

  get currentAoA(): number | null {
    return this.active ? this.angles[this.index] : null;
  }

  start(cfg: SweepConfig, simTime: number): void {
    const step = Math.max(Math.abs(cfg.stepDeg), 0.1) * Math.sign(cfg.toDeg - cfg.fromDeg || 1);
    this.angles = [];
    for (let a = cfg.fromDeg; step > 0 ? a <= cfg.toDeg + 1e-9 : a >= cfg.toDeg - 1e-9; a += step) {
      this.angles.push(Math.round(a * 100) / 100);
    }
    if (this.angles.length === 0) return;
    this.cfg = cfg;
    this.points = [];
    this.restoreAoA = this.airfoil.params.aoaDeg;
    this.active = true;
    this.index = 0;
    this.enterAngle(simTime);
    this.onChange();
  }

  cancel(): void {
    if (!this.active) return;
    this.finish();
  }

  private enterAngle(simTime: number): void {
    this.airfoil.setParams({ aoaDeg: this.angles[this.index] });
    this.phaseStart = simTime;
    this.averaging = false;
    this.sums = { cl: 0, cd: 0, cm: 0, n: 0 };
  }

  private finish(): void {
    this.active = false;
    this.airfoil.setParams({ aoaDeg: this.restoreAoA });
    this.onChange();
  }

  /** Feed each fresh force result. */
  update(forces: ForceResult, simTime: number): void {
    if (!this.active) return;
    const elapsed = simTime - this.phaseStart;
    if (!this.averaging) {
      if (elapsed < this.cfg.settleS) return;
      this.averaging = true;
      this.phaseStart = simTime;
      return;
    }
    this.sums.cl += forces.cl;
    this.sums.cd += forces.cd;
    this.sums.cm += forces.cm;
    this.sums.n++;
    if (elapsed < this.cfg.averageS) return;

    const n = Math.max(this.sums.n, 1);
    this.points.push({
      aoaDeg: this.angles[this.index],
      cl: this.sums.cl / n,
      cd: this.sums.cd / n,
      cm: this.sums.cm / n,
    });
    this.index++;
    if (this.index >= this.angles.length) this.finish();
    else {
      this.enterAngle(simTime);
      this.onChange();
    }
  }

  toCSV(): string {
    const rows = this.points.map((p) => `${p.aoaDeg},${p.cl.toFixed(5)},${p.cd.toFixed(5)},${p.cm.toFixed(5)}`);
    return ["aoa_deg,cl,cd,cm", ...rows].join("\n");
  }
}
