import { GLContext } from "../gl/GLContext";
import { Shader } from "../gl/Shader";
import { DoubleFBO, Framebuffer, makeFormats } from "../gl/Framebuffer";
import { FullscreenQuad } from "../gl/FullscreenQuad";
import { Multigrid } from "./Multigrid";
import {
  GRID_W,
  GRID_H,
  PRESSURE_SOLVER,
  MULTIGRID_CYCLES,
  JACOBI_ITERATIONS,
  MAX_SPEED_FACTOR,
} from "./SolverParams";
import type { SolverParams } from "./SolverParams";

import passthroughVert from "./shaders/passthrough.vert?raw";
import advectFrag from "./shaders/advect.frag?raw";
import maccormackFrag from "./shaders/maccormack.frag?raw";
import forcesFrag from "./shaders/forces.frag?raw";
import vorticityFrag from "./shaders/vorticity.frag?raw";
import divergenceFrag from "./shaders/divergence.frag?raw";
import gradientSubtractFrag from "./shaders/gradientSubtract.frag?raw";
import boundaryFrag from "./shaders/boundary.frag?raw";

/** Explicit diffusion is stable for nu*dt < 0.25; stay well inside that. */
const MAX_DIFFUSION_ALPHA = 0.2;

/**
 * Owns and steps the GPU stable-fluids Navier-Stokes solver. All fields live
 * on a fixed-resolution grid of float textures, independent of canvas size.
 */
export class FluidSolver {
  private gl: WebGL2RenderingContext;
  private quad: FullscreenQuad;
  private texel: [number, number];

  velocity: DoubleFBO;
  pressure: DoubleFBO;
  /** Vorticity (curl) of the most recent step, also used for display. */
  vorticity: Framebuffer;
  private divergence: Framebuffer;
  private advectForward: Framebuffer;
  private advectBackward: Framebuffer;
  private multigrid: Multigrid;
  private obstacle: WebGLTexture | null = null;

  private advectShader: Shader;
  private maccormackShader: Shader;
  private forcesShader: Shader;
  private vorticityShader: Shader;
  private divergenceShader: Shader;
  private gradientSubtractShader: Shader;
  private boundaryShader: Shader;

  constructor(glCtx: GLContext) {
    const gl = glCtx.gl;
    this.gl = gl;
    this.quad = new FullscreenQuad(gl);
    this.texel = [1 / GRID_W, 1 / GRID_H];

    const fmt = makeFormats(gl);
    const filter = glCtx.caps.linearFloatFilter ? gl.LINEAR : gl.NEAREST;

    this.velocity = new DoubleFBO(gl, GRID_W, GRID_H, fmt.RG32F, filter);
    this.pressure = new DoubleFBO(gl, GRID_W, GRID_H, fmt.R32F, filter);
    this.divergence = new Framebuffer(gl, GRID_W, GRID_H, fmt.R32F, filter);
    this.vorticity = new Framebuffer(gl, GRID_W, GRID_H, fmt.R32F, filter);
    this.advectForward = new Framebuffer(gl, GRID_W, GRID_H, fmt.RG32F, filter);
    this.advectBackward = new Framebuffer(gl, GRID_W, GRID_H, fmt.RG32F, filter);
    this.multigrid = new Multigrid(gl, this.quad, filter, {
      pressure: this.pressure,
      rhs: this.divergence,
      w: GRID_W,
      h: GRID_H,
    });

    this.advectShader = new Shader(gl, passthroughVert, advectFrag);
    this.maccormackShader = new Shader(gl, passthroughVert, maccormackFrag);
    this.forcesShader = new Shader(gl, passthroughVert, forcesFrag);
    this.vorticityShader = new Shader(gl, passthroughVert, vorticityFrag);
    this.divergenceShader = new Shader(gl, passthroughVert, divergenceFrag);
    this.gradientSubtractShader = new Shader(gl, passthroughVert, gradientSubtractFrag);
    this.boundaryShader = new Shader(gl, passthroughVert, boundaryFrag);
  }

  getVelocityTexture(): WebGLTexture {
    return this.velocity.read.texture;
  }

  getPressureTexture(): WebGLTexture {
    return this.pressure.read.texture;
  }

  getVorticityTexture(): WebGLTexture {
    return this.vorticity.texture;
  }

  /** Call whenever the obstacle mask's contents change (not every step). */
  setObstacle(obstacle: WebGLTexture): void {
    this.obstacle = obstacle;
    this.multigrid.setObstacle(obstacle);
  }

  /** Restarts the flow from uniform freestream with zero pressure. */
  reset(airspeed: number): void {
    this.velocity.clear(airspeed, 0, 0, 0);
    this.pressure.clear();
    this.vorticity.clear();
  }

  private runBoundary(airspeed: number): void {
    const s = this.boundaryShader;
    this.velocity.write.bind();
    s.use();
    s.setTexture(0, "uVelocity", this.velocity.read.texture);
    s.setTexture(1, "uObstacle", this.obstacle);
    s.setTexture(2, "uNeighbors", this.multigrid.fineNeighbors);
    s.setVec2("uTexel", this.texel[0], this.texel[1]);
    s.setFloat("uInflowSpeed", airspeed);
    s.setFloat("uMaxSpeed", airspeed * MAX_SPEED_FACTOR);
    this.quad.draw();
    this.velocity.swap();
  }

