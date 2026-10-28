import { GLContext } from "../gl/GLContext";
import { Shader } from "../gl/Shader";
import { DoubleFBO, Framebuffer, makeFormats } from "../gl/Framebuffer";
import { FullscreenQuad } from "../gl/FullscreenQuad";
import { GRID_W, GRID_H } from "../solver/SolverParams";

import passthroughVert from "../solver/shaders/passthrough.vert?raw";
import smokeAdvectFrag from "./shaders/smokeAdvect.frag?raw";
import smokeCorrectFrag from "./shaders/smokeCorrect.frag?raw";

/** Smoke is advected on a finer grid than the flow, so filaments stay thin. */
const SMOKE_RES = 2;
/** Nozzle half-width, solver grid cells. */
const NOZZLE_HALF_WIDTH = 1.1;

export interface RakeConfig {
  nozzles: number;
  /** Rake centre and span, as fractions of tunnel height. */
  center: number;
  span: number;
}

/**
 * Smoke-tunnel visualization: a rake of nozzles at the inlet emits thin
 * streams of a passive smoke density that the flow carries downstream. A
 * continuously released stream traces a streakline, as smoke does in a real
 * tunnel: it bends round the body, rolls up in the wake, and fills
 * separated regions instead of streaming past them.
 */
export class SmokeRake {
  private gl: WebGL2RenderingContext;
  private quad: FullscreenQuad;
  private texel: [number, number];

  private smoke: DoubleFBO;
  private forward: Framebuffer;
  private advectShader: Shader;
  private correctShader: Shader;

  constructor(glCtx: GLContext) {
    const gl = glCtx.gl;
    this.gl = gl;
    this.quad = new FullscreenQuad(gl);
    this.texel = [1 / GRID_W, 1 / GRID_H];

    // Half floats filter linearly on every WebGL2 device, unlike 32-bit ones.
    const fmt = makeFormats(gl).R16F;
    const w = GRID_W * SMOKE_RES;
    const h = GRID_H * SMOKE_RES;
    this.smoke = new DoubleFBO(gl, w, h, fmt, gl.LINEAR);
    this.forward = new Framebuffer(gl, w, h, fmt, gl.LINEAR);
    this.advectShader = new Shader(gl, passthroughVert, smokeAdvectFrag);
    this.correctShader = new Shader(gl, passthroughVert, smokeCorrectFrag);
  }

  clear(): void {
    this.smoke.clear();
  }

  step(dt: number, velocity: WebGLTexture, obstacle: WebGLTexture, rake: RakeConfig): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);

    const a = this.advectShader;
    this.forward.bind();
    a.use();
    a.setTexture(0, "uVelocity", velocity);
    a.setTexture(1, "uObstacle", obstacle);
    a.setTexture(2, "uSmoke", this.smoke.read.texture);
    a.setVec2("uTexel", this.texel[0], this.texel[1]);
    a.setFloat("uDt", dt);
    this.quad.draw();

    const c = this.correctShader;
    this.smoke.write.bind();
    c.use();
    c.setTexture(0, "uVelocity", velocity);
    c.setTexture(1, "uObstacle", obstacle);
    c.setTexture(2, "uSmoke", this.smoke.read.texture);
    c.setTexture(3, "uForward", this.forward.texture);
    c.setVec2("uTexel", this.texel[0], this.texel[1]);
    c.setFloat("uDt", dt);
    c.setVec2("uGridSize", GRID_W, GRID_H);
    c.setInt("uNozzles", Math.max(1, Math.round(rake.nozzles)));
    c.setFloat("uRakeCenter", rake.center);
    c.setFloat("uRakeSpan", rake.span);
    c.setFloat("uNozzleHalfWidth", NOZZLE_HALF_WIDTH);
    c.setFloat("uInjectWidth", 1.5 * this.texel[0]);
    this.quad.draw();
    this.smoke.swap();
  }

  getTexture(): WebGLTexture {
    return this.smoke.read.texture;
  }
}
