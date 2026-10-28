#version 300 es
precision highp float;
uniform sampler2D uPressure;
uniform sampler2D uRhs;
uniform sampler2D uNeighbors;
uniform sampler2D uObstacle;
uniform float uH2;
out vec4 outColor;

// Multigrid residual r = rhs - Laplacian(p) on the fine level, using exactly
// the operator the smoother solves (mirrored solid taps, pinned outlet
// column), masked to zero inside the obstacle so solid interiors don't leak
// a bogus correction onto the coarser grids.
float residualAt(ivec2 c, ivec2 size) {
  if (c.x >= size.x - 1) return 0.0;
  float pC = texelFetch(uPressure, c, 0).x;
  vec4 w = 1.0 - texelFetch(uNeighbors, c, 0);
  // Off-grid taps clamp to the cell itself: zero-gradient domain edges.
  float pL = texelFetch(uPressure, ivec2(max(c.x - 1, 0), c.y), 0).x;
  float pR = texelFetch(uPressure, ivec2(c.x + 1, c.y), 0).x;
  float pB = texelFetch(uPressure, ivec2(c.x, max(c.y - 1, 0)), 0).x;
  float pT = texelFetch(uPressure, ivec2(c.x, min(c.y + 1, size.y - 1)), 0).x;
  float lap = w.x * (pL - pC) + w.y * (pR - pC) + w.z * (pB - pC) + w.w * (pT - pC);
  float r = texelFetch(uRhs, c, 0).x - lap / uH2;
  return r * (1.0 - texelFetch(uObstacle, c, 0).x);
}

// Runs at the coarse level's resolution: computes the residual of the four
// fine cells under this coarse cell and averages them, fusing the residual
// and restriction steps into a single pass (each pass carries a fixed GPU
// cost that dominates on the small multigrid levels).
void main() {
  ivec2 size = textureSize(uPressure, 0);
  ivec2 c = ivec2(gl_FragCoord.xy) * 2;
  float sum =
    residualAt(c, size) +
    residualAt(c + ivec2(1, 0), size) +
    residualAt(c + ivec2(0, 1), size) +
    residualAt(c + ivec2(1, 1), size);
  outColor = vec4(0.25 * sum, 0.0, 0.0, 0.0);
}
