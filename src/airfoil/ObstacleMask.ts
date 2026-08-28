import type { Vec2 } from "../gl/math";

const SUPERSAMPLE = 4;

/**
 * Rasterizes the airfoil's world-space polygon into a GPU texture used by the
 * fluid solver as an obstacle mask (1 = solid, 0 = fluid, with an
 * anti-aliased gradient in between at the boundary). Rasterization happens
 * on an offscreen 2D canvas (cheap, CPU-side) at several times the solver
 * grid's resolution and is downsampled with smoothing before upload, so the
 * curved leading edge doesn't degrade into a blocky staircase at the grid's
 * native texel size — combined with linear texture filtering, this gives
 * particles and the solver a smooth boundary to interact with instead of
 * discrete axis-aligned steps. Only re-rasterized when the airfoil's
 * geometry actually changes (see `Airfoil.version`), not every frame.
 */
export class ObstacleMask {
  private gl: WebGL2RenderingContext;
  private hiResCanvas: HTMLCanvasElement;
  private hiResCtx: CanvasRenderingContext2D;
  private finalCanvas: HTMLCanvasElement;
  private finalCtx: CanvasRenderingContext2D;
  private texture: WebGLTexture;
  private lastVersion = -1;

  constructor(gl: WebGL2RenderingContext, width: number, height: number) {
    this.gl = gl;

    const hiRes = document.createElement("canvas");
    hiRes.width = width * SUPERSAMPLE;
    hiRes.height = height * SUPERSAMPLE;
    this.hiResCanvas = hiRes;
    const hiResCtx = hiRes.getContext("2d");
    if (!hiResCtx) throw new Error("Failed to acquire 2D context for obstacle mask rasterization");
    this.hiResCtx = hiResCtx;

    const final = document.createElement("canvas");
    final.width = width;
    final.height = height;
    this.finalCanvas = final;
    const finalCtx = final.getContext("2d");
    if (!finalCtx) throw new Error("Failed to acquire 2D context for obstacle mask downsampling");
    finalCtx.imageSmoothingEnabled = true;
    finalCtx.imageSmoothingQuality = "high";
    this.finalCtx = finalCtx;

    const texture = gl.createTexture();
    if (!texture) throw new Error("Failed to create obstacle texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Upload an initial all-clear (no obstacle) mask so the solver has a valid texture
    // to sample before the first `update()` call.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.texture = texture;
  }

  /** Re-rasterizes and re-uploads only if `version` differs from the last update. */
  update(polygon: Vec2[], version: number): void {
    if (version === this.lastVersion) return;
    this.lastVersion = version;

    const hiCtx = this.hiResCtx;
    const hw = this.hiResCanvas.width;
    const hh = this.hiResCanvas.height;
    hiCtx.setTransform(SUPERSAMPLE, 0, 0, SUPERSAMPLE, 0, 0);
    hiCtx.clearRect(0, 0, hw / SUPERSAMPLE, hh / SUPERSAMPLE);
    hiCtx.fillStyle = "black";
    hiCtx.fillRect(0, 0, hw / SUPERSAMPLE, hh / SUPERSAMPLE);
    hiCtx.fillStyle = "white";
    hiCtx.beginPath();
    polygon.forEach((p, i) => {
      if (i === 0) hiCtx.moveTo(p.x, p.y);
      else hiCtx.lineTo(p.x, p.y);
    });
    hiCtx.closePath();
    hiCtx.fill();

    const finalCtx = this.finalCtx;
    const w = this.finalCanvas.width;
    const h = this.finalCanvas.height;
    finalCtx.clearRect(0, 0, w, h);
    finalCtx.drawImage(this.hiResCanvas, 0, 0, hw, hh, 0, 0, w, h);

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, this.finalCanvas);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  getTexture(): WebGLTexture {
    return this.texture;
  }
}
