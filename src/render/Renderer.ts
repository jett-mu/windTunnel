import { GLContext } from "../gl/GLContext";
import { Shader } from "../gl/Shader";
import { FullscreenQuad } from "../gl/FullscreenQuad";
import { Airfoil } from "../airfoil/Airfoil";
import type { ForceResult } from "../forces/ForceCalculator";
import { GRID_W, GRID_H } from "../solver/SolverParams";
import { viewShowsParticles } from "../solver/SolverParams";
import type { ViewMode } from "../solver/SolverParams";
import type { Vec2 } from "../gl/math";
import { perp, scale as vscale, add } from "../gl/math";

import passthroughVert from "../solver/shaders/passthrough.vert?raw";
import pressureFieldFrag from "../render/shaders/pressureField.frag?raw";
import shapeVert from "../render/shaders/shape.vert?raw";
import shapeFrag from "../render/shaders/shape.frag?raw";

const ARROW_MIN_LEN = 5;
const ARROW_MAX_LEN = 90;
/** Grid texels of arrow per unit of force coefficient, so arrow length is
 * comparable across airspeeds, densities and body sizes. */
const ARROW_PER_COEFF = 40;
const ARROW_WIDTH = 2.5;

const VIEW_MODE_INDEX: Record<ViewMode, number> = {
  pressure: 0,
  speed: 1,
  vorticity: 2,
  none: 3,
  schlieren: 4,
  smoke: 5,
};

/** Writes a 3-triangle arrow into `out` (18 floats). */
function buildArrow(out: Float32Array, origin: Vec2, dir: Vec2, magnitude: number): void {
  const len = Math.min(ARROW_MAX_LEN, Math.max(ARROW_MIN_LEN, Math.abs(magnitude) * ARROW_PER_COEFF));
  const facing = magnitude >= 0 ? dir : vscale(dir, -1);
  const n = perp(facing);
  const tip = add(origin, vscale(facing, len));
  const headBase = add(origin, vscale(facing, len * 0.72));
  const halfShaft = ARROW_WIDTH * 0.35;
  const halfHead = ARROW_WIDTH;

  const s0 = add(origin, vscale(n, halfShaft));
  const s1 = add(origin, vscale(n, -halfShaft));
  const s2 = add(headBase, vscale(n, halfShaft));
  const s3 = add(headBase, vscale(n, -halfShaft));
  const h0 = add(headBase, vscale(n, halfHead));
  const h1 = add(headBase, vscale(n, -halfHead));

  out.set([
    s0.x, s0.y, s1.x, s1.y, s2.x, s2.y,
    s1.x, s1.y, s3.x, s3.y, s2.x, s2.y,
    h0.x, h0.y, h1.x, h1.y, tip.x, tip.y,
  ]);
}

export interface FieldTextures {
  pressure: WebGLTexture;
  obstacle: WebGLTexture;
  trail: WebGLTexture;
  velocity: WebGLTexture;
  vorticity: WebGLTexture;
  smoke: WebGLTexture;
}

export interface RenderOptions {
  viewMode: ViewMode;
  scale: number;
  dt: number;
  airspeed: number;
}

/**
 * Final compositing stage: the selected background field (Cp, speed,
 * vorticity, schlieren or smoke) + particle trails, blended together in `pressureField.frag` as
 * a fullscreen pass, then the body outline and lift/drag force arrows drawn
 * as flat-colored geometry on top.
 */
export class Renderer {
  private gl: WebGL2RenderingContext;
  private quad: FullscreenQuad;
  private fieldShader: Shader;
  private shapeShader: Shader;

  private outlineVao: WebGLVertexArrayObject;
  private outlineBuffer: WebGLBuffer;
  private outlineCount = 0;
  private lastAirfoilVersion = -1;

  private arrowVao: WebGLVertexArrayObject;
  private arrowBuffer: WebGLBuffer;
  private arrowVerts = new Float32Array(18);

  private glCtx: GLContext;
  private airfoil: Airfoil;

