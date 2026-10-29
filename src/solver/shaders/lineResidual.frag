#version 300 es
precision highp float;
uniform sampler2D uPressure;
uniform sampler2D uRhs;
uniform sampler2D uNeighbors;
uniform sampler2D uObstacle;
out vec4 outColor;

// Runs on a W x LINE_SEGMENTS target (the count is injected as a define):
// each fragment sums the residual r = rhs - Laplacian(p) (same operator as
// residual.frag), and the open area of the right faces, over one segment of
// its fine-grid column. Splitting the columns keeps a few thousand fragments
// busy rather than a few hundred long serial loops. lineSolve totals the
// segments and turns them into the column-uniform correction; see
// Multigrid.lineCorrect.
void main() {
  ivec2 size = textureSize(uPressure, 0);
  int x = int(gl_FragCoord.x);
  if (x >= size.x - 1) {
    outColor = vec4(0.0);
    return;
  }
  int rows = size.y / LINE_SEGMENTS;
  int y0 = int(gl_FragCoord.y) * rows;
  float r = 0.0;
  float area = 0.0;
  for (int y = y0; y < y0 + rows; y++) {
    ivec2 c = ivec2(x, y);
    float fluid = 1.0 - texelFetch(uObstacle, c, 0).x;
    vec4 w = 1.0 - texelFetch(uNeighbors, c, 0);
    float pC = texelFetch(uPressure, c, 0).x;
    // Off-grid taps clamp to the cell itself: zero-gradient domain edges.
    float pL = texelFetch(uPressure, ivec2(max(x - 1, 0), y), 0).x;
    float pR = texelFetch(uPressure, ivec2(x + 1, y), 0).x;
    float pB = texelFetch(uPressure, ivec2(x, max(y - 1, 0)), 0).x;
    float pT = texelFetch(uPressure, ivec2(x, min(y + 1, size.y - 1)), 0).x;
    float lap = w.x * (pL - pC) + w.y * (pR - pC) + w.z * (pB - pC) + w.w * (pT - pC);
    r += (texelFetch(uRhs, c, 0).x - lap) * fluid;
    area += w.y * fluid;
  }
  outColor = vec4(r, area, 0.0, 0.0);
}
