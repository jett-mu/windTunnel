import { downloadText } from "./download";

/** Rolling window width, in simulation seconds (not wall-clock time) — so
 * raising the tick rate makes the chart visibly sweep faster, since more
 * sim-seconds land in the window per real second. */
const WINDOW_S = 15;
/** Ring-buffer size: comfortably more than a window's worth of samples at 240 Hz. */
const CAPACITY = 4096;
/** Redraw at most this often; the trace moves a fraction of a pixel per frame. */
const MIN_REDRAW_MS = 33;
const LEFT_MARGIN = 32;
const BOTTOM_MARGIN = 14;
const TOP_MARGIN = 6;
const RIGHT_MARGIN = 4;

/**
 * A scrolling Cl/Cd strip-chart embedded in the side panel, with labeled
 * axes and an interactive hover crosshair/tooltip. Plain canvas 2D — cheap
 * enough that a GPU pass would be overkill, and simpler to lay out text with.
 * Samples live in a fixed ring buffer, so pushing never allocates or shifts.
 */
export class RollingGraph {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tooltip: HTMLElement;
  private clValueEl: HTMLElement;
  private cdValueEl: HTMLElement;
  private clMeanEl: HTMLElement;
  private cdMeanEl: HTMLElement;
  private ts = new Float64Array(CAPACITY);
  private cls = new Float32Array(CAPACITY);
  private cds = new Float32Array(CAPACITY);
  private cms = new Float32Array(CAPACITY);
  /** Index of the oldest sample, and how many are stored. */
  private head = 0;
  private size = 0;
  private hoverX: number | null = null;
  private latestT = 0;
  private dpr: number;
  private dirty = true;
  private lastDraw = 0;

  constructor(container: HTMLElement) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    const bar = document.createElement("div");
    bar.className = "graph-wrap";

    const header = document.createElement("div");
    header.className = "graph-header";

    const legend = document.createElement("div");
    legend.className = "graph-legend";
    const clLabel = document.createElement("span");
    clLabel.className = "graph-legend-item cl";
    clLabel.textContent = "Cl";
    const clValue = document.createElement("span");
    clValue.className = "graph-legend-value";
    clLabel.appendChild(clValue);
    const cdLabel = document.createElement("span");
    cdLabel.className = "graph-legend-item cd";
    cdLabel.textContent = "Cd";
    const cdValue = document.createElement("span");
    cdValue.className = "graph-legend-value";
    cdLabel.appendChild(cdValue);
    legend.appendChild(clLabel);
    legend.appendChild(cdLabel);
    this.clValueEl = clValue;
    this.cdValueEl = cdValue;

    const actions = document.createElement("div");
    actions.className = "graph-actions";
    const csvBtn = document.createElement("button");
    csvBtn.className = "graph-reset";
    csvBtn.type = "button";
    csvBtn.textContent = "CSV";
    csvBtn.title = "Download the visible history as CSV";
    csvBtn.addEventListener("click", () => downloadText(this.toCSV(), "windtunnel-history.csv"));
    const resetBtn = document.createElement("button");
    resetBtn.className = "graph-reset";
    resetBtn.type = "button";
    resetBtn.textContent = "Reset";
    resetBtn.addEventListener("click", () => this.reset());
    actions.appendChild(csvBtn);
    actions.appendChild(resetBtn);

    header.appendChild(legend);
    header.appendChild(actions);
    bar.appendChild(header);

    const canvasWrap = document.createElement("div");
    canvasWrap.className = "graph-canvas-wrap";
    const canvas = document.createElement("canvas");
    canvas.className = "graph-canvas";
    canvasWrap.appendChild(canvas);
    bar.appendChild(canvasWrap);
    this.canvas = canvas;

    const tooltip = document.createElement("div");
    tooltip.className = "graph-tooltip";
    tooltip.style.display = "none";
    canvasWrap.appendChild(tooltip);
    this.tooltip = tooltip;

    const meanFooter = document.createElement("div");
    meanFooter.className = "graph-mean-footer";
    const clMean = document.createElement("span");
    clMean.className = "graph-mean-item cl";
    const cdMean = document.createElement("span");
    cdMean.className = "graph-mean-item cd";
    meanFooter.appendChild(clMean);
    meanFooter.appendChild(cdMean);
    bar.appendChild(meanFooter);
    this.clMeanEl = clMean;
    this.cdMeanEl = cdMean;

