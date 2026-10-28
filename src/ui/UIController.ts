import "./panel.css";
import type { SolverParams, ViewMode, ParticleColorMode } from "../solver/SolverParams";
import { Airfoil } from "../airfoil/Airfoil";
import type { ControlSurfaceParams } from "../airfoil/NACA";
import { parseNACA4 } from "../airfoil/NACA";
import { SHAPE_LABELS } from "../airfoil/Shapes";
import type { ShapeKind } from "../airfoil/Shapes";
import type { ForceResult } from "../forces/ForceCalculator";
import { PolarSweep, DEFAULT_SWEEP } from "../analysis/PolarSweep";
import type { SweepConfig } from "../analysis/PolarSweep";
import { RANGES } from "../state/ranges";
import type { Range } from "../state/ranges";
import { RollingGraph } from "./RollingGraph";
import { PolarChart } from "./PolarChart";
import { downloadText } from "./download";

interface SliderConfig {
  label: string;
  range: Range;
  get: () => number;
  set: (v: number) => void;
  format?: (v: number) => string;
  /** Disables the control while true (checked on every sync). */
  disabled?: () => boolean;
}

interface SegmentOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

/** Hooks the panel calls back into the simulation with. */
export interface UIActions {
  onParticleCountChange: (n: number) => void;
  isPaused: () => boolean;
  togglePause: () => void;
  stepOnce: () => void;
  resetFlow: () => void;
  screenshot: () => void;
  copyLink: () => Promise<boolean>;
  startSweep: (cfg: SweepConfig) => void;
  togglePanel: () => void;
}

const fmt2 = (v: number) => v.toFixed(2);
const fmt1 = (v: number) => v.toFixed(1);
const fmt0 = (v: number) => v.toFixed(0);
const deg = (v: number) => `${v.toFixed(1)}°`;

/** UI refresh rate for readouts and control sync; text changing faster than this is unreadable anyway. */
const REFRESH_MS = 100;
/** Time constant of the smoothed readouts, in simulated seconds. */
const SMOOTHING_TAU_S = 0.6;

const VIEW_OPTIONS: SegmentOption<ViewMode>[] = [
  { value: "pressure", label: "Cp", title: "Pressure coefficient" },
  { value: "speed", label: "Speed", title: "Speed relative to freestream" },
  { value: "vorticity", label: "Vort", title: "Vorticity" },
  { value: "none", label: "Off", title: "Particles only" },
];
const VIEW_ORDER = VIEW_OPTIONS.map((o) => o.value);

export class UIController {
  private root: HTMLElement;
  private badge: HTMLElement;
  private statusBadge: HTMLElement;
  private readouts: Record<string, HTMLElement> = {};
  private readoutText: Record<string, string> = {};
  private graph!: RollingGraph;
  private polarChart!: PolarChart;
  private solverParams: SolverParams;
  private airfoil: Airfoil;
  private sweep: PolarSweep;
  private actions: UIActions;
  private syncers: (() => void)[] = [];
  private debugText: string | null = null;
  private lastRefresh = 0;
  private fps = 60;

  private smoothed: ForceResult | null = null;
  private lastForceTime = 0;

  private pauseBtn!: HTMLButtonElement;
  private sweepBtn!: HTMLButtonElement;
  private sweepProgress!: HTMLElement;
  private sweepStatus!: HTMLElement;
  private sweepCsvBtn!: HTMLButtonElement;
  private sweepCfg: SweepConfig = { ...DEFAULT_SWEEP };
  private nacaInput!: HTMLInputElement;
  private nacaOnly: HTMLElement[] = [];
  private thicknessRow!: HTMLElement;

  constructor(
    panelHost: HTMLElement,
    stage: HTMLElement,
    solverParams: SolverParams,
    airfoil: Airfoil,
    sweep: PolarSweep,
    actions: UIActions
  ) {
    this.solverParams = solverParams;
    this.airfoil = airfoil;
    this.sweep = sweep;
    this.actions = actions;

    this.root = document.createElement("div");
    this.root.className = "panel";
    panelHost.appendChild(this.root);

    this.badge = document.createElement("div");
    this.badge.className = "fps-badge";
    this.badge.textContent = "-- fps";
    stage.appendChild(this.badge);

    this.statusBadge = document.createElement("div");
    this.statusBadge.className = "status-badge";
    this.statusBadge.hidden = true;
    stage.appendChild(this.statusBadge);

    const showPanel = document.createElement("button");
    showPanel.type = "button";
    showPanel.className = "stage-button panel-show";
    showPanel.textContent = "Controls";
    showPanel.title = "Show panel (H)";
    showPanel.addEventListener("click", () => this.actions.togglePanel());
    stage.appendChild(showPanel);

    this.buildHeader();
    this.buildReadouts();
    this.buildSweep();
    this.buildFlow();
    this.buildBody();
    this.buildControlSurfaces();
    this.buildVisualization();
    this.buildFooter();

    this.sweep.onChange = () => this.onSweepChange();
    window.addEventListener("keydown", this.onKeyDown);
    this.syncAll();
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
  }

