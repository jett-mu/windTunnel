import { GLContext } from "./gl/GLContext";
import { GpuTimer } from "./gl/GpuTimer";
import { FluidSolver } from "./solver/FluidSolver";
import { GRID_W, GRID_H, DEFAULT_SOLVER_PARAMS, viewShowsParticles } from "./solver/SolverParams";
import type { SolverParams } from "./solver/SolverParams";
import { Airfoil, DEFAULT_AIRFOIL_PARAMS } from "./airfoil/Airfoil";
import type { AirfoilParams } from "./airfoil/Airfoil";
import { ObstacleMask } from "./airfoil/ObstacleMask";
import { ParticleSystem } from "./particles/ParticleSystem";
import { SmokeRake } from "./smoke/SmokeRake";
import { ForceCalculator } from "./forces/ForceCalculator";
import { Renderer } from "./render/Renderer";
import { PolarSweep } from "./analysis/PolarSweep";
import { UIController } from "./ui/UIController";
import { AirfoilDragController } from "./ui/AirfoilDragController";
import { downloadBlob } from "./ui/download";
import { encodeState, decodeState } from "./state/UrlState";
import { wallSlip } from "./solver/wallModel";

const PARTICLE_COLOR: [number, number, number] = [0.85, 0.95, 1.0];
/** Streak width in CSS pixels; scaled by the backing-store DPR so particles
 * look the same on any display. */