    container.appendChild(bar);

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to acquire 2D context for rolling graph");
    this.ctx = ctx;

    canvas.addEventListener("pointermove", (e) => this.onHover(e));
    canvas.addEventListener("pointerleave", () => {
      this.hoverX = null;
      this.tooltip.style.display = "none";
      this.render();
    });

    const resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    resizeObserver.observe(canvasWrap);
    this.resizeCanvas();
  }

  private resizeCanvas(): void {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.render();
  }

  reset(): void {
    this.head = 0;
    this.size = 0;
    this.render();
  }

  private at(i: number): number {
    return (this.head + i) % CAPACITY;
  }

  /** `simTime` is accumulated simulation seconds (not wall-clock time), so
   * the chart's sweep speed tracks the tick rate rather than real time. */
  push(cl: number, cd: number, cm: number, simTime: number): void {
    // A flow reset or anything else that rewinds time starts a fresh trace.
    if (simTime < this.latestT) this.size = 0;
    this.latestT = simTime;
    const slot = this.at(this.size);
    this.ts[slot] = simTime;
    this.cls[slot] = cl;
    this.cds[slot] = cd;
    this.cms[slot] = cm;
    if (this.size < CAPACITY) this.size++;
    else this.head = (this.head + 1) % CAPACITY;
    const cutoff = simTime - WINDOW_S;
    while (this.size > 0 && this.ts[this.head] < cutoff) {
      this.head = (this.head + 1) % CAPACITY;
      this.size--;
    }
    this.dirty = true;
  }

  /** Redraws if new data arrived, throttled. Call once per animation frame. */
  tick(now: number): void {
    if (!this.dirty || now - this.lastDraw < MIN_REDRAW_MS) return;
    this.lastDraw = now;
    if (this.size > 0) {
      const last = this.at(this.size - 1);
      this.clValueEl.textContent = `: ${this.cls[last].toFixed(3)}`;
      this.cdValueEl.textContent = `: ${this.cds[last].toFixed(3)}`;
    }
    this.render();
  }

  toCSV(): string {
    const rows = ["sim_time_s,cl,cd,cm"];
    for (let i = 0; i < this.size; i++) {
      const k = this.at(i);
      rows.push(`${this.ts[k].toFixed(4)},${this.cls[k].toFixed(5)},${this.cds[k].toFixed(5)},${this.cms[k].toFixed(5)}`);
    }
    return rows.join("\n");
  }

  private onHover(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.hoverX = e.clientX - rect.left;
    this.render();
  }

  private cssSize(): { w: number; h: number } {
    return { w: this.canvas.width / this.dpr, h: this.canvas.height / this.dpr };
  }

  private render(): void {
    this.dirty = false;
    const ctx = this.ctx;
    const { w, h } = this.cssSize();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const plotW = w - LEFT_MARGIN - RIGHT_MARGIN;
    const plotH = h - TOP_MARGIN - BOTTOM_MARGIN;
    if (plotW <= 0 || plotH <= 0) return;

    const now = this.latestT;
    const tMin = now - WINDOW_S;
    const toX = (t: number) => LEFT_MARGIN + ((t - tMin) / WINDOW_S) * plotW;

    // One pass for range and means.
    let lo = 0;
    let hi = 0;
    let clSum = 0;
    let cdSum = 0;
    for (let i = 0; i < this.size; i++) {
      const k = this.at(i);
      const cl = this.cls[k];
      const cd = this.cds[k];
      lo = Math.min(lo, cl, cd);
      hi = Math.max(hi, cl, cd);
      clSum += cl;
      cdSum += cd;
    }
    if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1e-4) {
      lo = -0.1;
      hi = 0.1;
    }
    const pad = (hi - lo) * 0.15;
    lo -= pad;
    hi += pad;
    const toY = (v: number) => TOP_MARGIN + plotH - ((v - lo) / (hi - lo)) * plotH;

    // Y-axis gridlines + labels.
    const yTicks = 4;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(22,24,26,0.08)";
    ctx.fillStyle = "#8a8d90";
    ctx.font = "9px 'Kode Mono', ui-monospace, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= yTicks; i++) {
      const v = lo + ((hi - lo) * i) / yTicks;
      const y = toY(v);
      ctx.beginPath();
      ctx.moveTo(LEFT_MARGIN, Math.round(y) + 0.5);
      ctx.lineTo(LEFT_MARGIN + plotW, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillText(v.toFixed(Math.abs(hi - lo) < 0.2 ? 3 : 2), LEFT_MARGIN - 6, y);
    }

    // Zero line, brighter.
    if (0 > lo && 0 < hi) {
      ctx.strokeStyle = "rgba(185,179,164,0.7)";
      ctx.beginPath();
      const y0 = Math.round(toY(0)) + 0.5;
      ctx.moveTo(LEFT_MARGIN, y0);
      ctx.lineTo(LEFT_MARGIN + plotW, y0);
      ctx.stroke();
    }

    // X-axis gridlines + labels, every 5s of the rolling window.
    ctx.textBaseline = "top";
    for (let sAgo = 0; sAgo <= WINDOW_S; sAgo += 5) {
      const x = toX(now - sAgo);
      ctx.strokeStyle = "rgba(22,24,26,0.06)";
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, TOP_MARGIN);
      ctx.lineTo(Math.round(x) + 0.5, TOP_MARGIN + plotH);
      ctx.stroke();
      ctx.fillStyle = "#8a8d90";
      // Right-align the "now" label so it doesn't spill past the canvas edge.
      ctx.textAlign = sAgo === 0 ? "right" : "center";
      ctx.fillText(sAgo === 0 ? "now" : `-${sAgo}s`, sAgo === 0 ? x + 2 : x, TOP_MARGIN + plotH + 3);
    }

    // Traces.
    const drawTrace = (data: Float32Array, color: string) => {
      if (this.size < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < this.size; i++) {
        const k = this.at(i);
        const x = toX(this.ts[k]);
        const y = toY(data[k]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    drawTrace(this.cds, "#d93c11");
    drawTrace(this.cls, "#16181a");

    // Dashed mean line for each trace over the currently visible window,
    // plus the numeric mean values shown in the footer below the chart.
    const clMean = this.size > 0 ? clSum / this.size : 0;
    const cdMean = this.size > 0 ? cdSum / this.size : 0;
    const drawMean = (value: number, color: string) => {
      const y = Math.round(toY(value)) + 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(LEFT_MARGIN, y);
      ctx.lineTo(LEFT_MARGIN + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (this.size > 0) {
      drawMean(cdMean, "rgba(217,60,17,0.7)");
      drawMean(clMean, "rgba(22,24,26,0.6)");
    }
    this.clMeanEl.textContent = `mean Cl ${clMean.toFixed(3)}`;
    this.cdMeanEl.textContent = `mean Cd ${cdMean.toFixed(3)}`;

    // Hover crosshair + tooltip.
    if (this.hoverX !== null && this.size > 0) {
      const hoverT = tMin + ((this.hoverX - LEFT_MARGIN) / plotW) * WINDOW_S;
      let nearest = this.head;
      let bestDist = Infinity;
      for (let i = 0; i < this.size; i++) {
        const k = this.at(i);
        const d = Math.abs(this.ts[k] - hoverT);
        if (d < bestDist) {
          bestDist = d;
          nearest = k;
        }
      }
      const x = toX(this.ts[nearest]);
      if (x >= LEFT_MARGIN && x <= LEFT_MARGIN + plotW) {
        ctx.strokeStyle = "rgba(22,24,26,0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, TOP_MARGIN);
        ctx.lineTo(Math.round(x) + 0.5, TOP_MARGIN + plotH);
        ctx.stroke();

        const ageS = (now - this.ts[nearest]).toFixed(1);
        this.tooltip.innerHTML = `-${ageS}s<br>Cl ${this.cls[nearest].toFixed(3)}<br>Cd ${this.cds[nearest].toFixed(3)}`;
        this.tooltip.style.display = "block";
        const tooltipWidth = 56;
        const tooltipX = Math.min(Math.max(x - tooltipWidth / 2, 0), w - tooltipWidth);
        this.tooltip.style.left = `${tooltipX}px`;
        this.tooltip.style.top = "2px";
      }
    } else {
      this.tooltip.style.display = "none";
    }
  }
}
