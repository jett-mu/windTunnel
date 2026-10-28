import { GLContext } from "../gl/GLContext";
import { Shader } from "../gl/Shader";
import { Framebuffer, makeFormats } from "../gl/Framebuffer";
import { FullscreenQuad } from "../gl/FullscreenQuad";
import { Airfoil } from "../airfoil/Airfoil";
import type { SurfaceSample } from "../airfoil/Airfoil";
import { pivotFrac } from "../airfoil/Shapes";
import type { Vec2 } from "../gl/math";
import { GRID_W, GRID_H } from "../solver/SolverParams";

import passthroughVert from "../solver/shaders/passthrough.vert?raw";
import sampleSurfaceFrag from "./shaders/sampleSurface.frag?raw";

export interface ForceResult {
  /** Dimensional forces (density-scaled). */
  lift: number;
  drag: number;
  cl: number;
  cd: number;
  /** Skin-friction share of `cd` (the rest is pressure/form drag). */
  cdFriction: number;
  /** Pitching moment coefficient about the pitch axis, nose-up positive. */
  cm: number;
  /** Lift-to-drag ratio; NaN when drag is ~0. */
  ld: number;
  /** Center of pressure as a fraction of chord from the leading edge, or null when undefined. */
  xcp: number | null;
  reynolds: number;
  dynamicPressure: number;
}

export const ZERO_FORCES: ForceResult = {
  lift: 0,
  drag: 0,
  cl: 0,
  cd: 0,
  cdFriction: 0,
  cm: 0,
  ld: NaN,
  xcp: null,
  reynolds: 0,
  dynamicPressure: 0,
};

export interface FlowConditions {
  airspeed: number;
  density: number;
  viscosity: number;
  dt: number;
}

/** Offset the sample point outward from the surface by this many grid cells,
 * so we read fluid-side pressure rather than the (mirrored) interior value. */
const SAMPLE_OFFSET_CELLS = 1.5;
/** Readbacks in flight; a slot frees once the GPU signals its fence. */
const PBO_COUNT = 3;

/** Everything needed to turn a readback into forces, captured when it was issued. */
interface Snapshot {
  samples: SurfaceSample[];
  pivot: Vec2;
  refLength: number;
  chord: number;
  pivotFrac: number;
  hasChord: boolean;
  aoaRad: number;
  flow: FlowConditions;
}

interface Pending {
  pbo: WebGLBuffer;
  sync: WebGLSync;
  snapshot: Snapshot;
}

/**
 * Computes lift/drag/moment by integrating pressure over the body's surface
 * polyline. Grid textures alone have no notion of "surface", so the airfoil
 * keeps an explicit JS-side polygon with per-segment outward normals
 * (`Airfoil.getSurfaceSamples()`); this class batches all of those samples'
 * pressure lookups into one small GPU pass. The readback goes through a
 * pixel-pack buffer guarded by a fence and is only mapped once the GPU has
 * finished, a frame or two later, so it never stalls the pipeline the way a
 * synchronous `readPixels` would.
 */
export class ForceCalculator {
  private gl: WebGL2RenderingContext;
  private quad: FullscreenQuad;
  private shader: Shader;
  private airfoil: Airfoil;

  private capacity = 0;
  private sampleTarget!: Framebuffer;
  private sampleUVTexture: WebGLTexture | null = null;
  private freePbos: WebGLBuffer[] = [];
  private pending: Pending[] = [];
  private readbackBuffer = new Float32Array(0);
  private lastAirfoilVersion = -1;

  private latest: ForceResult = ZERO_FORCES;

  constructor(glCtx: GLContext, airfoil: Airfoil) {
    this.airfoil = airfoil;
    this.gl = glCtx.gl;
    this.quad = new FullscreenQuad(this.gl);
    this.shader = new Shader(this.gl, passthroughVert, sampleSurfaceFrag);
  }

