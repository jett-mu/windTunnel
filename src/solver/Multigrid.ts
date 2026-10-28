import { Shader } from "../gl/Shader";
import { DoubleFBO, Framebuffer, makeFormats } from "../gl/Framebuffer";
import { FullscreenQuad } from "../gl/FullscreenQuad";

import passthroughVert from "./shaders/passthrough.vert?raw";
import jacobiFrag from "./shaders/jacobi.frag?raw";
import residualFrag from "./shaders/residual.frag?raw";
import restrictFrag from "./shaders/restrict.frag?raw";
import restrictResidualFrag from "./shaders/restrictResidual.frag?raw";
import coarseSolveFrag from "./shaders/coarseSolve.frag?raw";
import obstacleNeighborsFrag from "./shaders/obstacleNeighbors.frag?raw";

/** Smallest level's height in cells; 256 -> 4 gives a 7-level hierarchy whose
 * 8x4 coarsest grid is solved directly in one pass (see coarseSolve.frag). */
const COARSEST_H = 4;
/** Smoothing passes, each a red-black Gauss-Seidel half-sweep (one full
 * sweep = 2 passes). Gauss-Seidel damps the high-frequency error smoothing
 * is for much faster than (damped) Jacobi, at identical cost per pass. */
const PRE_SMOOTH = 2;
const POST_SMOOTH = 2;

interface Level {
  w: number;
  h: number;
  texel: [number, number];
  /** Squared grid spacing, in finest-grid cells. */
  h2: number;
  x: DoubleFBO;
  rhs: Framebuffer;
  /** Coarse levels own a downsampled obstacle; level 0 uses the caller's mask texture. */
  obstacleFbo: Framebuffer | null;
  obstacle: WebGLTexture | null;
  neighbors: Framebuffer;
}

/**
 * Geometric multigrid V-cycle for the pressure Poisson equation. Jacobi
 * alone only kills error a few cells wide per iteration, so pressure
 * information crosses the 512-cell domain painfully slowly; recursing onto
 * coarser grids lets each level smooth the error at its own scale. One
 * warm-started V-cycle per step does far more than 80 fine Jacobi
 * iterations, at roughly a tenth of the fill cost.
 */
export class Multigrid {
  private quad: FullscreenQuad;
  private levels: Level[] = [];

  private jacobiShader: Shader;
  private residualShader: Shader;
  private restrictShader: Shader;
  private restrictResidualShader: Shader;
  private coarseSolveShader: Shader;
  /** Debug-only scratch target for `measureResidual`. */
  private debugResidual: Framebuffer;
  private neighborsShader: Shader;

  constructor(
    gl: WebGL2RenderingContext,
    quad: FullscreenQuad,
    filter: number,
    fine: { pressure: DoubleFBO; rhs: Framebuffer; w: number; h: number }
  ) {
    this.quad = quad;
    const fmt = makeFormats(gl);

    let w = fine.w;
    let h = fine.h;
    let spacing = 1;
    while (true) {
      const isFine = this.levels.length === 0;
      const obstacleFbo = isFine ? null : new Framebuffer(gl, w, h, fmt.R8, gl.LINEAR);
      this.levels.push({
        w,
        h,
        texel: [1 / w, 1 / h],
        h2: spacing * spacing,
        x: isFine ? fine.pressure : new DoubleFBO(gl, w, h, fmt.R32F, filter),
        rhs: isFine ? fine.rhs : new Framebuffer(gl, w, h, fmt.R32F, filter),
        obstacleFbo,
        obstacle: obstacleFbo ? obstacleFbo.texture : null,
        neighbors: new Framebuffer(gl, w, h, fmt.RGBA8, gl.NEAREST),
      });
      if (h / 2 < COARSEST_H || w % 2 !== 0 || h % 2 !== 0) break;
      w /= 2;
      h /= 2;
      spacing *= 2;
    }

    this.jacobiShader = new Shader(gl, passthroughVert, jacobiFrag);
    this.residualShader = new Shader(gl, passthroughVert, residualFrag);
    this.restrictShader = new Shader(gl, passthroughVert, restrictFrag);
    this.restrictResidualShader = new Shader(gl, passthroughVert, restrictResidualFrag);
    const coarsest = this.levels[this.levels.length - 1];
    this.coarseSolveShader = new Shader(gl, passthroughVert, coarseSolveFrag, {
      defines: [`COARSE_W ${coarsest.w}`, `COARSE_H ${coarsest.h}`],
    });
    this.debugResidual = new Framebuffer(gl, fine.w, fine.h, fmt.R32F, gl.NEAREST);
    this.neighborsShader = new Shader(gl, passthroughVert, obstacleNeighborsFrag);
  }

  /** Packed (L, R, B, T) solid fractions at the finest level, shared with the other solver passes. */
  get fineNeighbors(): WebGLTexture {
    return this.levels[0].neighbors.texture;
  }

