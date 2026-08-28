import "./panel.css";
import type { SolverParams } from "../solver/SolverParams";
import { TICK_RATE_MIN, TICK_RATE_MAX } from "../solver/SolverParams";
import {
  Airfoil,
  AOA_MIN_DEG,
  AOA_MAX_DEG,
  SLAT_MIN_DEG,
  SLAT_MAX_DEG,
  FLAP_MIN_DEG,
  FLAP_MAX_DEG,
  AILERON_MIN_DEG,
  AILERON_MAX_DEG,
} from "../airfoil/Airfoil";
import type { ForceResult } from "../forces/ForceCalculator";
import { RollingGraph } from "./RollingGraph";

interface SliderConfig {
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (v: number) => void;
  format?: (v: number) => string;
}

const fmt2 = (v: number) => v.toFixed(2);
const fmt0 = (v: number) => v.toFixed(0);

export class UIController {
  private root: HTMLElement;
  private fpsBadge: HTMLElement;
  private readouts: Record<string, HTMLElement> = {};
  private aoaInput!: HTMLInputElement;
  private aoaValueEl!: HTMLElement;
  private graph!: RollingGraph;
  private solverParams: SolverParams;
  private airfoil: Airfoil;
  private onParticleCountChange: (n: number) => void;

  constructor(
    container: HTMLElement,
    solverParams: SolverParams,
    airfoil: Airfoil,
    onParticleCountChange: (n: number) => void
  ) {
    this.solverParams = solverParams;
    this.airfoil = airfoil;
    this.onParticleCountChange = onParticleCountChange;
    this.root = document.createElement("div");
    this.root.className = "panel";
    container.appendChild(this.root);

    this.fpsBadge = document.createElement("div");
    this.fpsBadge.className = "fps-badge";
    this.fpsBadge.textContent = "-- fps";
    container.appendChild(this.fpsBadge);

    this.buildReadouts();
    this.buildSliders();
  }

  private buildReadouts(): void {
    const h1 = document.createElement("h1");
    h1.textContent = "Wind Tunnel";
    this.root.appendChild(h1);

    const h2 = document.createElement("h2");
    h2.textContent = "Aerodynamics";
    this.root.appendChild(h2);

    const grid = document.createElement("div");
    grid.className = "readout-grid";
    this.root.appendChild(grid);

    const keys: [string, string][] = [
      ["lift", "Lift (L)"],
      ["drag", "Drag (D)"],
      ["cl", "Cl"],
      ["cd", "Cd"],
      ["reynolds", "Reynolds"],
      ["q", "Dyn. Pressure"],
      ["airspeed", "Airspeed"],
      ["aoa", "AoA (deg)"],
    ];
    for (const [key, label] of keys) {
      const cell = document.createElement("div");
      cell.className = "readout";
      const l = document.createElement("span");
      l.className = "label";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "value";
      v.textContent = "--";
      cell.appendChild(l);
      cell.appendChild(v);
      grid.appendChild(cell);
      this.readouts[key] = v;
    }

    this.graph = new RollingGraph(this.root);
  }

