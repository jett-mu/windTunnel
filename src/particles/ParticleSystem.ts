import { GLContext } from "../gl/GLContext";
import { Shader } from "../gl/Shader";
import { DoubleFBO, makeFormats } from "../gl/Framebuffer";
import { FullscreenQuad } from "../gl/FullscreenQuad";
import { clamp } from "../gl/math";
import { GRID_W, GRID_H } from "../solver/SolverParams";

import passthroughVert from "../solver/shaders/passthrough.vert?raw";
import trailDecayFrag from "./shaders/trailDecay.frag?raw";
import particleUpdateVert from "./shaders/particleUpdate.vert?raw";
import particleUpdateFrag from "./shaders/particleUpdate.frag?raw";
import particleRenderVert from "./shaders/particleRender.vert?raw";
import particleRenderFrag from "./shaders/particleRender.frag?raw";

/** Particle lifetime is long enough to cross the tunnel this many times at freestream speed. */
const LIFETIME_CROSSINGS = 1.5;
const MIN_MAX_AGE_S = 2;
const MAX_MAX_AGE_S = 60;
/** Streaks up to this many widths long draw at full opacity (see uInkLength). */
const INK_LENGTH_WIDTHS = 2;

export interface ParticleStyle {
  /** Streak width, device pixels. */
  width: number;
  color: [number, number, number];
  colorBySpeed: boolean;
}

/**
 * GPU-resident particle streamlines. Particle advection runs entirely on the
 * GPU via transform feedback (a vertex shader samples the velocity texture
 * and writes updated positions back out, no CPU readback); trails are drawn
 * into a fading accumulation buffer rather than tracked as per-particle history.
 */
export class ParticleSystem {
  private gl: WebGL2RenderingContext;
  private quad: FullscreenQuad;

  private updateShader: Shader;
  private renderShader: Shader;
  private trailDecayShader: Shader;

  private buffers: [WebGLBuffer, WebGLBuffer];
  private updateVaos: [WebGLVertexArrayObject, WebGLVertexArrayObject];
  /** streakVaos[k]: buffer k as the current position, the other as the previous. */
  private streakVaos: [WebGLVertexArrayObject, WebGLVertexArrayObject];
  private current = 0;
  private count: number;
  private frame = 0;

  /** Premultiplied-alpha RGBA16F: 8-bit storage can't fade to zero, since
   * small values round back up under repeated multiplication by the decay. */
  trailAccum: DoubleFBO;
  private trailW: number;
  private trailH: number;

  constructor(glCtx: GLContext, initialCount: number, trailWidth: number, trailHeight: number) {
    const gl = glCtx.gl;
    this.gl = gl;
    this.quad = new FullscreenQuad(gl);
    this.count = initialCount;
    this.trailW = trailWidth;
    this.trailH = trailHeight;

    this.updateShader = new Shader(gl, particleUpdateVert, particleUpdateFrag, {
      transformFeedbackVaryings: ["vPosAge"],
    });
    this.renderShader = new Shader(gl, particleRenderVert, particleRenderFrag);
    this.trailDecayShader = new Shader(gl, passthroughVert, trailDecayFrag);

    this.trailAccum = new DoubleFBO(gl, trailWidth, trailHeight, makeFormats(gl).RGBA16F, gl.LINEAR);

    const [bufA, bufB] = this.createBuffers(this.count);
    this.buffers = [bufA, bufB];
    this.updateVaos = [this.makeVao(bufA), this.makeVao(bufB)];
    this.streakVaos = [this.makeStreakVao(bufA, bufB), this.makeStreakVao(bufB, bufA)];
  }

  /** Lifetime scales with airspeed so particles can always cross the tunnel. */
  private static maxAge(airspeed: number): number {
    return clamp((LIFETIME_CROSSINGS * GRID_W) / Math.max(airspeed, 1e-3), MIN_MAX_AGE_S, MAX_MAX_AGE_S);
  }

