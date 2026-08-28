import { Airfoil, AOA_MIN_DEG, AOA_MAX_DEG } from "../airfoil/Airfoil";
import type { Vec2 } from "../gl/math";
import { distanceToPolygon, pointInPolygon, clamp } from "../gl/math";
import { GRID_W, GRID_H } from "../solver/SolverParams";

/** World-space distance (grid texels) beyond the wing's own outline that still counts as a grab. */
const GRAB_MARGIN = 10;

/**
 * Lets the user drag the wing directly in the canvas to change angle of
 * attack, as an alternative to the AoA slider. World-space y increases
 * toward the screen's visual top (see Renderer/ObstacleMask for the
 * coordinate convention), while DOM client coordinates increase downward;
 * the conversions below account for that flip.
 */
export class AirfoilDragController {
  private isDragging = false;
  private dragStartAoA = 0;
  private dragStartAngle = 0;
  private canvas: HTMLCanvasElement;
  private airfoil: Airfoil;

  constructor(canvas: HTMLCanvasElement, airfoil: Airfoil) {
    this.canvas = canvas;
    this.airfoil = airfoil;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
  }

  private clientToWorld(clientX: number, clientY: number): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    const u = (clientX - rect.left) / rect.width;
    const v = (clientY - rect.top) / rect.height;
    return { x: u * GRID_W, y: (1 - v) * GRID_H };
  }

  private worldToClient(w: Vec2): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const u = w.x / GRID_W;
    const v = 1 - w.y / GRID_H;
    return { x: rect.left + u * rect.width, y: rect.top + v * rect.height };
  }

  private anchorWorld(): Vec2 {
    return {
      x: this.airfoil.params.posXFrac * GRID_W,
      y: this.airfoil.params.posYFrac * GRID_H,
    };
  }

  private hitTest(worldPt: Vec2): boolean {
    const poly = this.airfoil.getWorldPolygon();
    return pointInPolygon(worldPt, poly) || distanceToPolygon(worldPt, poly) <= GRAB_MARGIN;
  }

  private onPointerDown = (e: PointerEvent): void => {
    const worldPt = this.clientToWorld(e.clientX, e.clientY);
    if (!this.hitTest(worldPt)) return;

    this.isDragging = true;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "grabbing";
    this.dragStartAoA = this.airfoil.params.aoaDeg;
    const anchorClient = this.worldToClient(this.anchorWorld());
    this.dragStartAngle = Math.atan2(e.clientY - anchorClient.y, e.clientX - anchorClient.x);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.isDragging) {
      const worldPt = this.clientToWorld(e.clientX, e.clientY);
      this.canvas.style.cursor = this.hitTest(worldPt) ? "grab" : "default";
      return;
    }

    const anchorClient = this.worldToClient(this.anchorWorld());
    const angleNow = Math.atan2(e.clientY - anchorClient.y, e.clientX - anchorClient.x);
    // Rotating the grabbed point by this screen-space delta angle rotates
    // the whole rigid wing by the same amount, regardless of which point on
    // the wing was grabbed.
    const deltaDeg = ((angleNow - this.dragStartAngle) * 180) / Math.PI;
    const newAoA = clamp(this.dragStartAoA - deltaDeg, AOA_MIN_DEG, AOA_MAX_DEG);
    this.airfoil.setParams({ aoaDeg: newAoA });
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.canvas.style.cursor = "default";
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
  };
}
