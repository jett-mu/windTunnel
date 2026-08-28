export interface GLCapabilities {
  colorBufferFloat: boolean;
  linearFloatFilter: boolean;
}

export class GLContext {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  readonly caps: GLCapabilities;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) {
      throw new Error("WebGL2 is not supported in this browser.");
    }
    this.gl = gl;
    this.canvas = canvas;

    // Float framebuffer attachments (required to render into RGBA32F/RG32F/R32F textures).
    const colorBufferFloat = !!gl.getExtension("EXT_color_buffer_float");
    if (!colorBufferFloat) {
      throw new Error(
        "EXT_color_buffer_float is required for the GPU fluid solver and is not supported on this device."
      );
    }
    // Linear filtering of float textures (nice-to-have; falls back to NEAREST sampling if absent).
    const linearFloatFilter = !!gl.getExtension("OES_texture_float_linear");

    this.caps = { colorBufferFloat, linearFloatFilter };

    // eslint-disable-next-line no-console
    console.log("[GLContext] WebGL2 ready. Capabilities:", this.caps);
  }

  resize(width: number, height: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }
}
