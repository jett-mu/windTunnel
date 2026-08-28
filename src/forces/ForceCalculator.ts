import { GLContext } from "../gl/GLContext";
import { Shader } from "../gl/Shader";
import { Framebuffer, makeFormats } from "../gl/Framebuffer";
import { FullscreenQuad } from "../gl/FullscreenQuad";
import { Airfoil } from "../airfoil/Airfoil";
import { GRID_W, GRID_H } from "../solver/SolverParams";

import passthroughVert from "../solver/shaders/passthrough.vert?raw";
import sampleSurfaceFrag from "./shaders/sampleSurface.frag?raw";

export interface ForceResult {
  lift: number;
  drag: number;
  cl: number;
  cd: number;
  reynolds: number;
  dynamicPressure: number;
}

const THROTTLE_FRAMES = 3;
/** Offset the sample point outward from the surface by this many grid cells,
 * so we read fluid-side pressure rather than the (mirrored) interior value. */
const SAMPLE_OFFSET_CELLS = 1.5;

/**
 * Computes lift/drag by integrating pressure over the airfoil's surface
 * polyline. Grid textures alone have no notion of "surface", so the airfoil
 * keeps an explicit JS-side polygon with per-segment outward normals
 * (`Airfoil.getSurfaceSamples()`); this class batches all of those samples'
 * pressure lookups into one small GPU pass + one readback per update, rather
 * than one `readPixels` per point (which would stall the GPU pipeline).
 */
export class ForceCalculator {
  private gl: WebGL2RenderingContext;
  private quad: FullscreenQuad;
  private shader: Shader;

  private sampleTarget: Framebuffer;
  private sampleUVTexture: WebGLTexture;
  private numSamples: number;
  private lastAirfoilVersion = -1;
  private frameCounter = 0;
  private readbackBuffer: Float32Array;

  private latest: ForceResult = { lift: 0, drag: 0, cl: 0, cd: 0, reynolds: 0, dynamicPressure: 0 };
  private airfoil: Airfoil;

  constructor(glCtx: GLContext, airfoil: Airfoil) {
    this.airfoil = airfoil;
    const gl = glCtx.gl;
    this.gl = gl;
    this.quad = new FullscreenQuad(gl);
    this.shader = new Shader(gl, passthroughVert, sampleSurfaceFrag);

    this.numSamples = airfoil.getSurfaceSamples().length;
    const fmt = makeFormats(gl);
    this.sampleTarget = new Framebuffer(gl, this.numSamples, 1, fmt.RGBA32F, gl.NEAREST);
    this.sampleUVTexture = this.createSampleUVTexture();
    this.readbackBuffer = new Float32Array(this.numSamples * 4);

    this.uploadSampleUVs();
  }

  private createSampleUVTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("Failed to create sample-UV texture");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, this.numSamples, 1, 0, gl.RG, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  private uploadSampleUVs(): void {
    const gl = this.gl;
    const samples = this.airfoil.getSurfaceSamples();
    const data = new Float32Array(this.numSamples * 2);
    for (let i = 0; i < this.numSamples && i < samples.length; i++) {
      const s = samples[i];
      const sx = s.point.x + s.normal.x * SAMPLE_OFFSET_CELLS;
      const sy = s.point.y + s.normal.y * SAMPLE_OFFSET_CELLS;
      data[i * 2 + 0] = sx / GRID_W;
      data[i * 2 + 1] = sy / GRID_H;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.sampleUVTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.numSamples, 1, gl.RG, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  getLatestForces(): ForceResult {
    return this.latest;
  }

  update(pressureTexture: WebGLTexture, airspeed: number, density: number, viscosity: number): void {
    this.frameCounter++;
    if (this.frameCounter % THROTTLE_FRAMES !== 0) return;

    if (this.airfoil.version !== this.lastAirfoilVersion) {
      this.lastAirfoilVersion = this.airfoil.version;
      this.uploadSampleUVs();
    }

    const gl = this.gl;
    this.sampleTarget.bind();
    this.shader.use();
    this.shader.setTexture(0, "uSampleUV", this.sampleUVTexture);
    this.shader.setTexture(1, "uPressure", pressureTexture);
    this.quad.draw();

    gl.readPixels(0, 0, this.numSamples, 1, gl.RGBA, gl.FLOAT, this.readbackBuffer);

    const samples = this.airfoil.getSurfaceSamples();
    let fx = 0;
    let fy = 0;
    for (let i = 0; i < this.numSamples && i < samples.length; i++) {
      const p = this.readbackBuffer[i * 4];
      const s = samples[i];
      // Surface pressure integration: pressure pushes inward, so the force
      // contribution on the body is -p * n * segment_length.
      fx += -p * s.normal.x * s.length;
      fy += -p * s.normal.y * s.length;
    }

    const drag = fx; // component along freestream (+x)
    // World +y is "up" (toward the airfoil's upper/suction surface — see
    // NACA.ts, which adds +yt*cos(theta) for the upper surface), so lift is
    // the +y component directly, no sign flip needed.
    const lift = fy;
    const chord = this.airfoil.getChordLength();
    const q = 0.5 * density * airspeed * airspeed;
    const cl = q * chord > 1e-6 ? lift / (q * chord) : 0;
    const cd = q * chord > 1e-6 ? drag / (q * chord) : 0;
    const reynolds = viscosity > 1e-6 ? (airspeed * chord) / viscosity : 0;

    this.latest = { lift, drag, cl, cd, reynolds, dynamicPressure: q };
  }
}
