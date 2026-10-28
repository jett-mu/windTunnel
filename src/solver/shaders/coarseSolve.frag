#version 300 es
precision highp float;
uniform sampler2D uRhs;
uniform sampler2D uNeighbors;
uniform float uH2;
out vec4 outColor;

// COARSE_W / COARSE_H are injected as defines (the coarsest grid size).
#define N (COARSE_W * COARSE_H)
const int SWEEPS = 48;
const float SOR = 1.5;

// Solves the coarsest multigrid level outright in a single pass. The grid is
// tiny (tens of unknowns), so every fragment loads the whole system into
// registers and runs SOR Gauss-Seidel on it serially, then writes out just
// its own cell. That replaces a dozen-plus Jacobi passes, each of which
// costs far more in fixed per-pass GPU overhead than in arithmetic, and is
// converged rather than approximate. Same operator as the other levels:
// mirrored solid taps, zero-gradient domain edges, pinned outlet column.
void main() {
  float p[N];
  float b[N];
  vec4 w[N];
  for (int y = 0; y < COARSE_H; y++) {
    for (int x = 0; x < COARSE_W; x++) {
      int i = y * COARSE_W + x;
      p[i] = 0.0;
      b[i] = uH2 * texelFetch(uRhs, ivec2(x, y), 0).x;
      vec4 open = 1.0 - texelFetch(uNeighbors, ivec2(x, y), 0);
      // Off-grid taps drop out entirely: exact zero-gradient edges.
      if (x == 0) open.x = 0.0;
      if (y == 0) open.z = 0.0;
      if (y == COARSE_H - 1) open.w = 0.0;
      w[i] = open;
    }
  }

  for (int s = 0; s < SWEEPS; s++) {
    for (int y = 0; y < COARSE_H; y++) {
      // The outlet column (x = COARSE_W - 1) stays pinned at zero.
      for (int x = 0; x < COARSE_W - 1; x++) {
        int i = y * COARSE_W + x;
        vec4 o = w[i];
        float wSum = o.x + o.y + o.z + o.w;
        if (wSum < 1e-3) continue;
        float sum = o.y * p[i + 1];
        if (x > 0) sum += o.x * p[i - 1];
        if (y > 0) sum += o.z * p[i - COARSE_W];
        if (y < COARSE_H - 1) sum += o.w * p[i + COARSE_W];
        p[i] = mix(p[i], (sum - b[i]) / wSum, SOR);
      }
    }
  }

  ivec2 c = ivec2(gl_FragCoord.xy);
  outColor = vec4(p[c.y * COARSE_W + c.x], 0.0, 0.0, 0.0);
}
