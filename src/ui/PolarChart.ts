import type { PolarPoint } from "../analysis/PolarSweep";

type PolarView = "lift" | "drag" | "moment";

const VIEWS: { id: PolarView; label: string }[] = [
  { id: "lift", label: "Cl–α" },
  { id: "drag", label: "Cl–Cd" },
  { id: "moment", label: "Cm–α" },
];

const LEFT_MARGIN = 34;
const BOTTOM_MARGIN = 16;
const TOP_MARGIN = 8;
const RIGHT_MARGIN = 8;

/** Rounds a raw tick spacing up to 1, 2 or 5 x 10^n. */
function niceStep(span: number, targetTicks: number): number {
  const raw = span / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}

/**
 * Plots polar-sweep results: lift curve (Cl vs AoA), drag polar (Cl vs Cd)
 * or pitching-moment curve. Same plain-canvas, paper-styled approach as
 * RollingGraph.
 */
export class PolarChart {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private view: PolarView = "lift";
  private points: PolarPoint[] = [];
  private tabs = new Map<PolarView, HTMLButtonElement>();
  private dpr = 1;

  constructor(container: HTMLElement) {
    const tabs = document.createElement("div");
    tabs.className = "segmented polar-tabs";
    for (const v of VIEWS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = v.label;
      b.addEventListener("click", () => {
        this.view = v.id;
        this.syncTabs();
        this.render();
      });
      this.tabs.set(v.id, b);
      tabs.appendChild(b);
    }
    container.appendChild(tabs);
    this.syncTabs();

    const wrap = document.createElement("div");
    wrap.className = "graph-canvas-wrap polar-canvas-wrap";
    const canvas = document.createElement("canvas");
    canvas.className = "graph-canvas";
    wrap.appendChild(canvas);
    container.appendChild(wrap);
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to acquire 2D context for polar chart");
    this.ctx = ctx;

    new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
      canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
      this.render();
    }).observe(wrap);
  }

  private syncTabs(): void {
    for (const [id, b] of this.tabs) b.classList.toggle("active", id === this.view);
  }

  setPoints(points: PolarPoint[]): void {
    this.points = points;
    this.render();
  }

  private render(): void {
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = "9px 'Kode Mono', ui-monospace, monospace";

    if (this.points.length === 0) {
      ctx.fillStyle = "#8a8d90";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Run a sweep to plot the polar", w / 2, h / 2);
      return;
    }

    const xOf = (p: PolarPoint) => (this.view === "drag" ? p.cd : p.aoaDeg);
    const yOf = (p: PolarPoint) => (this.view === "moment" ? p.cm : p.cl);
    const xs = this.points.map(xOf);
    const ys = this.points.map(yOf);
    const range = (vals: number[], includeZero: boolean) => {
      let lo = Math.min(...vals, ...(includeZero ? [0] : []));
      let hi = Math.max(...vals, ...(includeZero ? [0] : []));
      if (hi - lo < 1e-3) {
        lo -= 0.05;
        hi += 0.05;
      }
      const pad = (hi - lo) * 0.08;
      return [lo - pad, hi + pad];
    };
    const [x0, x1] = range(xs, this.view === "drag");
    const [y0, y1] = range(ys, true);
    const plotW = w - LEFT_MARGIN - RIGHT_MARGIN;
    const plotH = h - TOP_MARGIN - BOTTOM_MARGIN;
    const toX = (v: number) => LEFT_MARGIN + ((v - x0) / (x1 - x0)) * plotW;
    const toY = (v: number) => TOP_MARGIN + plotH - ((v - y0) / (y1 - y0)) * plotH;

    // Grid + labels.
    ctx.lineWidth = 1;
    ctx.fillStyle = "#8a8d90";
    const yStep = niceStep(y1 - y0, 4);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1; v += yStep) {
      const y = Math.round(toY(v)) + 0.5;
      ctx.strokeStyle = Math.abs(v) < yStep * 1e-6 ? "rgba(185,179,164,0.8)" : "rgba(22,24,26,0.08)";
      ctx.beginPath();
      ctx.moveTo(LEFT_MARGIN, y);
      ctx.lineTo(LEFT_MARGIN + plotW, y);
      ctx.stroke();
      ctx.fillText(v.toFixed(yStep < 0.1 ? 2 : 1), LEFT_MARGIN - 5, y);
    }
    const xStep = niceStep(x1 - x0, 5);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let v = Math.ceil(x0 / xStep) * xStep; v <= x1; v += xStep) {
      const x = Math.round(toX(v)) + 0.5;
      ctx.strokeStyle = Math.abs(v) < xStep * 1e-6 ? "rgba(185,179,164,0.8)" : "rgba(22,24,26,0.06)";
      ctx.beginPath();
      ctx.moveTo(x, TOP_MARGIN);
      ctx.lineTo(x, TOP_MARGIN + plotH);
      ctx.stroke();
      const label = this.view === "drag" ? v.toFixed(xStep < 0.01 ? 3 : 2) : `${Math.round(v)}°`;
      ctx.fillText(label, x, TOP_MARGIN + plotH + 3);
    }

    // Curve + markers, in sweep order.
    const color = this.view === "drag" ? "#d93c11" : "#16181a";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    this.points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(toX(xOf(p)), toY(yOf(p)));
      else ctx.lineTo(toX(xOf(p)), toY(yOf(p)));
    });
    ctx.stroke();
    ctx.fillStyle = "#fbfaf7";
    for (const p of this.points) {
      ctx.beginPath();
      ctx.arc(toX(xOf(p)), toY(yOf(p)), 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
