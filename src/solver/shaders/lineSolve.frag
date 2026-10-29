#version 300 es
precision highp float;
/** Per column segment: (summed residual, open area of the right faces), from lineResidual. */
uniform sampler2D uLine;
out vec4 outColor;

// Solves the pressure equation exactly for a correction c(x) that is uniform
// down each column. Summed over a column, the vertical terms of the
// Laplacian cancel, leaving a 1D problem along the tunnel:
//   F(x + 1/2) - F(x - 1/2) = R(x),  F(x + 1/2) = A(x + 1/2) * (c(x + 1) - c(x)),
// with no flux through the inlet (F(-1/2) = 0) and c pinned to zero at the
// outlet column. So F is the running sum of R from the inlet, and c the
// running sum of -F / A back from the outlet. Each fragment walks the whole
// tunnel and keeps its own value. Runs twice: first (uReduce = 1) on a W x 1
// target to total each column's segments, then on the totals to solve.
uniform int uReduce;

void main() {
  ivec2 size = textureSize(uLine, 0);
  int x = int(gl_FragCoord.x);
  if (uReduce == 1) {
    vec2 sum = vec2(0.0);
    for (int s = 0; s < size.y; s++) sum += texelFetch(uLine, ivec2(x, s), 0).xy;
    outColor = vec4(sum, 0.0, 0.0);
    return;
  }
  float flux = 0.0;
  float c = 0.0;
  for (int i = 0; i < size.x - 1; i++) {
    vec2 ra = texelFetch(uLine, ivec2(i, 0), 0).xy;
    flux += ra.x;
    if (i >= x) c -= flux / max(ra.y, 1.0);
  }
  outColor = vec4(c, 0.0, 0.0, 0.0);
}