  /** (Re)allocates the sample target, UV texture and readback buffers for `n` samples. */
  private allocate(n: number): void {
    const gl = this.gl;
    this.flushPending();
    if (this.capacity > 0) {
      this.sampleTarget.dispose();
      gl.deleteTexture(this.sampleUVTexture);
      this.freePbos.forEach((b) => gl.deleteBuffer(b));
    }
    this.capacity = n;
    this.sampleTarget = new Framebuffer(gl, n, 1, makeFormats(gl).RGBA32F, gl.NEAREST);

    const tex = gl.createTexture();
    if (!tex) throw new Error("Failed to create sample-UV texture");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, n, 1, 0, gl.RG, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.sampleUVTexture = tex;

    this.freePbos = [];
    for (let i = 0; i < PBO_COUNT; i++) {
      const pbo = gl.createBuffer();
      if (!pbo) throw new Error("Failed to create readback buffer");
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      // Usage is only a hint. Not *_READ: Chrome shadow-copies READ-usage
      // buffers at every fenceSync for a mapping path WebGL never uses, then
      // logs a performance warning each time the buffer is rewritten.
      gl.bufferData(gl.PIXEL_PACK_BUFFER, n * 16, gl.DYNAMIC_COPY);
      this.freePbos.push(pbo);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.readbackBuffer = new Float32Array(n * 4);
  }

  /** Abandons in-flight readbacks (geometry storage is about to be replaced). */
  private flushPending(): void {
    for (const p of this.pending) {
      this.gl.deleteSync(p.sync);
      this.freePbos.push(p.pbo);
    }
    this.pending = [];
  }

  private uploadSampleUVs(samples: SurfaceSample[]): void {
    const gl = this.gl;
    const data = new Float32Array(this.capacity * 2);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      data[i * 2 + 0] = (s.point.x + s.normal.x * SAMPLE_OFFSET_CELLS) / GRID_W;
      data[i * 2 + 1] = (s.point.y + s.normal.y * SAMPLE_OFFSET_CELLS) / GRID_H;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.sampleUVTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.capacity, 1, gl.RG, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  getLatestForces(): ForceResult {
    return this.latest;
  }

  /** Clears the last result (e.g. after a flow reset) and abandons in-flight readbacks. */
  reset(): void {
    this.flushPending();
    this.latest = ZERO_FORCES;
  }

  /**
   * Collects any finished readback, then (if `issue`, i.e. the flow
   * actually advanced) starts a new one. Returns true when
   * `getLatestForces()` holds a result it didn't before this call.
   */
  update(pressureTexture: WebGLTexture, velocityTexture: WebGLTexture, flow: FlowConditions, issue: boolean): boolean {
    const gl = this.gl;
    let fresh = false;
    while (this.pending.length > 0) {
      const head = this.pending[0];
      if (gl.clientWaitSync(head.sync, 0, 0) === gl.TIMEOUT_EXPIRED) break;
      this.pending.shift();
      gl.deleteSync(head.sync);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, head.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.readbackBuffer);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.freePbos.push(head.pbo);
      this.latest = this.integrate(this.readbackBuffer, head.snapshot);
      fresh = true;
    }

    if (!issue) return fresh;
    const samples = this.airfoil.getSurfaceSamples();
    if (samples.length > this.capacity) {
      this.allocate(Math.ceil(samples.length * 1.25));
      this.lastAirfoilVersion = -1;
    }
    if (this.freePbos.length === 0) return fresh;

    if (this.airfoil.version !== this.lastAirfoilVersion) {
      this.lastAirfoilVersion = this.airfoil.version;
      this.uploadSampleUVs(samples);
    }

    this.sampleTarget.bind();
    this.shader.use();
    this.shader.setTexture(0, "uSampleUV", this.sampleUVTexture);
    this.shader.setTexture(1, "uPressure", pressureTexture);
    this.shader.setTexture(2, "uVelocity", velocityTexture);
    this.quad.draw();

    const pbo = this.freePbos.pop()!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.readPixels(0, 0, this.capacity, 1, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) {
      this.freePbos.push(pbo);
      return fresh;
    }
    const shape = this.airfoil.params.shape;
    this.pending.push({
      pbo,
      sync,
      snapshot: {
        samples,
        pivot: this.airfoil.getPivotWorld(),
        refLength: this.airfoil.getReferenceLength(),
        chord: this.airfoil.getChordLength(),
        pivotFrac: pivotFrac(shape),
        hasChord: shape === "naca" || shape === "plate",
        aoaRad: (this.airfoil.params.aoaDeg * Math.PI) / 180,
        flow: { ...flow },
      },
    });
    return fresh;
  }

  private integrate(samples: Float32Array, snap: Snapshot): ForceResult {
    const { airspeed, density, viscosity, dt } = snap.flow;
    // The solver's pressure is the projection potential (u -= grad p per
    // step), i.e. physical pressure * dt / density. Integrate everything in
    // those solver units, then convert once.
    //
    // Skin friction: wall shear tau = rho * nu * du_t/dn, with the
    // tangential velocity at the sample point (SAMPLE_OFFSET_CELLS out from
    // the no-slip wall) over that distance as the gradient. In solver units
    // that's dt * nu * u_t / d per unit length.
    const shearScale = (dt * viscosity) / SAMPLE_OFFSET_CELLS;
    let fx = 0;
    let fy = 0;
    let frictionX = 0;
    let mz = 0;
    for (let i = 0; i < snap.samples.length; i++) {
      const p = samples[i * 4];
      const vx = samples[i * 4 + 1];
      const vy = samples[i * 4 + 2];
      const s = snap.samples[i];
      const n = s.normal;
      // Pressure pushes inward: -p * n * segment_length.
      let sx = -p * n.x * s.length;
      let sy = -p * n.y * s.length;
      // Shear drags the surface along with the tangential flow.
      const vn = vx * n.x + vy * n.y;
      const tx = shearScale * (vx - vn * n.x) * s.length;
      const ty = shearScale * (vy - vn * n.y) * s.length;
      frictionX += tx;
      sx += tx;
      sy += ty;
      fx += sx;
      fy += sy;
      // Counter-clockwise (z) moment about the pitch axis.
      mz += (s.point.x - snap.pivot.x) * sy - (s.point.y - snap.pivot.y) * sx;
    }

    const toPhysical = density / dt;
    // Drag is the component along the freestream (+x); world +y is "up",
    // toward the airfoil's upper/suction surface, so lift is +y directly.
    const drag = fx * toPhysical;
    const lift = fy * toPhysical;
    const L = snap.refLength;
    const q = 0.5 * density * airspeed * airspeed;
    // Coefficients in solver units directly, so density cancels exactly.
    const qSolver = 0.5 * airspeed * airspeed * dt;
    const valid = qSolver * L > 1e-9;
    const cl = valid ? fy / (qSolver * L) : 0;
    const cd = valid ? fx / (qSolver * L) : 0;
    const cdFriction = valid ? frictionX / (qSolver * L) : 0;
    // Nose-up is clockwise in this y-up frame, hence the sign flip.
    const cm = valid ? -mz / (qSolver * L * L) : 0;
    const ld = Math.abs(cd) > 1e-4 ? cl / cd : NaN;

    // Center of pressure along the chord from the normal-force coefficient.
    let xcp: number | null = null;
    if (snap.hasChord) {
      const cn = cl * Math.cos(snap.aoaRad) + cd * Math.sin(snap.aoaRad);
      if (Math.abs(cn) > 0.05) xcp = snap.pivotFrac - (cm * L) / (cn * snap.chord);
    }

    const reynolds = viscosity > 1e-6 ? (airspeed * L) / viscosity : 0;
    return { lift, drag, cl, cd, cdFriction, cm, ld, xcp, reynolds, dynamicPressure: q };
  }
}
