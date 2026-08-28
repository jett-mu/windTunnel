function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
    throw new Error(`Failed to compile ${kind} shader:\n${log}\n---\n${source}`);
  }
  return shader;
}

export interface ShaderOptions {
  /** Varyings to capture via transform feedback (particle update programs). */
  transformFeedbackVaryings?: string[];
}

export class Shader {
  readonly gl: WebGL2RenderingContext;
  readonly program: WebGLProgram;
  private uniformCache = new Map<string, WebGLUniformLocation | null>();

  constructor(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string, options: ShaderOptions = {}) {
    this.gl = gl;
    const vert = compile(gl, gl.VERTEX_SHADER, vertSrc);
    const frag = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    const program = gl.createProgram();
    if (!program) throw new Error("Failed to create program");
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);

    if (options.transformFeedbackVaryings && options.transformFeedbackVaryings.length > 0) {
      gl.transformFeedbackVaryings(program, options.transformFeedbackVaryings, gl.SEPARATE_ATTRIBS);
    }

    gl.linkProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Failed to link program:\n${log}`);
    }
    this.program = program;
  }

  use(): void {
    this.gl.useProgram(this.program);
  }

  private loc(name: string): WebGLUniformLocation | null {
    if (this.uniformCache.has(name)) return this.uniformCache.get(name)!;
    const l = this.gl.getUniformLocation(this.program, name);
    this.uniformCache.set(name, l);
    return l;
  }

  setFloat(name: string, value: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1f(l, value);
  }

  setInt(name: string, value: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, value);
  }

  setVec2(name: string, x: number, y: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform2f(l, x, y);
  }

  setVec3(name: string, x: number, y: number, z: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform3f(l, x, y, z);
  }

  setVec4(name: string, x: number, y: number, z: number, w: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform4f(l, x, y, z, w);
  }

  /** Binds `texture` to `unit` and sets the sampler uniform `name` to that unit. */
  setTexture(unit: number, name: string, texture: WebGLTexture | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const l = this.loc(name);
    if (l) gl.uniform1i(l, unit);
  }

  attribLocation(name: string): number {
    return this.gl.getAttribLocation(this.program, name);
  }
}
