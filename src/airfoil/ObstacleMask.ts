import type { Vec2 } from "../gl/math";
import { Shader } from "../gl/Shader";
import { Framebuffer, makeFormats } from "../gl/Framebuffer";
import { FullscreenQuad } from "../gl/FullscreenQuad";

import shapeVert from "../render/shaders/shape.vert?raw";
import shapeFrag from "../render/shaders/shape.frag?raw";
import passthroughVert from "../solver/shaders/passthrough.vert?raw";
import restrictFrag from "../solver/shaders/restrict.frag?raw";

/** Rasterize at this multiple of the grid, then box-filter down. */
const SUPERSAMPLE = 2;
const MAX_MSAA_SAMPLES = 4;

/**
 * Rasterizes the body's world-space polygon into a GPU texture used by the
 * fluid solver as an obstacle mask (1 = solid, 0 = fluid, with an
 * anti-aliased gradient in between at the boundary), entirely on the GPU so
 * dragging the wing never stalls on a CPU raster + texture upload.
 *
 * The polygon can be concave (cambered lower surface) and even
 * self-overlapping (a deflected slat or flap folds the skin over itself), so
 * it's filled with the classic stencil-invert trick rather than
 * triangulated: a triangle fan from vertex 0 flips each sample's stencil bit
 * once per covering triangle, which leaves exactly the even-odd interior set.
 * Drawn into a multisampled target at 2x grid resolution, resolved, then
 * box-filtered down, giving each grid cell 16 coverage samples so the curved
 * leading edge doesn't degrade into a blocky staircase.
 */
export class ObstacleMask {
  private gl: WebGL2RenderingContext;
  private quad: FullscreenQuad;
  private shapeShader: Shader;
  private downsampleShader: Shader;
  private msaaFbo: WebGLFramebuffer;
  private resolve: Framebuffer;
  private output: Framebuffer;
  private hiW: number;
  private hiH: number;
  private gridW: number;
  private gridH: number;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private vertexData = new Float32Array(0);
  private lastVersion = -1;

  constructor(gl: WebGL2RenderingContext, width: number, height: number) {
    this.gl = gl;
    this.gridW = width;
    this.gridH = height;
    this.hiW = width * SUPERSAMPLE;
    this.hiH = height * SUPERSAMPLE;
    this.quad = new FullscreenQuad(gl);
    this.shapeShader = new Shader(gl, shapeVert, shapeFrag);
    this.downsampleShader = new Shader(gl, passthroughVert, restrictFrag);

    const maxSamples = (format: number) => {
      const counts = gl.getInternalformatParameter(gl.RENDERBUFFER, format, gl.SAMPLES) as Int32Array | null;
      return counts && counts.length > 0 ? counts[0] : 0;
    };
    const samples = Math.min(MAX_MSAA_SAMPLES, maxSamples(gl.R8), maxSamples(gl.DEPTH24_STENCIL8));

    const color = gl.createRenderbuffer();
    const depthStencil = gl.createRenderbuffer();
    const fbo = gl.createFramebuffer();
    if (!color || !depthStencil || !fbo) throw new Error("Failed to create obstacle mask render targets");
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.R8, this.hiW, this.hiH);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthStencil);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, this.hiW, this.hiH);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depthStencil);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Obstacle mask framebuffer incomplete: 0x${status.toString(16)}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.msaaFbo = fbo;

    const fmt = makeFormats(gl);
    this.resolve = new Framebuffer(gl, this.hiW, this.hiH, fmt.R8, gl.NEAREST);
    // Starts all-clear (no obstacle), so it's valid to sample before the first update().
    this.output = new Framebuffer(gl, width, height, fmt.R8, gl.LINEAR);

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error("Failed to create obstacle mask geometry");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vao = vao;
    this.vbo = vbo;
  }

  /** Re-rasterizes only if `version` differs from the last update. Returns whether it did. */
  update(polygon: Vec2[], version: number): boolean {
    if (version === this.lastVersion) return false;
    this.lastVersion = version;
    const gl = this.gl;

    if (this.vertexData.length !== polygon.length * 2) {
      this.vertexData = new Float32Array(polygon.length * 2);
    }
    polygon.forEach((p, i) => {
      this.vertexData[i * 2] = p.x;
      this.vertexData[i * 2 + 1] = p.y;
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData, gl.DYNAMIC_DRAW);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaaFbo);
    gl.viewport(0, 0, this.hiW, this.hiH);
    gl.disable(gl.BLEND);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);

    this.shapeShader.use();
    this.shapeShader.setVec2("uGridSize", this.gridW, this.gridH);
    this.shapeShader.setVec4("uColor", 1, 1, 1, 1);
    gl.bindVertexArray(this.vao);

    // Pass 1: stencil parity of the fan.
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, polygon.length);

    // Pass 2: color wherever parity is odd. Every interior sample is
    // covered by at least one fan triangle, so redrawing the fan suffices.
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, polygon.length);
    gl.disable(gl.STENCIL_TEST);
    gl.bindVertexArray(null);

    // Resolve MSAA, then 2x2 box filter down to grid resolution.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaaFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolve.fbo);
    gl.blitFramebuffer(0, 0, this.hiW, this.hiH, 0, 0, this.hiW, this.hiH, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

    this.output.bind();
    this.downsampleShader.use();
    this.downsampleShader.setTexture(0, "uFine", this.resolve.texture);
    this.quad.draw();
    return true;
  }

  getTexture(): WebGLTexture {
    return this.output.texture;
  }
}