  private randomInitialData(n: number): Float32Array {
    const data = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      data[i * 3 + 0] = Math.random(); // x, spread across the whole domain initially
      data[i * 3 + 1] = Math.random(); // y
      data[i * 3 + 2] = Math.random() * MIN_MAX_AGE_S; // stagger ages so respawns don't sync
    }
    return data;
  }

  private createBuffers(n: number): [WebGLBuffer, WebGLBuffer] {
    const gl = this.gl;
    const data = this.randomInitialData(n);
    const make = () => {
      const buf = gl.createBuffer();
      if (!buf) throw new Error("Failed to create particle buffer");
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY);
      return buf;
    };
    const a = make();
    const b = make();
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return [a, b];
  }

  private makeVao(buffer: WebGLBuffer): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("Failed to create particle VAO");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  /** Instanced: one streak quad per particle, reading its current and previous state. */
  private makeStreakVao(curr: WebGLBuffer, prev: WebGLBuffer): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("Failed to create particle streak VAO");
    gl.bindVertexArray(vao);
    [curr, prev].forEach((buf, loc) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(loc, 1);
    });
    gl.bindVertexArray(null);
    return vao;
  }

  setParticleCount(n: number): void {
    if (n === this.count) return;
    const gl = this.gl;
    gl.deleteBuffer(this.buffers[0]);
    gl.deleteBuffer(this.buffers[1]);
    gl.deleteVertexArray(this.updateVaos[0]);
    gl.deleteVertexArray(this.updateVaos[1]);
    gl.deleteVertexArray(this.streakVaos[0]);
    gl.deleteVertexArray(this.streakVaos[1]);

    this.count = n;
    const [bufA, bufB] = this.createBuffers(n);
    this.buffers = [bufA, bufB];
    this.updateVaos = [this.makeVao(bufA), this.makeVao(bufB)];
    this.streakVaos = [this.makeStreakVao(bufA, bufB), this.makeStreakVao(bufB, bufA)];
    this.current = 0;
  }

  resizeTrail(width: number, height: number): void {
    if (width === this.trailW && height === this.trailH) return;
    this.trailW = width;
    this.trailH = height;
    this.trailAccum.dispose();
    this.trailAccum = new DoubleFBO(this.gl, width, height, makeFormats(this.gl).RGBA16F, this.gl.LINEAR);
  }

  clearTrails(): void {
    this.trailAccum.clear();
  }

  /** GPU transform-feedback advection step. */
  step(dt: number, velocityTexture: WebGLTexture, obstacleTexture: WebGLTexture, airspeed: number): void {
    const gl = this.gl;

    // The fluid solver leaves one of its own FBOs bound as the current draw
    // framebuffer; binding the default framebuffer avoids tripping WebGL's
    // feedback-loop check when we sample that same texture as uVelocity below
    // (rasterization is discarded, so nothing is actually written to it, but
    // the validation runs regardless of RASTERIZER_DISCARD).
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.updateShader.use();
    this.updateShader.setTexture(0, "uVelocity", velocityTexture);
    this.updateShader.setTexture(1, "uObstacle", obstacleTexture);
    this.updateShader.setVec2("uVelScale", 1 / GRID_W, 1 / GRID_H);
    this.updateShader.setFloat("uDt", dt);
    this.updateShader.setFloat("uMaxAge", ParticleSystem.maxAge(airspeed));
    this.updateShader.setInt("uFrame", this.frame++ & 0x7fffffff);
    this.updateShader.setFloat("uInjectWidth", Math.max(airspeed * dt, 1) / GRID_W);

    gl.bindVertexArray(this.updateVaos[this.current]);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.buffers[1 - this.current]);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.endTransformFeedback();
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindVertexArray(null);

    this.current = 1 - this.current;
  }

  /** Fades the trail-accumulation buffer once per frame, before this frame's streaks are drawn. */
  fadeTrails(decay: number): void {
    this.trailAccum.write.bind();
    this.gl.disable(this.gl.BLEND);
    this.trailDecayShader.use();
    this.trailDecayShader.setTexture(0, "uPrev", this.trailAccum.read.texture);
    this.trailDecayShader.setFloat("uDecay", decay);
    this.quad.draw();
    this.trailAccum.swap();
  }

  /**
   * Draws every particle's movement over the latest step as a streak onto
   * the trail buffer. Call after each `step()`, so the streaks of a frame's
   * several steps join up. `trailAccum.read` holds the composited result,
   * ready for the Renderer to sample.
   */
  /**
   * `stepsThisFrame` spreads a frame's ink across its steps, so trail
   * density doesn't depend on the sim-speed setting.
   */
  drawStreaks(style: ParticleStyle, velocityTexture: WebGLTexture, airspeed: number, stepsThisFrame: number): void {
    const gl = this.gl;
    // Color uses straight-alpha "over"; alpha accumulates as
    // a + dst*(1-a) (not a*a), keeping the buffer premultiplied.
    this.trailAccum.read.bind(true);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const s = this.renderShader;
    s.use();
    s.setTexture(0, "uVelocity", velocityTexture);
    s.setVec2("uViewport", this.trailW, this.trailH);
    s.setFloat("uHalfWidth", style.width / 2);
    s.setFloat("uInkLength", (style.width * INK_LENGTH_WIDTHS) / Math.max(stepsThisFrame, 1));
    s.setVec3("uColor", style.color[0], style.color[1], style.color[2]);
    s.setInt("uColorBySpeed", style.colorBySpeed ? 1 : 0);
    s.setFloat("uFreestream", airspeed);
    gl.bindVertexArray(this.streakVaos[this.current]);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  getTrailTexture(): WebGLTexture {
    return this.trailAccum.read.texture;
  }
}