const PARTICLE_WIDTH_CSS = 1.2;
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
  private smoke: SmokeRake;
  /** Smoke is only advected while it's on screen; turning it back on restarts from a clean tunnel. */
  private smokeActive = false;
  private forceCalc: ForceCalculator;
  private renderer: Renderer;
  private sweep: PolarSweep;
  private ui: UIController;
  private params: SolverParams;
  private timer: GpuTimer;
  private debug: boolean;
  /** Debug HUD: wall-clock ms per solver step from a periodic GPU-synced sample. */
  private solverMs: number | null = null;
  private debugFrame = 0;

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
  /** Freestream speed the solver's current flow field was built for. */
  private flowAirspeed = 0;
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
    const query = new URLSearchParams(location.search);
    this.debug = query.has("debug");
    this.timer = new GpuTimer(this.glCtx.gl, this.debug);
    // Debug-only solver overrides for A/B comparison: ?solver=jacobi, ?mgcycles=N.
    const cycles = Number(query.get("mgcycles"));
    this.solver = new FluidSolver(
      this.glCtx,
      query.get("solver") === "jacobi" ? "jacobi" : "multigrid",
      Number.isInteger(cycles) && cycles > 0 && cycles <= 8 ? cycles : undefined
    );
    this.airfoil = new Airfoil(GRID_W, GRID_H, state.airfoil);
    this.obstacleMask = new ObstacleMask(this.glCtx.gl, GRID_W, GRID_H);
    this.sweep = new PolarSweep(this.airfoil);

    this.fitCanvas();
    this.particles = new ParticleSystem(this.glCtx, this.params.particleCount, this.canvas.width, this.canvas.height);
    this.smoke = new SmokeRake(this.glCtx);
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
    this.flowAirspeed = this.params.airspeed;

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.stage);

    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.stop();
      hooks.onContextLost();
    });

    if (this.debug) {
      (window as unknown as { __wt: unknown }).__wt = {
        divergence: () => this.solver.measureDivergence(),
        residual: () => this.solver.measureResidual(),
        forces: () => this.forceCalc.getLatestForces(),
        dump: () => {
          const d = this.solver.debugDump();
          return { ...d, vel: Array.from(d.vel), div: Array.from(d.div), poly: this.airfoil.getWorldPolygon() };
        },
        // Wall-clock ms per solver step over `n` back-to-back steps, GPU-synced.
        benchSolver: (n = 300) => {
          const slip = this.wallSlip();
          for (let i = 0; i < 30; i++) this.solver.step(this.params.dt, this.params, slip);
          this.gpuSync();
          const t0 = performance.now();
          for (let i = 0; i < n; i++) this.solver.step(this.params.dt, this.params, slip);
          this.gpuSync();
          return (performance.now() - t0) / n;
        },
      };
    }
  }

  private wallSlip(): number {
    return wallSlip(this.params.airspeed, this.params.viscosity, this.airfoil.getReferenceLength());
  }

  /** Debug-only: blocks until the GPU has finished all queued solver work (1-texel readback). */
  private gpuSync(): void {
    const gl = this.glCtx.gl;
    this.solver.velocity.read.bind(true);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4));
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
    // The lost event is dispatched asynchronously, so a resize can land
    // between the context dying and dispose(); GPU allocations would throw.
    if (this.glCtx.gl.isContextLost()) return;
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
    this.flowAirspeed = this.params.airspeed;
    this.particles.clearTrails();
    this.smoke.clear();
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
    if (!this.running || this.glCtx.gl.isContextLost()) return;
    this.rafId = requestAnimationFrame(this.frame);

    const wallDt = Math.min(Math.max((time - this.lastFrameTime) / 1000, 0), MAX_FRAME_S);
    this.lastFrameTime = time;
    if (wallDt > 0) this.fps += (1 / wallDt - this.fps) * 0.08;
    const cpuStart = performance.now();

    this.syncObstacle();
    if (this.params.airspeed !== this.flowAirspeed) {
      this.solver.rescale(this.params.airspeed / this.flowAirspeed);
      this.flowAirspeed = this.params.airspeed;
    }

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
    // Debug HUD: about once a second, wall-time this frame's solver steps
    // between two GPU syncs. GPU timer queries are unreliable here: on some
    // backends (ANGLE/Metal) a long-running fragment, like the single-pass
    // coarse multigrid solve, inflates TIME_ELAPSED several-fold.
    const sample = this.debug && steps > 0 && ++this.debugFrame % 60 === 0;
    if (sample) this.gpuSync();
    const solverStart = performance.now();
    const slip = this.wallSlip();
    for (let i = 0; i < steps; i++) this.solver.step(dt, this.params, slip);
    if (sample) {
      this.gpuSync();
      this.solverMs = (performance.now() - solverStart) / steps;
    }

    // Particles sit still (and cost nothing) while a standalone view is up.
    const smokeView = this.params.viewMode === "smoke";
    if (smokeView && !this.smokeActive) this.smoke.clear();
    this.smokeActive = smokeView;
    const particleSteps = viewShowsParticles(this.params.viewMode) ? steps : 0;

    this.timer.begin("particles");
    if (!this.paused) this.trailWallS += wallDt;
    if (particleSteps > 0) {
      // Trail fade is per wall-clock time (one `trailLength` factor per
      // 60 Hz frame), so trails look the same length at any refresh rate.
      const frames = this.paused ? particleSteps : this.trailWallS * 60;
      this.trailWallS = 0;
      this.particles.fadeTrails(Math.pow(this.params.trailLength, frames));
    }
    const style = {
      width: PARTICLE_WIDTH_CSS * GLContext.dpr(),
      color: PARTICLE_COLOR,
      colorBySpeed: this.params.particleColor === "speed",
    };
    for (let i = 0; i < particleSteps; i++) {
      this.particles.step(dt, this.solver.getVelocityTexture(), obstacle, this.params.airspeed);
      this.particles.drawStreaks(style, this.solver.getVelocityTexture(), this.params.airspeed, particleSteps);
    }
    if (smokeView) {
      const rake = {
        nozzles: this.params.smokeStreams,
        center: this.airfoil.params.posYFrac,
        span: this.params.smokeSpan,
      };
      for (let i = 0; i < steps; i++) this.smoke.step(dt, this.solver.getVelocityTexture(), obstacle, rake);
    }
    this.simTime += steps * dt;
    this.timer.end();

    const flow = {
      airspeed: this.params.airspeed,
      density: this.params.density,
      viscosity: this.params.viscosity,
      dt,
    };
    if (this.forceCalc.update(this.solver.getPressureTexture(), this.solver.getVelocityTexture(), flow, steps > 0)) {
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
        smoke: this.smoke.getTexture(),
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
    if (this.debug) {
      this.timer.poll();
      const ms = (label: string) => {
        const v = this.timer.get(label);
        return v === undefined ? "--" : v.toFixed(2);
      };
      this.ui.setDebugText(
        `${this.fps.toFixed(0)} fps · cpu ${this.cpuMs.toFixed(2)}ms\n` +
          `solver ${this.solverMs === null ? "--" : this.solverMs.toFixed(2)}ms/step\n` +
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
