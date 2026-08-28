import { GLContext } from "./gl/GLContext";
import { FluidSolver } from "./solver/FluidSolver";
import { GRID_W, GRID_H, DEFAULT_SOLVER_PARAMS } from "./solver/SolverParams";
import type { SolverParams } from "./solver/SolverParams";
import { Airfoil, DEFAULT_AIRFOIL_PARAMS } from "./airfoil/Airfoil";
import { ObstacleMask } from "./airfoil/ObstacleMask";
import { ParticleSystem } from "./particles/ParticleSystem";
import { ForceCalculator } from "./forces/ForceCalculator";
import { Renderer } from "./render/Renderer";
import { UIController } from "./ui/UIController";
import { AirfoilDragController } from "./ui/AirfoilDragController";

const PARTICLE_COLOR: [number, number, number] = [0.85, 0.95, 1.0];
const PARTICLE_POINT_SIZE = 3.9;

export class Simulation {
  private glCtx: GLContext;
  private solver: FluidSolver;
  private airfoil: Airfoil;
  private obstacleMask: ObstacleMask;
  private particles: ParticleSystem;
  private forceCalc: ForceCalculator;
  private renderer: Renderer;
  private ui: UIController;
  private params: SolverParams;

  private lastFrameTime = 0;
  private fps = 60;
  private simTime = 0;
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    const canvas = document.createElement("canvas");
    canvas.id = "sim-canvas";
    container.appendChild(canvas);

    this.glCtx = new GLContext(canvas);
    this.solver = new FluidSolver(this.glCtx);
    this.airfoil = new Airfoil(GRID_W, GRID_H, DEFAULT_AIRFOIL_PARAMS);
    this.obstacleMask = new ObstacleMask(this.glCtx.gl, GRID_W, GRID_H);
    this.params = { ...DEFAULT_SOLVER_PARAMS };

    this.resizeCanvas();
    this.particles = new ParticleSystem(
      this.glCtx,
      this.params.particleCount,
      canvas.width,
      canvas.height
    );
    this.forceCalc = new ForceCalculator(this.glCtx, this.airfoil);
    this.renderer = new Renderer(this.glCtx, this.airfoil);
    this.ui = new UIController(container, this.params, this.airfoil, (n) =>
      this.particles.setParticleCount(n)
    );
    new AirfoilDragController(canvas, this.airfoil);

    this.obstacleMask.update(this.airfoil.getWorldPolygon(), this.airfoil.version);

    window.addEventListener("resize", () => this.handleResize());
  }

  private resizeCanvas(): void {
    const rect = this.container.getBoundingClientRect();
    this.glCtx.resize(rect.width, rect.height);
  }

  private handleResize(): void {
    this.resizeCanvas();
    this.particles.resizeTrail(this.glCtx.canvas.width, this.glCtx.canvas.height);
  }

  private frame = (time: number): void => {
    const deltaMs = time - this.lastFrameTime;
    this.lastFrameTime = time;
    if (deltaMs > 0 && deltaMs < 1000) {
      const instantFps = 1000 / deltaMs;
      this.fps += (instantFps - this.fps) * 0.08;
    }

    this.obstacleMask.update(this.airfoil.getWorldPolygon(), this.airfoil.version);

    // Sub-step at a fixed dt (for solver stability/accuracy) rather than
    // enlarging dt itself, so raising the tick rate speeds up simulated time
    // without any loss of per-step quality.
    const dt = this.params.dt;
    const ticks = Math.max(1, Math.round(this.params.tickRate));
    for (let i = 0; i < ticks; i++) {
      this.solver.step(dt, this.params, this.obstacleMask.getTexture());
      this.particles.step(dt, this.solver.getVelocityTexture(), this.obstacleMask.getTexture());
      this.simTime += dt;
    }
    this.particles.render(this.params.trailLength, PARTICLE_POINT_SIZE, PARTICLE_COLOR);

    this.forceCalc.update(
      this.solver.getPressureTexture(),
      this.params.airspeed,
      this.params.density,
      this.params.viscosity
    );

    this.renderer.render(
      this.solver.getPressureTexture(),
      this.obstacleMask.getTexture(),
      this.particles.getTrailTexture(),
      this.params.pressureScale,
      this.forceCalc.getLatestForces()
    );

    this.ui.updateReadouts(this.forceCalc.getLatestForces(), this.fps, this.simTime);

    requestAnimationFrame(this.frame);
  };

  start(): void {
    requestAnimationFrame((t) => {
      this.lastFrameTime = t;
      requestAnimationFrame(this.frame);
    });
  }
}
