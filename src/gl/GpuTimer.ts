interface PendingQuery {
  label: string;
  query: WebGLQuery;
}

/**
 * Lightweight GPU pass timing via EXT_disjoint_timer_query_webgl2, used only
 * by the `?debug` HUD. Queries can't nest, so callers time sequential,
 * non-overlapping sections (solver, particles, render). Results arrive a few
 * frames late and are smoothed with an EMA. Silently a no-op when the
 * extension is unavailable (Safari, most mobile).
 */
export class GpuTimer {
  private gl: WebGL2RenderingContext;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private pending: PendingQuery[] = [];
  private active: PendingQuery | null = null;
  private results = new Map<string, number>();
  readonly enabled: boolean;

  constructor(gl: WebGL2RenderingContext, enabled: boolean) {
    this.gl = gl;
    this.ext = enabled ? gl.getExtension("EXT_disjoint_timer_query_webgl2") : null;
    this.enabled = this.ext !== null;
  }

  begin(label: string): void {
    if (!this.ext || this.active) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = { label, query };
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Collects any finished queries. Call once per frame. */
  poll(): void {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length > 0) {
      const head = this.pending[0];
      if (!gl.getQueryParameter(head.query, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      if (!disjoint) {
        const ms = gl.getQueryParameter(head.query, gl.QUERY_RESULT) / 1e6;
        const prev = this.results.get(head.label);
        this.results.set(head.label, prev === undefined ? ms : prev + (ms - prev) * 0.1);
      }
      gl.deleteQuery(head.query);
    }
  }

  get(label: string): number | undefined {
    return this.results.get(label);
  }
}