  /** Rebuilds every level's obstacle mask and neighbor packing. Call when geometry changes. */
  setObstacle(fineObstacle: WebGLTexture): void {
    this.levels[0].obstacle = fineObstacle;
    for (let i = 0; i < this.levels.length; i++) {
      const level = this.levels[i];
      if (i > 0) {
        level.obstacleFbo!.bind();
        this.restrictShader.use();
        this.restrictShader.setTexture(0, "uFine", this.levels[i - 1].obstacle);
        this.quad.draw();
      }
      level.neighbors.bind();
      this.neighborsShader.use();
      this.neighborsShader.setTexture(0, "uObstacle", level.obstacle);
      this.quad.draw();
    }
  }

  /**
   * Debug-only: relative residual ||rhs - L p|| / ||rhs|| of the finest
   * level, i.e. how well the last solve converged. Synchronous readback.
   */
  measureResidual(gl: WebGL2RenderingContext): number {
    const level = this.levels[0];
    this.debugResidual.bind();
    const rs = this.residualShader;
    rs.use();
    rs.setTexture(0, "uPressure", level.x.read.texture);
    rs.setTexture(1, "uRhs", level.rhs.texture);
    rs.setTexture(2, "uNeighbors", level.neighbors.texture);
    rs.setTexture(3, "uObstacle", level.obstacle);
    rs.setVec2("uTexel", level.texel[0], level.texel[1]);
    rs.setFloat("uH2", level.h2);
    this.quad.draw();
    const n = level.w * level.h;
    const r = new Float32Array(n * 4);
    gl.readPixels(0, 0, level.w, level.h, gl.RGBA, gl.FLOAT, r);
    level.rhs.bind(true); // read-only: keep contents
    const b = new Float32Array(n * 4);
    gl.readPixels(0, 0, level.w, level.h, gl.RGBA, gl.FLOAT, b);
    let rr = 0;
    let bb = 0;
    for (let i = 0; i < n; i++) {
      rr += r[i * 4] * r[i * 4];
      bb += b[i * 4] * b[i * 4];
    }
    return Math.sqrt(rr / Math.max(bb, 1e-30));
  }

  /** Warm-started V-cycles on the finest level's pressure. */
  solve(cycles: number): void {
    for (let c = 0; c < cycles; c++) this.vcycle(0);
  }

  /** Plain fine-grid Jacobi, kept for A/B comparison against the V-cycle. */
  jacobi(iterations: number): void {
    this.smooth(this.levels[0], iterations, false);
  }

  /**
   * One V-cycle from `index` down. Coarse levels solve for the error with a
   * zero initial guess; the fine level is warm-started from the previous
   * step. Clearing, residual/restriction and prolongation/correction are all
   * fused into neighboring passes, since on the small levels the fixed cost
   * of a pass dwarfs its arithmetic.
   */
  private vcycle(index: number): void {
    const level = this.levels[index];
    const zeroGuess = index > 0;

    if (index === this.levels.length - 1) {
      level.x.write.bind();
      const cs = this.coarseSolveShader;
      cs.use();
      cs.setTexture(0, "uRhs", level.rhs.texture);
      cs.setTexture(1, "uNeighbors", level.neighbors.texture);
      cs.setFloat("uH2", level.h2);
      this.quad.draw();
      level.x.swap();
      return;
    }

    this.smooth(level, PRE_SMOOTH, true, { zeroGuess });

    const coarse = this.levels[index + 1];
    coarse.rhs.bind();
    const rr = this.restrictResidualShader;
    rr.use();
    rr.setTexture(0, "uPressure", level.x.read.texture);
    rr.setTexture(1, "uRhs", level.rhs.texture);
    rr.setTexture(2, "uNeighbors", level.neighbors.texture);
    rr.setTexture(3, "uObstacle", level.obstacle);
    rr.setFloat("uH2", level.h2);
    this.quad.draw();

    this.vcycle(index + 1);

    this.smooth(level, POST_SMOOTH, true, { coarse: coarse.x.read.texture });
  }

  /**
   * `passes` Jacobi iterations, or red-black Gauss-Seidel half-sweeps of
   * alternating color. The first pass can start from a zero guess or apply
   * a coarse-grid correction on the fly.
   */
  private smooth(
    level: Level,
    passes: number,
    redBlack: boolean,
    first: { zeroGuess?: boolean; coarse?: WebGLTexture } = {}
  ): void {
    const js = this.jacobiShader;
    for (let i = 0; i < passes; i++) {
      const coarse = i === 0 ? first.coarse ?? null : null;
      level.x.write.bind();
      js.use();
      js.setTexture(0, "uPressure", level.x.read.texture);
      js.setTexture(1, "uRhs", level.rhs.texture);
      js.setTexture(2, "uNeighbors", level.neighbors.texture);
      js.setTexture(3, "uCoarse", coarse);
      js.setVec2("uTexel", level.texel[0], level.texel[1]);
      js.setFloat("uH2", level.h2);
      js.setInt("uParity", redBlack ? i & 1 : -1);
      js.setInt("uZeroGuess", i === 0 && first.zeroGuess ? 1 : 0);
      js.setInt("uCorrect", coarse ? 1 : 0);
      this.quad.draw();
      level.x.swap();
    }
  }
}