  // ---------------------------------------------------------------- builders

  private section(title: string): HTMLElement {
    const h2 = document.createElement("h2");
    h2.textContent = title;
    this.root.appendChild(h2);
    return h2;
  }

  private button(label: string, title: string, onClick: () => void, className = "tool-button"): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className;
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", (e) => {
      // Drop focus after pointer clicks so Space goes to the pause shortcut
      // rather than re-clicking the last button; keyboard activation keeps it.
      if (e.detail > 0) b.blur();
      onClick();
    });
    return b;
  }

  private buildHeader(): void {
    const header = document.createElement("div");
    header.className = "panel-header";
    const h1 = document.createElement("h1");
    h1.textContent = "Wind Tunnel";
    header.appendChild(h1);
    header.appendChild(this.button("Hide", "Hide panel (H)", () => this.actions.togglePanel(), "tool-button ghost"));
    this.root.appendChild(header);

    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    this.pauseBtn = this.button("Pause", "Pause / resume (Space)", () => this.actions.togglePause());
    toolbar.appendChild(this.pauseBtn);
    toolbar.appendChild(this.button("Step", "Advance one step while paused (.)", () => this.actions.stepOnce()));
    toolbar.appendChild(this.button("Reset", "Restart the flow from freestream (R)", () => this.actions.resetFlow()));
    const spacer = document.createElement("span");
    spacer.className = "toolbar-spacer";
    toolbar.appendChild(spacer);
    toolbar.appendChild(this.button("PNG", "Save a screenshot (P)", () => this.actions.screenshot()));
    const linkBtn = this.button("Link", "Copy a link to this exact setup", async () => {
      const ok = await this.actions.copyLink();
      linkBtn.textContent = ok ? "Copied" : "Failed";
      setTimeout(() => (linkBtn.textContent = "Link"), 1400);
    });
    toolbar.appendChild(linkBtn);
    this.root.appendChild(toolbar);
    this.syncers.push(() => {
      const label = this.actions.isPaused() ? "Play" : "Pause";
      if (this.pauseBtn.textContent !== label) this.pauseBtn.textContent = label;
    });
  }

  private buildReadouts(): void {
    this.section("Aerodynamics");
    const grid = document.createElement("div");
    grid.className = "readout-grid";
    this.root.appendChild(grid);

    const keys: [string, string, string][] = [
      ["cl", "Cl", "Lift coefficient (smoothed)"],
      ["cd", "Cd", "Total drag coefficient (smoothed)"],
      ["cdp", "Cd pressure", "Form/pressure drag share of Cd"],
      ["cdf", "Cd friction", "Skin-friction share of Cd (scales with viscosity)"],
      ["cm", "Cm", "Pitching-moment coefficient about the pitch axis, nose-up positive"],
      ["ld", "L / D", "Lift-to-drag ratio"],
      ["lift", "Lift", "Lift force, density-scaled sim units"],
      ["drag", "Drag", "Drag force, density-scaled sim units"],
      ["xcp", "C. of P. (x/c)", "Center of pressure along the chord"],
      ["reynolds", "Reynolds", "Re = V·L/ν (nominal: numerical diffusion dominates at this grid size)"],
    ];
    for (const [key, label, title] of keys) {
      const cell = document.createElement("div");
      cell.className = "readout";
      cell.title = title;
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

  private buildSweep(): void {
    this.section("Polar Sweep");
    const box = document.createElement("div");
    box.className = "sweep";
    this.root.appendChild(box);

    const fields: [keyof SweepConfig, string, number, number, number][] = [
      ["fromDeg", "From °", -90, 90, 0.5],
      ["toDeg", "To °", -90, 90, 0.5],
      ["stepDeg", "Step °", 0.5, 20, 0.5],
      ["settleS", "Settle s", 0.5, 30, 0.5],
      ["averageS", "Avg s", 0.5, 30, 0.5],
    ];
    const grid = document.createElement("div");
    grid.className = "sweep-grid";
    for (const [key, label, min, max, step] of fields) {
      const wrap = document.createElement("label");
      wrap.className = "num-field";
      const span = document.createElement("span");
      span.textContent = label;
      const input = document.createElement("input");
      input.type = "number";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(this.sweepCfg[key]);
      input.addEventListener("change", () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) this.sweepCfg[key] = Math.min(max, Math.max(min, v));
        input.value = String(this.sweepCfg[key]);
      });
      wrap.appendChild(span);
      wrap.appendChild(input);
      grid.appendChild(wrap);
    }
    box.appendChild(grid);

    const row = document.createElement("div");
    row.className = "sweep-row";
    this.sweepBtn = this.button("Run sweep", "Step through the AoA range and average Cl/Cd/Cm at each angle", () => {
      if (this.sweep.running) this.sweep.cancel();
      else this.actions.startSweep({ ...this.sweepCfg });
    });
    this.sweepBtn.classList.add("primary");
    const progress = document.createElement("div");
    progress.className = "progress";
    this.sweepProgress = document.createElement("div");
    this.sweepProgress.className = "progress-fill";
    progress.appendChild(this.sweepProgress);
    this.sweepCsvBtn = this.button("CSV", "Download polar data as CSV", () =>
      downloadText(this.sweep.toCSV(), `windtunnel-polar-${this.airfoil.nacaCode() ?? this.airfoil.params.shape}.csv`)
    );
    this.sweepCsvBtn.disabled = true;
    row.appendChild(this.sweepBtn);
    row.appendChild(progress);
    row.appendChild(this.sweepCsvBtn);
    box.appendChild(row);

    this.sweepStatus = document.createElement("div");
    this.sweepStatus.className = "sweep-status";
    box.appendChild(this.sweepStatus);

    this.polarChart = new PolarChart(box);
  }

  private buildFlow(): void {
    this.section("Flow Conditions");
    const sp = this.solverParams;
    this.addSlider({ label: "Airspeed", range: RANGES.airspeed, get: () => sp.airspeed, set: (v) => (sp.airspeed = v), format: fmt0 });
    this.addSlider({ label: "Air Density", range: RANGES.density, get: () => sp.density, set: (v) => (sp.density = v), format: fmt2 });
    this.addSlider({ label: "Viscosity", range: RANGES.viscosity, get: () => sp.viscosity, set: (v) => (sp.viscosity = v), format: fmt2 });
    this.addSlider({
      label: "Vortex Confinement",
      range: RANGES.vorticityEpsilon,
      get: () => sp.vorticityEpsilon,
      set: (v) => (sp.vorticityEpsilon = v),
      format: fmt2,
    });
    this.addSlider({
      label: "Sim Speed",
      range: RANGES.tickRate,
      get: () => sp.tickRate,
      set: (v) => (sp.tickRate = v),
      format: (v) => `${v.toFixed(0)}x`,
    });
  }

  private buildBody(): void {
    this.section("Body");
    const a = this.airfoil;
    const isNaca = () => a.params.shape === "naca";

    const shapes = Object.keys(SHAPE_LABELS) as ShapeKind[];
    const select = document.createElement("select");
    select.className = "select";
    for (const s of shapes) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = SHAPE_LABELS[s];
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      a.setParams({ shape: select.value as ShapeKind });
      this.syncAll();
    });
    this.root.appendChild(select);
    this.syncers.push(() => {
      if (select.value !== a.params.shape) select.value = a.params.shape;
      select.disabled = this.sweep.running;
    });

    // NACA designation, two-way bound to the shape sliders.
    const codeRow = document.createElement("label");
    codeRow.className = "code-row";
    const codeLabel = document.createElement("span");
    codeLabel.textContent = "NACA";
    this.nacaInput = document.createElement("input");
    this.nacaInput.type = "text";
    this.nacaInput.inputMode = "numeric";
    this.nacaInput.maxLength = 4;
    this.nacaInput.spellcheck = false;
    this.nacaInput.placeholder = "2412";
    this.nacaInput.title = "4-digit designation: max camber %, camber position (tenths), thickness %";
    const applyCode = () => {
      const parsed = parseNACA4(this.nacaInput.value);
      if (parsed) {
        a.setParams(parsed);
        this.nacaInput.classList.remove("invalid");
      } else {
        this.nacaInput.classList.add("invalid");
      }
    };
    this.nacaInput.addEventListener("change", applyCode);
    this.nacaInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        applyCode();
        this.nacaInput.blur();
      }
    });
    codeRow.appendChild(codeLabel);
    codeRow.appendChild(this.nacaInput);
    this.root.appendChild(codeRow);
    this.nacaOnly.push(codeRow);
    this.syncers.push(() => {
      const code = a.nacaCode() ?? "";
      if (document.activeElement !== this.nacaInput && this.nacaInput.value !== code) {
        this.nacaInput.value = code;
        this.nacaInput.classList.remove("invalid");
      }
    });

    this.addSlider({
      label: "Angle of Attack",
      range: RANGES.aoaDeg,
      get: () => a.params.aoaDeg,
      set: (v) => a.setParams({ aoaDeg: v }),
      format: deg,
      disabled: () => this.sweep.running,
    });
    this.nacaOnly.push(
      this.addSlider({
        label: "Camber (M %)",
        range: RANGES.maxCamberPct,
        get: () => a.params.maxCamberPct,
        set: (v) => a.setParams({ maxCamberPct: v }),
        format: fmt1,
      }),
      this.addSlider({
        label: "Camber Position (P)",
        range: RANGES.camberPosTenths,
        get: () => a.params.camberPosTenths,
        set: (v) => a.setParams({ camberPosTenths: v }),
        format: (v) => `${(v * 10).toFixed(0)}% c`,
      })
    );
    this.thicknessRow = this.addSlider({
      label: "Thickness (%)",
      range: RANGES.thicknessPct,
      get: () => a.params.thicknessPct,
      set: (v) => a.setParams({ thicknessPct: v }),
      format: fmt1,
    });
    this.addSlider({
      label: "Size (% of tunnel)",
      range: RANGES.chordPct,
      get: () => a.params.chordFrac * 100,
      set: (v) => a.setParams({ chordFrac: v / 100 }),
      format: fmt0,
    });
    this.addSlider({
      label: "Position X (%)",
      range: RANGES.posXPct,
      get: () => a.params.posXFrac * 100,
      set: (v) => a.setParams({ posXFrac: v / 100 }),
      format: fmt1,
    });
    this.addSlider({
      label: "Position Y (%)",
      range: RANGES.posYPct,
      get: () => a.params.posYFrac * 100,
      set: (v) => a.setParams({ posYFrac: v / 100 }),
      format: fmt1,
    });
    this.syncers.push(() => {
      for (const el of this.nacaOnly) el.hidden = !isNaca();
      // Plates have a fixed thickness; cylinders are sized by the chord slider.
      this.thicknessRow.hidden = a.params.shape === "plate" || a.params.shape === "cylinder";
    });
  }

  private buildControlSurfaces(): void {
    const header = this.section("Control Surfaces");
    const a = this.airfoil;
    const cs = (key: keyof ControlSurfaceParams, label: string, range: Range) =>
      this.addSlider({
        label,
        range,
        get: () => a.params.controlSurfaces[key],
        set: (v) => a.setParams({ controlSurfaces: { [key]: v } }),
        format: (v) => `${v.toFixed(0)}°`,
      });
    const rows = [
      cs("slatDeg", "Slat (leading edge)", RANGES.slatDeg),
      cs("flapDeg", "Flap (trailing edge)", RANGES.flapDeg),
      cs("aileronDeg", "Aileron (outer TE tip)", RANGES.aileronDeg),
    ];
    this.nacaOnly.push(header, ...rows);
  }

  private buildVisualization(): void {
    this.section("Visualization");
    const sp = this.solverParams;
    this.addSegmented<ViewMode>("Field", VIEW_OPTIONS, () => sp.viewMode, (v) => (sp.viewMode = v));
    this.addSegmented<ParticleColorMode>(
      "Particles",
      [
        { value: "white", label: "White" },
        { value: "speed", label: "By speed" },
      ],
      () => sp.particleColor,
      (v) => (sp.particleColor = v)
    );
    this.addSlider({
      label: "Particle Count",
      range: RANGES.particleCount,
      get: () => sp.particleCount,
      set: (v) => {
        sp.particleCount = v;
        this.actions.onParticleCountChange(v);
      },
      format: fmt0,
    });
    this.addSlider({
      label: "Trail Length",
      range: RANGES.trailLength,
      get: () => sp.trailLength,
      set: (v) => (sp.trailLength = v),
      format: (v) => v.toFixed(3),
    });
    this.addSlider({
      label: "Field Contrast",
      range: RANGES.pressureScale,
      get: () => sp.pressureScale,
      set: (v) => (sp.pressureScale = v),
      format: fmt2,
    });
  }

  private buildFooter(): void {
    const foot = document.createElement("div");
    foot.className = "shortcuts";
    const keys: [string, string][] = [
      ["Space", "pause"],
      [".", "step"],
      ["R", "reset"],
      ["V", "view"],
      ["P", "png"],
      ["H", "panel"],
    ];
    for (const [k, d] of keys) {
      const item = document.createElement("span");
      const kbd = document.createElement("kbd");
      kbd.textContent = k;
      item.appendChild(kbd);
      item.append(` ${d}`);
      foot.appendChild(item);
    }
    const hint = document.createElement("p");
    hint.textContent = "Drag the body to pitch it, Shift-drag (or grab its pivot) to move it, scroll over it for fine AoA.";
    foot.appendChild(hint);
    this.root.appendChild(foot);
  }

  /** Appends a labeled range slider bound to `cfg`, returning its row. */
  private addSlider(cfg: SliderConfig): HTMLElement {
    const row = document.createElement("div");
    row.className = "slider-row";

    const top = document.createElement("div");
    top.className = "top";
    const label = document.createElement("span");
    label.textContent = cfg.label;
    const value = document.createElement("span");
    value.className = "value";
    const format = cfg.format ?? fmt2;
    top.appendChild(label);
    top.appendChild(value);
    row.appendChild(top);

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(cfg.range.min);
    input.max = String(cfg.range.max);
    input.step = String(cfg.range.step);
    input.setAttribute("aria-label", cfg.label);
    input.addEventListener("input", () => {
      cfg.set(parseFloat(input.value));
      // Read back: the model may clamp (e.g. position near a wall).
      shown = NaN;
      sync();
    });
    row.appendChild(input);
    this.root.appendChild(row);

    let shown = NaN;
    const sync = () => {
      const v = cfg.get();
      if (v !== shown) {
        shown = v;
        value.textContent = format(v);
        if (document.activeElement !== input) input.value = String(v);
      }
      const disabled = cfg.disabled?.() ?? false;
      if (input.disabled !== disabled) input.disabled = disabled;
    };
    this.syncers.push(sync);
    return row;
  }

  private addSegmented<T extends string>(label: string, options: SegmentOption<T>[], get: () => T, set: (v: T) => void): void {
    const row = document.createElement("div");
    row.className = "segment-row";
    const l = document.createElement("span");
    l.textContent = label;
    row.appendChild(l);
    const group = document.createElement("div");
    group.className = "segmented";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    const buttons = options.map((o) => {
      const b = this.button(o.label, o.title ?? o.label, () => {
        set(o.value);
        sync();
      }, "");
      b.setAttribute("role", "radio");
      group.appendChild(b);
      return b;
    });
    row.appendChild(group);
    this.root.appendChild(row);
    const sync = () => {
      const v = get();
      options.forEach((o, i) => {
        const on = o.value === v;
        if (buttons[i].classList.contains("active") !== on) {
          buttons[i].classList.toggle("active", on);
          buttons[i].setAttribute("aria-checked", String(on));
        }
      });
    };
    this.syncers.push(sync);
  }

  // ------------------------------------------------------------ live updates

  private syncAll(): void {
    for (const s of this.syncers) s();
  }

  private onSweepChange(): void {
    const s = this.sweep;
    this.sweepBtn.textContent = s.running ? "Cancel" : "Run sweep";
    this.sweepBtn.classList.toggle("danger", s.running);
    this.sweepProgress.style.width = `${(s.progress * 100).toFixed(1)}%`;
    this.sweepCsvBtn.disabled = s.points.length === 0;
    this.sweepStatus.textContent = s.running
      ? `Measuring α = ${s.currentAoA?.toFixed(1)}° · ${s.points.length} point${s.points.length === 1 ? "" : "s"} done`
      : s.points.length > 0
        ? `${s.points.length} points · max Cl ${Math.max(...s.points.map((p) => p.cl)).toFixed(3)}`
        : "";
    this.polarChart.setPoints(s.points);
    this.syncAll();
  }

  setDebugText(text: string): void {
    this.debugText = text;
  }

  /** Feed each fresh force result (not every frame). */
  pushForces(forces: ForceResult, simTime: number): void {
    const dt = simTime - this.lastForceTime;
    this.lastForceTime = simTime;
    if (!this.smoothed || dt <= 0) {
      this.smoothed = { ...forces };
    } else {
      const k = 1 - Math.exp(-dt / SMOOTHING_TAU_S);
      const s = this.smoothed;
      s.cl += (forces.cl - s.cl) * k;
      s.cd += (forces.cd - s.cd) * k;
      s.cdFriction += (forces.cdFriction - s.cdFriction) * k;
      s.cm += (forces.cm - s.cm) * k;
      s.lift += (forces.lift - s.lift) * k;
      s.drag += (forces.drag - s.drag) * k;
      s.ld = Math.abs(s.cd) > 1e-4 ? s.cl / s.cd : NaN;
      s.xcp = forces.xcp === null ? null : s.xcp === null ? forces.xcp : s.xcp + (forces.xcp - s.xcp) * k;
      s.reynolds = forces.reynolds;
      s.dynamicPressure = forces.dynamicPressure;
    }
    this.graph.push(forces.cl, forces.cd, forces.cm, simTime);
  }

  /** Clears smoothed readouts and the history graph (after a flow reset). */
  resetHistory(): void {
    this.smoothed = null;
    this.lastForceTime = 0;
    this.graph.reset();
  }

  private setReadout(key: string, text: string): void {
    if (this.readoutText[key] === text) return;
    this.readoutText[key] = text;
    this.readouts[key].textContent = text;
  }

  /** Call once per animation frame; throttles its own DOM work. */
  update(now: number, fps: number): void {
    this.fps = fps;
    this.graph.tick(now);
    if (now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;

    const f = this.smoothed;
    if (f) {
      const big = (v: number) => (Math.abs(v) >= 1e5 ? v.toExponential(2) : v.toFixed(0));
      this.setReadout("cl", f.cl.toFixed(3));
      this.setReadout("cd", f.cd.toFixed(3));
      this.setReadout("cdp", (f.cd - f.cdFriction).toFixed(3));
      this.setReadout("cdf", f.cdFriction.toFixed(4));
      this.setReadout("cm", f.cm.toFixed(3));
      this.setReadout("ld", Number.isFinite(f.ld) ? f.ld.toFixed(1) : "--");
      this.setReadout("lift", big(f.lift));
      this.setReadout("drag", big(f.drag));
      this.setReadout("xcp", f.xcp === null || !Number.isFinite(f.xcp) ? "--" : f.xcp.toFixed(2));
      this.setReadout("reynolds", f.reynolds.toExponential(2));
    }

    this.badge.textContent = this.debugText ?? `${this.fps.toFixed(0)} fps`;
    const status = this.sweep.running ? "Sweeping" : this.actions.isPaused() ? "Paused" : "";
    if (this.statusBadge.textContent !== status) {
      this.statusBadge.textContent = status;
      this.statusBadge.hidden = status === "";
    }
    this.syncAll();
  }

  // ---------------------------------------------------------------- keyboard

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t?.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
      // Range sliders don't consume these keys; let shortcuts through for them.
      if (!(t instanceof HTMLInputElement && t.type === "range")) return;
    }
    switch (e.key) {
      case " ":
        this.actions.togglePause();
        break;
      case ".":
        this.actions.stepOnce();
        break;
      case "r":
      case "R":
        this.actions.resetFlow();
        break;
      case "v":
      case "V": {
        const sp = this.solverParams;
        const dir = e.shiftKey ? -1 : 1;
        const i = VIEW_ORDER.indexOf(sp.viewMode);
        sp.viewMode = VIEW_ORDER[(i + dir + VIEW_ORDER.length) % VIEW_ORDER.length];
        break;
      }
      case "p":
      case "P":
        this.actions.screenshot();
        break;
      case "h":
      case "H":
        this.actions.togglePanel();
        break;
      default:
        return;
    }
    e.preventDefault();
    this.syncAll();
  };
}
