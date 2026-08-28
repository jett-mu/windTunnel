interface Sample {
  t: number; // simulation time, seconds
  cl: number;
  cd: number;
}

/** Rolling window width, in simulation seconds (not wall-clock time) — so
 * raising the tick rate makes the chart visibly sweep faster, since more
 * sim-seconds land in the window per real second. */
const WINDOW_S = 15;
const LEFT_MARGIN = 32;
const BOTTOM_MARGIN = 14;
const TOP_MARGIN = 6;
const RIGHT_MARGIN = 4;

/**
 * A scrolling Cl/Cd strip-chart embedded in the side panel, with labeled
 * axes and an interactive hover crosshair/tooltip. Plain canvas 2D — cheap
 * enough that a GPU pass would be overkill, and simpler to lay out text with.
 */
export class RollingGraph {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tooltip: HTMLElement;
  private clValueEl: HTMLElement;
  private cdValueEl: HTMLElement;
  private clMeanEl: HTMLElement;
  private cdMeanEl: HTMLElement;
  private samples: Sample[] = [];
  private hoverX: number | null = null;
  private latestT = 0;
  private dpr: number;

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

    const resetBtn = document.createElement("button");
    resetBtn.className = "graph-reset";
    resetBtn.type = "button";
    resetBtn.textContent = "Reset";
    resetBtn.addEventListener("click", () => this.reset());

    header.appendChild(legend);
    header.appendChild(resetBtn);
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

    canvas.addEventListener("mousemove", (e) => this.onHover(e));
    canvas.addEventListener("mouseleave", () => {
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
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.render();
  }

  reset(): void {
    this.samples = [];
    this.render();
  }

  /** `simTime` is accumulated simulation seconds (not wall-clock time), so
   * the chart's sweep speed tracks the tick rate rather than real time. */
  push(cl: number, cd: number, simTime: number): void {
    this.latestT = simTime;
    this.samples.push({ t: simTime, cl, cd });
    const cutoff = simTime - WINDOW_S;
    while (this.samples.length > 0 && this.samples[0].t < cutoff) this.samples.shift();
    this.clValueEl.textContent = `: ${cl.toFixed(3)}`;
    this.cdValueEl.textContent = `: ${cd.toFixed(3)}`;
    this.render();
  }

  private onHover(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.hoverX = e.clientX - rect.left;
    this.render();
  }

  private cssSize(): { w: number; h: number } {
    return { w: this.canvas.width / this.dpr, h: this.canvas.height / this.dpr };
  }

  private render(): void {
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

    const cls = this.samples.map((s) => s.cl);
    const cds = this.samples.map((s) => s.cd);
    let lo = Math.min(0, ...cls, ...cds);
    let hi = Math.max(0, ...cls, ...cds);
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
      ctx.fillText(v.toFixed(2), LEFT_MARGIN - 6, y);
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
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let sAgo = 0; sAgo <= WINDOW_S; sAgo += 5) {
      const t = now - sAgo;
      const x = toX(t);
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
    const drawTrace = (key: "cd" | "cl", color: string) => {
      if (this.samples.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      this.samples.forEach((s, i) => {
        const x = toX(s.t);
        const y = toY(s[key]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    drawTrace("cd", "#d93c11");
    drawTrace("cl", "#16181a");

    // Dashed mean line for each trace over the currently visible window,
    // plus the numeric mean values shown in the footer below the chart.
    const mean = (data: number[]) => (data.length === 0 ? 0 : data.reduce((a, b) => a + b, 0) / data.length);
    const clMean = mean(cls);
    const cdMean = mean(cds);
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
    if (cds.length > 0) drawMean(cdMean, "rgba(217,60,17,0.7)");
    if (cls.length > 0) drawMean(clMean, "rgba(22,24,26,0.6)");
    this.clMeanEl.textContent = `mean Cl ${clMean.toFixed(3)}`;
    this.cdMeanEl.textContent = `mean Cd ${cdMean.toFixed(3)}`;

    // Hover crosshair + tooltip.
    if (this.hoverX !== null && this.samples.length > 0) {
      const hoverT = tMin + ((this.hoverX - LEFT_MARGIN) / plotW) * WINDOW_S;
      let nearest = this.samples[0];
      let bestDist = Infinity;
      for (const s of this.samples) {
        const d = Math.abs(s.t - hoverT);
        if (d < bestDist) {
          bestDist = d;
          nearest = s;
        }
      }
      const x = toX(nearest.t);
      if (x >= LEFT_MARGIN && x <= LEFT_MARGIN + plotW) {
        ctx.strokeStyle = "rgba(22,24,26,0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, TOP_MARGIN);
        ctx.lineTo(Math.round(x) + 0.5, TOP_MARGIN + plotH);
        ctx.stroke();

        const ageS = (now - nearest.t).toFixed(1);
        this.tooltip.innerHTML = `-${ageS}s<br>Cl ${nearest.cl.toFixed(3)}<br>Cd ${nearest.cd.toFixed(3)}`;
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
