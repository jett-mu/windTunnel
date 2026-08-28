import { GLContext } from "../gl/GLContext";
import { Shader } from "../gl/Shader";
import { DoubleFBO, makeFormats } from "../gl/Framebuffer";
import { FullscreenQuad } from "../gl/FullscreenQuad";
import { GRID_W, GRID_H } from "../solver/SolverParams";

import passthroughVert from "../solver/shaders/passthrough.vert?raw";
import trailDecayFrag from "./shaders/trailDecay.frag?raw";
import particleUpdateVert from "./shaders/particleUpdate.vert?raw";
import particleUpdateFrag from "./shaders/particleUpdate.frag?raw";
import particleRenderVert from "./shaders/particleRender.vert?raw";
import particleRenderFrag from "./shaders/particleRender.frag?raw";

const MAX_AGE_SECONDS = 6.0;

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
  private renderVaos: [WebGLVertexArrayObject, WebGLVertexArrayObject];
  private current = 0;
  private count: number;

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

    const fmt = makeFormats(gl);
    this.trailAccum = new DoubleFBO(gl, trailWidth, trailHeight, fmt.RGBA8, gl.LINEAR);

    const [bufA, bufB] = this.createBuffers(this.count);
    this.buffers = [bufA, bufB];
    this.updateVaos = [this.makeVao(bufA), this.makeVao(bufB)];
    this.renderVaos = [this.makeVao(bufA), this.makeVao(bufB)];
  }

  private randomInitialData(n: number): Float32Array {
    const data = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      data[i * 3 + 0] = Math.random(); // x, spread across the whole domain initially
      data[i * 3 + 1] = Math.random(); // y
      data[i * 3 + 2] = Math.random() * MAX_AGE_SECONDS; // stagger ages so respawns don't sync
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

  setParticleCount(n: number): void {
    if (n === this.count) return;
    const gl = this.gl;
    gl.deleteBuffer(this.buffers[0]);
    gl.deleteBuffer(this.buffers[1]);
    gl.deleteVertexArray(this.updateVaos[0]);
    gl.deleteVertexArray(this.updateVaos[1]);
    gl.deleteVertexArray(this.renderVaos[0]);
    gl.deleteVertexArray(this.renderVaos[1]);

    this.count = n;
    const [bufA, bufB] = this.createBuffers(n);
    this.buffers = [bufA, bufB];
    this.updateVaos = [this.makeVao(bufA), this.makeVao(bufB)];
    this.renderVaos = [this.makeVao(bufA), this.makeVao(bufB)];
    this.current = 0;
  }

  resizeTrail(width: number, height: number): void {
    if (width === this.trailW && height === this.trailH) return;
    this.trailW = width;
    this.trailH = height;
    const fmt = makeFormats(this.gl);
    this.trailAccum = new DoubleFBO(this.gl, width, height, fmt.RGBA8, this.gl.LINEAR);
  }

  /** GPU transform-feedback advection step. */
  step(dt: number, velocityTexture: WebGLTexture, obstacleTexture: WebGLTexture): void {
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
    this.updateShader.setFloat("uMaxAge", MAX_AGE_SECONDS);
    this.updateShader.setFloat("uSeed", Math.random() * 1000.0);

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

  /**
   * Fades the trail-accumulation buffer, then draws the latest particle
   * positions on top of it. `trailAccum.read` holds the composited result
   * afterward, ready for the Renderer to sample.
   */
  render(decay: number, pointSize: number, color: [number, number, number]): void {
    const gl = this.gl;

    // 1. Decay previous trail contents into the write side.
    this.trailAccum.write.bind();
    gl.disable(gl.BLEND);
    this.trailDecayShader.use();
    this.trailDecayShader.setTexture(0, "uPrev", this.trailAccum.read.texture);
    this.trailDecayShader.setFloat("uDecay", decay);
    this.quad.draw();
    this.trailAccum.swap();

    // 2. Draw fresh particle points directly onto the now-faded buffer.
    this.trailAccum.read.bind();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.renderShader.use();
    this.renderShader.setFloat("uMaxAge", MAX_AGE_SECONDS);
    this.renderShader.setFloat("uPointSize", pointSize);
    this.renderShader.setVec3("uColor", color[0], color[1], color[2]);
    gl.bindVertexArray(this.renderVaos[this.current]);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  getTrailTexture(): WebGLTexture {
    return this.trailAccum.read.texture;
  }
}
