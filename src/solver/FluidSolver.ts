import { GLContext } from "../gl/GLContext";
import { Shader } from "../gl/Shader";
import { DoubleFBO, Framebuffer, makeFormats } from "../gl/Framebuffer";
import { FullscreenQuad } from "../gl/FullscreenQuad";
import { GRID_W, GRID_H, PRESSURE_ITERATIONS, DIFFUSE_ITERATIONS } from "./SolverParams";
import type { SolverParams } from "./SolverParams";

import passthroughVert from "./shaders/passthrough.vert?raw";
import copyFrag from "./shaders/copy.frag?raw";
import advectFrag from "./shaders/advect.frag?raw";
import forcesFrag from "./shaders/forces.frag?raw";
import vorticityFrag from "./shaders/vorticity.frag?raw";
import vorticityConfineFrag from "./shaders/vorticityConfine.frag?raw";
import diffuseFrag from "./shaders/diffuse.frag?raw";
import divergenceFrag from "./shaders/divergence.frag?raw";
import jacobiPressureFrag from "./shaders/jacobiPressure.frag?raw";
import pressureRelaxFrag from "./shaders/pressureRelax.frag?raw";
import gradientSubtractFrag from "./shaders/gradientSubtract.frag?raw";
import boundaryFrag from "./shaders/boundary.frag?raw";

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
  private divergence: Framebuffer;
  private vorticity: Framebuffer;
  private diffuseScratch: Framebuffer;

  private copyShader: Shader;
  private advectShader: Shader;
  private forcesShader: Shader;
  private vorticityShader: Shader;
  private vorticityConfineShader: Shader;
  private diffuseShader: Shader;
  private divergenceShader: Shader;
  private jacobiPressureShader: Shader;
  private pressureRelaxShader: Shader;
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
    this.diffuseScratch = new Framebuffer(gl, GRID_W, GRID_H, fmt.RG32F, filter);

    this.copyShader = new Shader(gl, passthroughVert, copyFrag);
    this.advectShader = new Shader(gl, passthroughVert, advectFrag);
    this.forcesShader = new Shader(gl, passthroughVert, forcesFrag);
    this.vorticityShader = new Shader(gl, passthroughVert, vorticityFrag);
    this.vorticityConfineShader = new Shader(gl, passthroughVert, vorticityConfineFrag);
    this.diffuseShader = new Shader(gl, passthroughVert, diffuseFrag);
    this.divergenceShader = new Shader(gl, passthroughVert, divergenceFrag);
    this.jacobiPressureShader = new Shader(gl, passthroughVert, jacobiPressureFrag);
    this.pressureRelaxShader = new Shader(gl, passthroughVert, pressureRelaxFrag);
    this.gradientSubtractShader = new Shader(gl, passthroughVert, gradientSubtractFrag);
    this.boundaryShader = new Shader(gl, passthroughVert, boundaryFrag);
  }

  getVelocityTexture(): WebGLTexture {
    return this.velocity.read.texture;
  }

  getPressureTexture(): WebGLTexture {
    return this.pressure.read.texture;
  }

  private runBoundary(obstacle: WebGLTexture, airspeed: number): void {
    this.velocity.write.bind();
    this.boundaryShader.use();
    this.boundaryShader.setTexture(0, "uVelocity", this.velocity.read.texture);
    this.boundaryShader.setTexture(1, "uObstacle", obstacle);
    this.boundaryShader.setVec2("uTexel", this.texel[0], this.texel[1]);
    this.boundaryShader.setFloat("uInflowSpeed", airspeed);
    this.boundaryShader.setFloat("uMaxSpeed", airspeed * 6.0);
    this.quad.draw();
    this.velocity.swap();
  }

  step(dt: number, params: SolverParams, obstacle: WebGLTexture): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    // 1. Advect velocity (semi-Lagrangian).
    this.velocity.write.bind();
    this.advectShader.use();
    this.advectShader.setTexture(0, "uVelocity", this.velocity.read.texture);
    this.advectShader.setTexture(1, "uSource", this.velocity.read.texture);
    this.advectShader.setVec2("uTexel", this.texel[0], this.texel[1]);
    this.advectShader.setFloat("uDt", dt);
    this.quad.draw();
    this.velocity.swap();

    // 2. External forces (no-op stub in v1).
    this.velocity.write.bind();
    this.forcesShader.use();
    this.forcesShader.setTexture(0, "uVelocity", this.velocity.read.texture);
    this.forcesShader.setVec2("uForce", 0, 0);
    this.forcesShader.setFloat("uDt", dt);
    this.quad.draw();
    this.velocity.swap();

    // 3. Vorticity (curl).
    this.vorticity.bind();
    this.vorticityShader.use();
    this.vorticityShader.setTexture(0, "uVelocity", this.velocity.read.texture);
    this.vorticityShader.setVec2("uTexel", this.texel[0], this.texel[1]);
    this.quad.draw();

    // 4. Vorticity confinement.
    this.velocity.write.bind();
    this.vorticityConfineShader.use();
    this.vorticityConfineShader.setTexture(0, "uVelocity", this.velocity.read.texture);
    this.vorticityConfineShader.setTexture(1, "uVorticity", this.vorticity.texture);
    this.vorticityConfineShader.setVec2("uTexel", this.texel[0], this.texel[1]);
    this.vorticityConfineShader.setFloat("uEpsilon", params.vorticityEpsilon);
    this.vorticityConfineShader.setFloat("uDt", dt);
    this.quad.draw();
    this.velocity.swap();

    // 5. Diffuse (viscosity) via Jacobi iteration against a fixed x0 snapshot.
    this.diffuseScratch.bind();
    this.copyShader.use();
    this.copyShader.setTexture(0, "uSource", this.velocity.read.texture);
    this.quad.draw();

    const alpha = params.viscosity * dt;
    const invBeta = 1 / (1 + 4 * alpha);
    for (let i = 0; i < DIFFUSE_ITERATIONS; i++) {
      this.velocity.write.bind();
      this.diffuseShader.use();
      this.diffuseShader.setTexture(0, "uX", this.velocity.read.texture);
      this.diffuseShader.setTexture(1, "uX0", this.diffuseScratch.texture);
      this.diffuseShader.setVec2("uTexel", this.texel[0], this.texel[1]);
      this.diffuseShader.setFloat("uAlpha", alpha);
      this.diffuseShader.setFloat("uInvBeta", invBeta);
      this.quad.draw();
      this.velocity.swap();
    }

    // 6. Divergence.
    this.divergence.bind();
    this.divergenceShader.use();
    this.divergenceShader.setTexture(0, "uVelocity", this.velocity.read.texture);
    this.divergenceShader.setVec2("uTexel", this.texel[0], this.texel[1]);
    this.quad.draw();

    // 7. Boundary conditions (obstacle no-slip + inflow/outflow/walls).
    this.runBoundary(obstacle, params.airspeed);

    // 8. Jacobi pressure (Poisson) solve, warm-started from last frame.
    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      this.pressure.write.bind();
      this.jacobiPressureShader.use();
      this.jacobiPressureShader.setTexture(0, "uPressure", this.pressure.read.texture);
      this.jacobiPressureShader.setTexture(1, "uDivergence", this.divergence.texture);
      this.jacobiPressureShader.setTexture(2, "uObstacle", obstacle);
      this.jacobiPressureShader.setVec2("uTexel", this.texel[0], this.texel[1]);
      this.quad.draw();
      this.pressure.swap();
    }

    // 8b. Bleed off any slowly-accumulated global mean-pressure drift (the
    // inflow/outflow boundary pair doesn't perfectly conserve mass every
    // frame) so the whole field doesn't drift to an arbitrary uniform level
    // over a long-running session.
    this.pressure.write.bind();
    this.pressureRelaxShader.use();
    this.pressureRelaxShader.setTexture(0, "uPressure", this.pressure.read.texture);
    this.pressureRelaxShader.setFloat("uDecay", 0.97);
    this.quad.draw();
    this.pressure.swap();

    // 9. Subtract pressure gradient (projection).
    this.velocity.write.bind();
    this.gradientSubtractShader.use();
    this.gradientSubtractShader.setTexture(0, "uVelocity", this.velocity.read.texture);
    this.gradientSubtractShader.setTexture(1, "uPressure", this.pressure.read.texture);
    this.gradientSubtractShader.setTexture(2, "uObstacle", obstacle);
    this.gradientSubtractShader.setVec2("uTexel", this.texel[0], this.texel[1]);
    this.quad.draw();
    this.velocity.swap();

    // 10. Re-enforce obstacle/boundary conditions post-projection.
    this.runBoundary(obstacle, params.airspeed);
  }
}
