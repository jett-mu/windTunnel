import { GLContext } from "./gl/GLContext";
import { GpuTimer } from "./gl/GpuTimer";
import { FluidSolver } from "./solver/FluidSolver";
import { GRID_W, GRID_H, DEFAULT_SOLVER_PARAMS } from "./solver/SolverParams";
import type { SolverParams } from "./solver/SolverParams";
import { Airfoil, DEFAULT_AIRFOIL_PARAMS } from "./airfoil/Airfoil";
import type { AirfoilParams } from "./airfoil/Airfoil";
import { ObstacleMask } from "./airfoil/ObstacleMask";
import { ParticleSystem } from "./particles/ParticleSystem";
import { ForceCalculator } from "./forces/ForceCalculator";
import { Renderer } from "./render/Renderer";
import { PolarSweep } from "./analysis/PolarSweep";
import { UIController } from "./ui/UIController";
import { AirfoilDragController } from "./ui/AirfoilDragController";
import { downloadBlob } from "./ui/download";
import { encodeState, decodeState } from "./state/UrlState";

const PARTICLE_COLOR: [number, number, number] = [0.85, 0.95, 1.0];
/** CSS pixels; scaled by the backing-store DPR so particles look the same on any display. */
const PARTICLE_POINT_SIZE_CSS = 1.95;
/** Cap on solver steps per frame: if the GPU can't keep up, slow simulated
 * time down instead of spiralling into ever-longer frames. */
const MAX_STEPS_PER_FRAME = 8;
/** Longest wall-clock gap credited to the simulation (e.g. returning to a background tab). */
const MAX_FRAME_S = 0.1;
const URL_SYNC_MS = 300;

export interface SimulationHooks {
  /** The GPU context was lost; the simulation has stopped itself. */
  onContextLost: () => void;
}

/**
 * Top-level orchestrator: owns the DOM layout, every GPU subsystem and the
 * frame loop. Simulated time advances by fixed `dt` steps from an
 * accumulator fed with wall-clock time, so the flow evolves at the same rate
 * on 60 Hz, 120 Hz and throttled displays alike.
 */
export class Simulation {
  private glCtx: GLContext;
  private solver: FluidSolver;
  private airfoil: Airfoil;
  private obstacleMask: ObstacleMask;
  private particles: ParticleSystem;
  private forceCalc: ForceCalculator;
  private renderer: Renderer;
  private sweep: PolarSweep;
  private ui: UIController;
  private params: SolverParams;
  private timer: GpuTimer;

  private container: HTMLElement;
  private stage: HTMLElement;
  private canvas: HTMLCanvasElement;
  private resizeObserver: ResizeObserver;

  private rafId = 0;
  private running = false;
  private lastFrameTime = 0;
  private fps = 60;
  private cpuMs = 0;
  private simTime = 0;
  private accumulator = 0;
  private trailWallS = 0;
  private paused = false;
  private pendingSteps = 0;
  private screenshotRequested = false;
  private lastUrlSync = 0;
  private lastHash = "";

