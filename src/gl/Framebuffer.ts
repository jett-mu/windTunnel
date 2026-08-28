export interface TextureFormat {
  internalFormat: number;
  format: number;
  type: number;
}

/**
 * A single render target: a texture + the framebuffer that targets it.
 * Used for every grid field in the solver (velocity, pressure, divergence, vorticity)
 * and for the particle trail-accumulation buffer.
 */
export class Framebuffer {
  readonly gl: WebGL2RenderingContext;
  readonly texture: WebGLTexture;
  readonly fbo: WebGLFramebuffer;
  readonly width: number;
  readonly height: number;

  constructor(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    fmt: TextureFormat,
    filter: number = gl.NEAREST
  ) {
    this.gl = gl;
    this.width = width;
    this.height = height;

    const texture = gl.createTexture();
    if (!texture) throw new Error("Failed to create texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internalFormat, width, height, 0, fmt.format, fmt.type, null);
    this.texture = texture;

    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("Failed to create framebuffer");
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
    }
    this.fbo = fbo;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  bind(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    // Defensively clear texture units: a texture bound as a sampler in a
    // previous pass (possibly this same texture, after a DoubleFBO swap)
    // left bound to a unit would otherwise trip WebGL's feedback-loop check
    // against this framebuffer's attachment, even if the active shader never
    // samples that unit.
    for (let unit = 0; unit < 4; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }
}

/**
 * Ping-pong pair used by every field that reads its previous state while writing
 * a new one in the same pass (velocity, pressure). `.read` is sampled by shaders,
 * `.write` is the render target; call `swap()` after each pass.
 */
export class DoubleFBO {
  read: Framebuffer;
  write: Framebuffer;

  constructor(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    fmt: TextureFormat,
    filter: number = gl.NEAREST
  ) {
    this.read = new Framebuffer(gl, width, height, fmt, filter);
    this.write = new Framebuffer(gl, width, height, fmt, filter);
  }

  swap(): void {
    const tmp = this.read;
    this.read = this.write;
    this.write = tmp;
  }
}

export function makeFormats(gl: WebGL2RenderingContext) {
  return {
    RG32F: { internalFormat: gl.RG32F, format: gl.RG, type: gl.FLOAT } as TextureFormat,
    R32F: { internalFormat: gl.R32F, format: gl.RED, type: gl.FLOAT } as TextureFormat,
    RGBA32F: { internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT } as TextureFormat,
    RGBA16F: { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.FLOAT } as TextureFormat,
    R8: { internalFormat: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE } as TextureFormat,
    RGBA8: { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE } as TextureFormat,
  };
}
