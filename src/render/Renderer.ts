import { GLContext } from "../gl/GLContext";
import { Shader } from "../gl/Shader";
import { FullscreenQuad } from "../gl/FullscreenQuad";
import { Airfoil } from "../airfoil/Airfoil";
import type { ForceResult } from "../forces/ForceCalculator";
import { GRID_W, GRID_H } from "../solver/SolverParams";
import type { Vec2 } from "../gl/math";
import { normalize, perp, scale as vscale, add } from "../gl/math";

import passthroughVert from "../solver/shaders/passthrough.vert?raw";
import pressureFieldFrag from "../render/shaders/pressureField.frag?raw";
import shapeVert from "../render/shaders/shape.vert?raw";
import shapeFrag from "../render/shaders/shape.frag?raw";

const ARROW_MIN_LEN = 5;
const ARROW_MAX_LEN = 70;
// Tuned so a "normal" ~10,000-unit force lands well below max, leaving
// headroom before the arrow clips.
const ARROW_SCALE = 0.003;
const ARROW_WIDTH = 2.5;

function buildArrow(origin: Vec2, dir: Vec2, magnitude: number): number[] {
  const len = Math.min(ARROW_MAX_LEN, Math.max(ARROW_MIN_LEN, Math.abs(magnitude) * ARROW_SCALE));
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

  return [
    s0.x, s0.y, s1.x, s1.y, s2.x, s2.y,
    s1.x, s1.y, s3.x, s3.y, s2.x, s2.y,
    h0.x, h0.y, h1.x, h1.y, tip.x, tip.y,
  ];
}

/**
 * Final compositing stage: pressure heatmap + particle trails (already
 * blended together in `pressureField.frag`) as a fullscreen pass, then the
 * airfoil outline and lift/drag force arrows drawn as flat-colored geometry
 * on top.
 */
export class Renderer {
  private gl: WebGL2RenderingContext;
  private quad: FullscreenQuad;
  private pressureShader: Shader;
  private shapeShader: Shader;

  private outlineVao: WebGLVertexArrayObject;
  private outlineBuffer: WebGLBuffer;
  private outlineCount = 0;
  private lastAirfoilVersion = -1;

  private arrowVao: WebGLVertexArrayObject;
  private arrowBuffer: WebGLBuffer;

  private glCtx: GLContext;
  private airfoil: Airfoil;

  constructor(glCtx: GLContext, airfoil: Airfoil) {
    this.glCtx = glCtx;
    this.airfoil = airfoil;
    const gl = glCtx.gl;
    this.gl = gl;
    this.quad = new FullscreenQuad(gl);
    this.pressureShader = new Shader(gl, passthroughVert, pressureFieldFrag);
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

  render(
    pressureTexture: WebGLTexture,
    obstacleTexture: WebGLTexture,
    trailTexture: WebGLTexture,
    pressureScale: number,
    forces: ForceResult
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.glCtx.canvas.width, this.glCtx.canvas.height);
    gl.disable(gl.BLEND);

    // 1. Pressure heatmap + trails, composited in one fullscreen pass.
    this.pressureShader.use();
    this.pressureShader.setTexture(0, "uPressure", pressureTexture);
    this.pressureShader.setTexture(1, "uObstacle", obstacleTexture);
    this.pressureShader.setTexture(2, "uTrail", trailTexture);
    this.pressureShader.setFloat("uPressureScale", pressureScale);
    this.pressureShader.setFloat("uDynamicPressure", Math.max(forces.dynamicPressure, 1e-4));
    this.quad.draw();

    // 2. Airfoil outline.
    this.updateOutline();
    this.shapeShader.use();
    this.shapeShader.setVec2("uGridSize", GRID_W, GRID_H);
    this.shapeShader.setVec4("uColor", 0.85, 0.9, 0.95, 1.0);
    gl.bindVertexArray(this.outlineVao);
    gl.drawArrays(gl.LINE_LOOP, 0, this.outlineCount);
    gl.bindVertexArray(null);

    // 3. Force vector arrows, anchored at the quarter-chord point.
    const anchor: Vec2 = {
      x: this.airfoil.params.posXFrac * GRID_W,
      y: this.airfoil.params.posYFrac * GRID_H,
    };

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.arrowVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowBuffer);

    // Lift: perpendicular to freestream. World +y renders toward screen "up"
    // (the shape.vert clip transform and our unflipped obstacle-mask texture
    // upload agree on that), matching the +y = lift-positive convention in
    // ForceCalculator.
    const liftDir = normalize({ x: 0, y: 1 });
    const liftVerts = buildArrow(anchor, liftDir, forces.lift);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(liftVerts), gl.DYNAMIC_DRAW);
    this.shapeShader.setVec4("uColor", 0.25, 0.9, 0.35, 0.95);
    gl.drawArrays(gl.TRIANGLES, 0, liftVerts.length / 2);

    // Drag: along the freestream direction.
    const dragDir = normalize({ x: 1, y: 0 });
    const dragVerts = buildArrow(anchor, dragDir, forces.drag);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(dragVerts), gl.DYNAMIC_DRAW);
    this.shapeShader.setVec4("uColor", 0.95, 0.3, 0.25, 0.95);
    gl.drawArrays(gl.TRIANGLES, 0, dragVerts.length / 2);

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}