  constructor(container: HTMLElement, hooks: SimulationHooks) {
    this.container = container;
    this.stage = document.createElement("div");
    this.stage.className = "stage";
    this.canvas = document.createElement("canvas");
    this.canvas.id = "sim-canvas";
    this.stage.appendChild(this.canvas);
    container.appendChild(this.stage);

    // Shared links restore the full setup.
    const state = {
      solver: { ...DEFAULT_SOLVER_PARAMS },
      airfoil: { ...DEFAULT_AIRFOIL_PARAMS, controlSurfaces: { ...DEFAULT_AIRFOIL_PARAMS.controlSurfaces } } as AirfoilParams,
    };
    decodeState(location.hash, state);
    this.params = state.solver;

    this.glCtx = new GLContext(this.canvas);
    this.timer = new GpuTimer(this.glCtx.gl, new URLSearchParams(location.search).has("debug"));
    this.solver = new FluidSolver(this.glCtx);
    this.airfoil = new Airfoil(GRID_W, GRID_H, state.airfoil);
    this.obstacleMask = new ObstacleMask(this.glCtx.gl, GRID_W, GRID_H);
    this.sweep = new PolarSweep(this.airfoil);

    this.fitCanvas();
    this.particles = new ParticleSystem(this.glCtx, this.params.particleCount, this.canvas.width, this.canvas.height);
    this.forceCalc = new ForceCalculator(this.glCtx, this.airfoil);
    this.renderer = new Renderer(this.glCtx, this.airfoil);
    this.ui = new UIController(container, this.stage, this.params, this.airfoil, this.sweep, {
      onParticleCountChange: (n) => this.particles.setParticleCount(n),
      isPaused: () => this.paused,
      togglePause: () => (this.paused = !this.paused),
      stepOnce: () => {
        this.paused = true;
        this.pendingSteps++;
      },
      resetFlow: () => this.resetFlow(),
      screenshot: () => (this.screenshotRequested = true),
      copyLink: () => this.copyLink(),
      startSweep: (cfg) => {
        this.paused = false;
        this.sweep.start(cfg, this.simTime);
      },
      togglePanel: () => this.container.classList.toggle("panel-hidden"),
    });
    new AirfoilDragController(this.canvas, this.airfoil, () => this.sweep.running);

    this.syncObstacle();
    this.solver.reset(this.params.airspeed);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.stage);

    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.stop();
      hooks.onContextLost();
    });

    if (this.timer.enabled) {
      (window as unknown as { __wt: unknown }).__wt = {
        divergence: () => this.solver.measureDivergence(),
        forces: () => this.forceCalc.getLatestForces(),
      };
    }
  }

  /** Letterboxes the canvas inside the stage at the grid's aspect ratio, so the body is never stretched. */
  private fitCanvas(): void {
    const rect = this.stage.getBoundingClientRect();
    const pad = rect.width > 720 ? 20 : 8;
    const availW = Math.max(1, rect.width - 2 * pad);
    const availH = Math.max(1, rect.height - 2 * pad);
    const aspect = GRID_W / GRID_H;
    const w = Math.min(availW, availH * aspect);
    const h = w / aspect;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.glCtx.resize(w, h);
  }

  private handleResize(): void {
    this.fitCanvas();
    this.particles.resizeTrail(this.canvas.width, this.canvas.height);
  }

  private syncObstacle(): void {
    if (this.obstacleMask.update(this.airfoil.getWorldPolygon(), this.airfoil.version)) {
      this.solver.setObstacle(this.obstacleMask.getTexture());
    }
  }

  private resetFlow(): void {
    this.solver.reset(this.params.airspeed);
    this.particles.clearTrails();
    this.forceCalc.reset();
    this.ui.resetHistory();
    this.accumulator = 0;
  }

  private syncUrl(force = false): void {
    const hash = encodeState({ solver: this.params, airfoil: this.airfoil.params });
    if (!force && hash === this.lastHash) return;
    this.lastHash = hash;
    const url = `${location.pathname}${location.search}${hash ? `#${hash}` : ""}`;
    history.replaceState(null, "", url);
  }

  private async copyLink(): Promise<boolean> {
    this.syncUrl(true);
    try {
      await navigator.clipboard.writeText(location.href);
      return true;
    } catch {
      return false;
    }
  }

  private saveScreenshot(): void {
    // Must run in the same task as the render: without preserveDrawingBuffer
    // the drawing buffer is only valid until the frame is composited.
    const name = this.airfoil.nacaCode() ? `naca${this.airfoil.nacaCode()}` : this.airfoil.params.shape;
    const aoa = this.airfoil.params.aoaDeg.toFixed(1).replace("-", "m");
    this.canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, `windtunnel-${name}-aoa${aoa}.png`);
    }, "image/png");
  }

  private frame = (time: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    const wallDt = Math.min(Math.max((time - this.lastFrameTime) / 1000, 0), MAX_FRAME_S);
    this.lastFrameTime = time;
    if (wallDt > 0) this.fps += (1 / wallDt - this.fps) * 0.08;
    const cpuStart = performance.now();

    this.syncObstacle();

    // Fixed-dt sub-stepping from a wall-clock accumulator: tickRate scales
    // simulated seconds per real second without enlarging dt itself, so
    // per-step accuracy/stability is unaffected.
    const dt = this.params.dt;
    let steps: number;
    if (this.paused) {
      steps = this.pendingSteps;
      this.pendingSteps = 0;
      this.accumulator = 0;
    } else {
      this.accumulator += wallDt * this.params.tickRate;
      steps = Math.floor(this.accumulator / dt);
      this.accumulator -= steps * dt;
      if (steps > MAX_STEPS_PER_FRAME) {
        steps = MAX_STEPS_PER_FRAME;
        this.accumulator = 0;
      }
    }

    const obstacle = this.obstacleMask.getTexture();
    if (steps > 0) this.timer.begin("solver");
    for (let i = 0; i < steps; i++) this.solver.step(dt, this.params);
    this.timer.end(steps);

    this.timer.begin("particles");
    for (let i = 0; i < steps; i++) {
      this.particles.step(dt, this.solver.getVelocityTexture(), obstacle, this.params.airspeed);
      this.simTime += dt;
    }
    if (!this.paused) this.trailWallS += wallDt;
    if (steps > 0) {
      // Trail fade is per wall-clock time (one `trailLength` factor per
      // 60 Hz frame), so trails look the same length at any refresh rate.
      const frames = this.paused ? steps : this.trailWallS * 60;
      this.trailWallS = 0;
      this.particles.render(
        Math.pow(this.params.trailLength, frames),
        {
          pointSize: PARTICLE_POINT_SIZE_CSS * GLContext.dpr(),
          color: PARTICLE_COLOR,
          colorBySpeed: this.params.particleColor === "speed",
        },
        this.solver.getVelocityTexture(),
        this.params.airspeed
      );
    }
    this.timer.end();

    const flow = {
      airspeed: this.params.airspeed,
      density: this.params.density,
      viscosity: this.params.viscosity,
      dt,
    };
    if (this.forceCalc.update(this.solver.getPressureTexture(), flow, steps > 0)) {
      const forces = this.forceCalc.getLatestForces();
      this.ui.pushForces(forces, this.simTime);
      this.sweep.update(forces, this.simTime);
    }

    this.timer.begin("render");
    this.renderer.render(
      {
        pressure: this.solver.getPressureTexture(),
        obstacle,
        trail: this.particles.getTrailTexture(),
        velocity: this.solver.getVelocityTexture(),
        vorticity: this.solver.getVorticityTexture(),
      },
      { viewMode: this.params.viewMode, scale: this.params.pressureScale, dt, airspeed: this.params.airspeed },
      this.forceCalc.getLatestForces()
    );
    this.timer.end();

    if (this.screenshotRequested) {
      this.screenshotRequested = false;
      this.saveScreenshot();
    }

    this.ui.update(time, this.fps);
    if (time - this.lastUrlSync > URL_SYNC_MS) {
      this.lastUrlSync = time;
      this.syncUrl();
    }

    this.cpuMs += (performance.now() - cpuStart - this.cpuMs) * 0.1;
    if (this.timer.enabled) {
      this.timer.poll();
      const ms = (label: string) => {
        const v = this.timer.get(label);
        return v === undefined ? "--" : v.toFixed(2);
      };
      this.ui.setDebugText(
        `${this.fps.toFixed(0)} fps · cpu ${this.cpuMs.toFixed(2)}ms\n` +
          `solver ${ms("solver")}ms/step\n` +
          `particles ${ms("particles")}ms · render ${ms("render")}ms`
      );
    }
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    this.rafId = requestAnimationFrame((t) => {
      this.lastFrameTime = t;
      this.frame(t);
    });
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Stops the loop and removes everything this simulation added to the page. */
  dispose(): void {
    this.stop();
    this.resizeObserver.disconnect();
    this.ui.dispose();
    this.container.replaceChildren();
    this.container.classList.remove("panel-hidden");
  }
}
