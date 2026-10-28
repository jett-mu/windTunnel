import { Airfoil, AOA_MIN_DEG, AOA_MAX_DEG } from "../airfoil/Airfoil";
import type { Vec2 } from "../gl/math";
import { distanceToPolygon, pointInPolygon, clamp, length, sub } from "../gl/math";
import { GRID_W, GRID_H } from "../solver/SolverParams";

/** World-space distance (grid texels) beyond the wing's own outline that still counts as a grab. */
const GRAB_MARGIN = 10;
/** Grabbing within this many grid texels of the pitch axis moves rather than rotates. */
const MOVE_RADIUS = 12;
const WHEEL_STEP_DEG = 0.5;

type DragMode = "rotate" | "move";

/**
 * Lets the user manipulate the body directly in the canvas: drag to change
 * angle of attack; Shift-drag (or grab it at its pitch axis) to move it; and
 * scroll over it for fine AoA steps. World-space y increases toward the
 * screen's visual top (see Renderer/ObstacleMask for the coordinate
 * convention), while DOM client coordinates increase downward; the
 * conversions below account for that flip.
 */
export class AirfoilDragController {
  private mode: DragMode | null = null;
  private dragStartAoA = 0;
  private dragStartAngle = 0;
  private dragStartWorld: Vec2 = { x: 0, y: 0 };
  private dragStartPos: Vec2 = { x: 0, y: 0 };
  private canvas: HTMLCanvasElement;
  private airfoil: Airfoil;
  private isLocked: () => boolean;

  /** `isLocked` disables manipulation, e.g. while a polar sweep owns the AoA. */
  constructor(canvas: HTMLCanvasElement, airfoil: Airfoil, isLocked: () => boolean) {
    this.canvas = canvas;
    this.airfoil = airfoil;
    this.isLocked = isLocked;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
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

  private hitTest(worldPt: Vec2): boolean {
    const poly = this.airfoil.getWorldPolygon();
    return pointInPolygon(worldPt, poly) || distanceToPolygon(worldPt, poly) <= GRAB_MARGIN;
  }

  private modeFor(worldPt: Vec2, shiftKey: boolean): DragMode {
    return shiftKey || length(sub(worldPt, this.airfoil.getPivotWorld())) <= MOVE_RADIUS ? "move" : "rotate";
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.isLocked()) return;
    const worldPt = this.clientToWorld(e.clientX, e.clientY);
    if (!this.hitTest(worldPt)) return;

    this.mode = this.modeFor(worldPt, e.shiftKey);
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = this.mode === "move" ? "move" : "grabbing";
    this.dragStartAoA = this.airfoil.params.aoaDeg;
    this.dragStartWorld = worldPt;
    this.dragStartPos = { x: this.airfoil.params.posXFrac, y: this.airfoil.params.posYFrac };
    const anchorClient = this.worldToClient(this.airfoil.getPivotWorld());
    this.dragStartAngle = Math.atan2(e.clientY - anchorClient.y, e.clientX - anchorClient.x);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.mode === null) {
      const worldPt = this.clientToWorld(e.clientX, e.clientY);
      const hover = !this.isLocked() && this.hitTest(worldPt);
      this.canvas.style.cursor = !hover ? "default" : this.modeFor(worldPt, e.shiftKey) === "move" ? "move" : "grab";
      return;
    }

    if (this.mode === "move") {
      const w = this.clientToWorld(e.clientX, e.clientY);
      // Airfoil clamps the position so the body stays inside the tunnel.
      this.airfoil.setParams({
        posXFrac: this.dragStartPos.x + (w.x - this.dragStartWorld.x) / GRID_W,
        posYFrac: this.dragStartPos.y + (w.y - this.dragStartWorld.y) / GRID_H,
      });
      return;
    }

    const anchorClient = this.worldToClient(this.airfoil.getPivotWorld());
    const angleNow = Math.atan2(e.clientY - anchorClient.y, e.clientX - anchorClient.x);
    // Rotating the grabbed point by this screen-space delta angle rotates
    // the whole rigid wing by the same amount, regardless of which point on
    // the wing was grabbed. Client y points down, so a positive delta is a
    // clockwise turn on screen, which with the nose on the left is nose-up,
    // i.e. +AoA. Unwrap across the +-180 degree seam.
    let delta = angleNow - this.dragStartAngle;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    const deltaDeg = (delta * 180) / Math.PI;
    const newAoA = clamp(this.dragStartAoA + deltaDeg, AOA_MIN_DEG, AOA_MAX_DEG);
    this.airfoil.setParams({ aoaDeg: newAoA });
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.mode === null) return;
    this.mode = null;
    this.canvas.style.cursor = "default";
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.isLocked() || !this.hitTest(this.clientToWorld(e.clientX, e.clientY))) return;
    e.preventDefault();
    // Scrolling up pitches the nose up.
    const step = e.deltaY < 0 ? WHEEL_STEP_DEG : -WHEEL_STEP_DEG;
    const snapped = Math.round((this.airfoil.params.aoaDeg + step) / WHEEL_STEP_DEG) * WHEEL_STEP_DEG;
    this.airfoil.setParams({ aoaDeg: clamp(snapped, AOA_MIN_DEG, AOA_MAX_DEG) });
  };
}