  private buildSliders(): void {
    const flowHeader = document.createElement("h2");
    flowHeader.textContent = "Flow Conditions";
    this.root.appendChild(flowHeader);

    const flowSliders: SliderConfig[] = [
      {
        label: "Airspeed",
        min: 10,
        max: 400,
        step: 1,
        get: () => this.solverParams.airspeed,
        set: (v) => (this.solverParams.airspeed = v),
        format: fmt0,
      },
      {
        label: "Air Density",
        min: 0.1,
        max: 3,
        step: 0.05,
        get: () => this.solverParams.density,
        set: (v) => (this.solverParams.density = v),
        format: fmt2,
      },
      {
        label: "Viscosity",
        min: 0.01,
        max: 2,
        step: 0.01,
        get: () => this.solverParams.viscosity,
        set: (v) => (this.solverParams.viscosity = v),
        format: fmt2,
      },
      {
        label: "Tick Rate (sim speed)",
        min: TICK_RATE_MIN,
        max: TICK_RATE_MAX,
        step: 1,
        get: () => this.solverParams.tickRate,
        set: (v) => (this.solverParams.tickRate = v),
        format: (v) => `${v.toFixed(0)}x`,
      },
    ];
    flowSliders.forEach((cfg) => this.root.appendChild(this.makeSlider(cfg).row));

    const airfoilHeader = document.createElement("h2");
    airfoilHeader.textContent = "Airfoil (NACA 4-digit)";
    this.root.appendChild(airfoilHeader);

    const airfoilSliders: SliderConfig[] = [
      {
        label: "Angle of Attack",
        min: AOA_MIN_DEG,
        max: AOA_MAX_DEG,
        step: 0.5,
        get: () => this.airfoil.params.aoaDeg,
        set: (v) => this.airfoil.setParams({ aoaDeg: v }),
        format: fmt2,
      },
      {
        label: "Camber (M %)",
        min: 0,
        max: 9,
        step: 0.5,
        get: () => this.airfoil.params.maxCamberPct,
        set: (v) => this.airfoil.setParams({ maxCamberPct: v }),
        format: fmt2,
      },
      {
        label: "Thickness (XX %)",
        min: 4,
        max: 24,
        step: 0.5,
        get: () => this.airfoil.params.thicknessPct,
        set: (v) => this.airfoil.setParams({ thicknessPct: v }),
        format: fmt2,
      },
      {
        label: "Chord (% of tunnel)",
        min: 10,
        max: 45,
        step: 1,
        get: () => this.airfoil.params.chordFrac * 100,
        set: (v) => this.airfoil.setParams({ chordFrac: v / 100 }),
        format: fmt0,
      },
    ];
    airfoilSliders.forEach((cfg, i) => {
      const built = this.makeSlider(cfg);
      this.root.appendChild(built.row);
      if (i === 0) {
        this.aoaInput = built.input;
        this.aoaValueEl = built.valueEl;
      }
    });

    const controlsHeader = document.createElement("h2");
    controlsHeader.textContent = "Control Surfaces";
    this.root.appendChild(controlsHeader);

    const controlSliders: SliderConfig[] = [
      {
        label: "Slat (leading edge)",
        min: SLAT_MIN_DEG,
        max: SLAT_MAX_DEG,
        step: 1,
        get: () => this.airfoil.params.controlSurfaces.slatDeg,
        set: (v) => this.airfoil.setParams({ controlSurfaces: { slatDeg: v } }),
        format: fmt0,
      },
      {
        label: "Flap (trailing edge)",
        min: FLAP_MIN_DEG,
        max: FLAP_MAX_DEG,
        step: 1,
        get: () => this.airfoil.params.controlSurfaces.flapDeg,
        set: (v) => this.airfoil.setParams({ controlSurfaces: { flapDeg: v } }),
        format: fmt0,
      },
      {
        label: "Aileron (outer TE tip)",
        min: AILERON_MIN_DEG,
        max: AILERON_MAX_DEG,
        step: 1,
        get: () => this.airfoil.params.controlSurfaces.aileronDeg,
        set: (v) => this.airfoil.setParams({ controlSurfaces: { aileronDeg: v } }),
        format: fmt0,
      },
    ];
    controlSliders.forEach((cfg) => this.root.appendChild(this.makeSlider(cfg).row));

    const vizHeader = document.createElement("h2");
    vizHeader.textContent = "Visualization";
    this.root.appendChild(vizHeader);

    const vizSliders: SliderConfig[] = [
      {
        label: "Particle Count",
        min: 1000,
        max: 50000,
        step: 1000,
        get: () => this.solverParams.particleCount,
        set: (v) => {
          this.solverParams.particleCount = v;
          this.onParticleCountChange(v);
        },
        format: fmt0,
      },
      {
        label: "Trail Length",
        min: 0.8,
        max: 0.99,
        step: 0.005,
        get: () => this.solverParams.trailLength,
        set: (v) => (this.solverParams.trailLength = v),
        format: (v) => v.toFixed(3),
      },
      {
        label: "Pressure Scale",
        min: 0.1,
        max: 4,
        step: 0.1,
        get: () => this.solverParams.pressureScale,
        set: (v) => (this.solverParams.pressureScale = v),
        format: fmt2,
      },
    ];
    vizSliders.forEach((cfg) => this.root.appendChild(this.makeSlider(cfg).row));
  }

  private makeSlider(cfg: SliderConfig): { row: HTMLElement; input: HTMLInputElement; valueEl: HTMLElement } {
    const row = document.createElement("div");
    row.className = "slider-row";

    const top = document.createElement("div");
    top.className = "top";
    const label = document.createElement("span");
    label.textContent = cfg.label;
    const value = document.createElement("span");
    value.className = "value";
    const format = cfg.format ?? fmt2;
    value.textContent = format(cfg.get());
    top.appendChild(label);
    top.appendChild(value);
    row.appendChild(top);

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(cfg.min);
    input.max = String(cfg.max);
    input.step = String(cfg.step);
    input.value = String(cfg.get());
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      cfg.set(v);
      value.textContent = format(v);
    });
    row.appendChild(input);

    return { row, input, valueEl: value };
  }

  updateReadouts(forces: ForceResult, fps: number, simTime: number): void {
    // The AoA slider can also be changed externally (dragging the wing in
    // the canvas), so keep its displayed position/value in sync every frame.
    const aoa = this.airfoil.params.aoaDeg;
    if (document.activeElement !== this.aoaInput) {
      this.aoaInput.value = String(aoa);
    }
    this.aoaValueEl.textContent = aoa.toFixed(2);

    this.readouts.lift.textContent = forces.lift.toFixed(1);
    this.readouts.drag.textContent = forces.drag.toFixed(1);
    this.readouts.cl.textContent = forces.cl.toFixed(3);
    this.readouts.cd.textContent = forces.cd.toFixed(3);
    this.readouts.reynolds.textContent = forces.reynolds.toExponential(2);
    this.readouts.q.textContent = forces.dynamicPressure.toFixed(1);
    this.readouts.airspeed.textContent = this.solverParams.airspeed.toFixed(0);
    this.readouts.aoa.textContent = this.airfoil.params.aoaDeg.toFixed(1);
    this.fpsBadge.textContent = `${fps.toFixed(0)} fps`;
    this.graph.push(forces.cl, forces.cd, simTime);
  }
}