  constructor(glCtx: GLContext, airfoil: Airfoil) {
    this.glCtx = glCtx;
    this.airfoil = airfoil;
    const gl = glCtx.gl;
    this.gl = gl;
    this.quad = new FullscreenQuad(gl);
    this.fieldShader = new Shader(gl, passthroughVert, pressureFieldFrag);
    this.shapeShader = new Shader(gl, shapeVert, shapeFrag);

    const outlineBuffer = gl.createBuffer();
    if (!outlineBuffer) throw new Error("Failed to create outline buffer");
    this.outlineBuffer = outlineBuffer;
    const outlineVao = gl.createVertexArray();
    if (!outlineVao) throw new Error("Failed to create outline VAO");
    this.outlineVao = outlineVao;
    gl.bindVertexArray(outlineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, outlineBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const arrowBuffer = gl.createBuffer();
    if (!arrowBuffer) throw new Error("Failed to create arrow buffer");
    this.arrowBuffer = arrowBuffer;
    const arrowVao = gl.createVertexArray();
    if (!arrowVao) throw new Error("Failed to create arrow VAO");
    this.arrowVao = arrowVao;
    gl.bindVertexArray(arrowVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, arrowBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.arrowVerts.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.updateOutline();
  }

  private updateOutline(): void {
    if (this.airfoil.version === this.lastAirfoilVersion) return;
    this.lastAirfoilVersion = this.airfoil.version;
    const gl = this.gl;
    const poly = this.airfoil.getWorldPolygon();
    const data = new Float32Array(poly.length * 2);
    poly.forEach((p, i) => {
      data[i * 2] = p.x;
      data[i * 2 + 1] = p.y;
    });
    this.outlineCount = poly.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.outlineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  private drawArrow(anchor: Vec2, dir: Vec2, magnitude: number, color: [number, number, number, number]): void {
    const gl = this.gl;
    buildArrow(this.arrowVerts, anchor, dir, magnitude);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.arrowVerts);
    this.shapeShader.setVec4("uColor", color[0], color[1], color[2], color[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 9);
  }

  render(tex: FieldTextures, opts: RenderOptions, forces: ForceResult): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.glCtx.canvas.width, this.glCtx.canvas.height);
    gl.disable(gl.BLEND);

    // 1. Background field + trails, composited in one fullscreen pass.
    const fs = this.fieldShader;
    fs.use();
    fs.setTexture(0, "uPressure", tex.pressure);
    fs.setTexture(1, "uObstacle", tex.obstacle);
    fs.setTexture(2, "uTrail", tex.trail);
    fs.setTexture(3, "uVelocity", tex.velocity);
    fs.setTexture(4, "uVorticity", tex.vorticity);
    fs.setTexture(5, "uSmoke", tex.smoke);
    fs.setInt("uViewMode", VIEW_MODE_INDEX[opts.viewMode]);
    fs.setInt("uShowTrails", viewShowsParticles(opts.viewMode) ? 1 : 0);
    fs.setFloat("uScale", opts.scale);
    fs.setFloat("uDt", opts.dt);
    fs.setFloat("uFreestream", opts.airspeed);
    fs.setFloat("uRefLength", this.airfoil.getReferenceLength());
    this.quad.draw();

    // 2. Body outline.
    this.updateOutline();
    this.shapeShader.use();
    this.shapeShader.setVec2("uGridSize", GRID_W, GRID_H);
    this.shapeShader.setVec4("uColor", 0.85, 0.9, 0.95, 1.0);
    gl.bindVertexArray(this.outlineVao);
    gl.drawArrays(gl.LINE_LOOP, 0, this.outlineCount);
    gl.bindVertexArray(null);

    // 3. Force vector arrows, anchored at the pitch axis. World +y renders
    // toward screen "up" (the shape.vert clip transform and the obstacle
    // mask agree on that), matching ForceCalculator's +y = lift convention.
    const anchor = this.airfoil.getPivotWorld();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.arrowVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowBuffer);
    this.drawArrow(anchor, { x: 0, y: 1 }, forces.cl, [0.25, 0.9, 0.35, 0.95]);
    this.drawArrow(anchor, { x: 1, y: 0 }, forces.cd, [0.95, 0.3, 0.25, 0.95]);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}