  private advect(target: Framebuffer, source: WebGLTexture, dt: number): void {
    const s = this.advectShader;
    target.bind();
    s.use();
    s.setTexture(0, "uVelocity", this.velocity.read.texture);
    s.setTexture(1, "uSource", source);
    s.setVec2("uTexel", this.texel[0], this.texel[1]);
    s.setFloat("uDt", dt);
    this.quad.draw();
  }

  step(dt: number, params: SolverParams): void {
    const gl = this.gl;
    if (!this.obstacle) throw new Error("FluidSolver.setObstacle must be called before step");
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    // 1. Advect velocity (MacCormack: forward + backward semi-Lagrangian
    //    traces, then a limited error-cancelling correction).
    this.advect(this.advectForward, this.velocity.read.texture, dt);
    this.advect(this.advectBackward, this.advectForward.texture, -dt);
    const mc = this.maccormackShader;
    this.velocity.write.bind();
    mc.use();
    mc.setTexture(0, "uSource", this.velocity.read.texture);
    mc.setTexture(1, "uForward", this.advectForward.texture);
    mc.setTexture(2, "uBackward", this.advectBackward.texture);
    mc.setTexture(3, "uObstacle", this.obstacle);
    mc.setVec2("uTexel", this.texel[0], this.texel[1]);
    mc.setFloat("uDt", dt);
    this.quad.draw();
    this.velocity.swap();

    // 2. Vorticity (curl).
    this.vorticity.bind();
    this.vorticityShader.use();
    this.vorticityShader.setTexture(0, "uVelocity", this.velocity.read.texture);
    this.vorticityShader.setVec2("uTexel", this.texel[0], this.texel[1]);
    this.quad.draw();

    // 3. Viscosity + vorticity confinement, in one pass.
    const fs = this.forcesShader;
    this.velocity.write.bind();
    fs.use();
    fs.setTexture(0, "uVelocity", this.velocity.read.texture);
    fs.setTexture(1, "uVorticity", this.vorticity.texture);
    fs.setTexture(2, "uObstacle", this.obstacle);
    fs.setVec2("uTexel", this.texel[0], this.texel[1]);
    fs.setFloat("uDt", dt);
    fs.setFloat("uAlpha", Math.min(params.viscosity * dt, MAX_DIFFUSION_ALPHA));
    fs.setFloat("uEpsilon", params.vorticityEpsilon);
    this.quad.draw();
    this.velocity.swap();

    // 4. Boundary conditions, so the projection below sees the inflow and
    //    the obstacle's no-penetration condition.
    this.runBoundary(params.airspeed);

    // 5. Divergence.
    this.divergence.bind();
    this.divergenceShader.use();
    this.divergenceShader.setTexture(0, "uVelocity", this.velocity.read.texture);
    this.divergenceShader.setTexture(1, "uNeighbors", this.multigrid.fineNeighbors);
    this.divergenceShader.setVec2("uTexel", this.texel[0], this.texel[1]);
    this.quad.draw();

    // 6. Pressure Poisson solve, warm-started from the previous step.
    if (PRESSURE_SOLVER === "multigrid") this.multigrid.solve(MULTIGRID_CYCLES);
    else this.multigrid.jacobi(JACOBI_ITERATIONS);

    // 7. Subtract pressure gradient (projection).
    const gs = this.gradientSubtractShader;
    this.velocity.write.bind();
    gs.use();
    gs.setTexture(0, "uVelocity", this.velocity.read.texture);
    gs.setTexture(1, "uPressure", this.pressure.read.texture);
    gs.setTexture(2, "uNeighbors", this.multigrid.fineNeighbors);
    gs.setVec2("uTexel", this.texel[0], this.texel[1]);
    this.quad.draw();
    this.velocity.swap();

    // 8. Re-enforce obstacle/boundary conditions post-projection.
    this.runBoundary(params.airspeed);
  }

  /**
   * Debug-only (`?debug`): RMS divergence of the current velocity over fluid
   * cells, i.e. how well the last projection did. Synchronous readback.
   */
  measureDivergence(): number {
    const gl = this.gl;
    this.divergence.bind();
    this.divergenceShader.use();
    this.divergenceShader.setTexture(0, "uVelocity", this.velocity.read.texture);
    this.divergenceShader.setTexture(1, "uNeighbors", this.multigrid.fineNeighbors);
    this.divergenceShader.setVec2("uTexel", this.texel[0], this.texel[1]);
    this.quad.draw();
    const data = new Float32Array(GRID_W * GRID_H * 4);
    gl.readPixels(0, 0, GRID_W, GRID_H, gl.RGBA, gl.FLOAT, data);
    let sum = 0;
    let n = 0;
    // Skip the boundary ring, where the Dirichlet inlet/outlet legitimately
    // leave one-sided divergence.
    for (let y = 2; y < GRID_H - 2; y++) {
      for (let x = 2; x < GRID_W - 2; x++) {
        const d = data[(y * GRID_W + x) * 4];
        sum += d * d;
        n++;
      }
    }
    return Math.sqrt(sum / n);
  }
}
