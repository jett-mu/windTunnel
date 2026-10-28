#version 300 es
precision highp float;
uniform sampler2D uObstacle;
out vec4 outColor;

// Packs each cell's four neighbor solid fractions (L, R, B, T) into one
// RGBA8 texel, rebuilt only when geometry changes, so the hot passes (every
// Jacobi iteration, divergence, gradient, boundary) do one fetch instead of
// four. Off-grid neighbors read as fluid: domain edges are handled by
// clamp-to-edge sampling in those passes instead.
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uObstacle, 0);
  float l = c.x > 0 ? texelFetch(uObstacle, c - ivec2(1, 0), 0).x : 0.0;
  float r = c.x < size.x - 1 ? texelFetch(uObstacle, c + ivec2(1, 0), 0).x : 0.0;
  float b = c.y > 0 ? texelFetch(uObstacle, c - ivec2(0, 1), 0).x : 0.0;
  float t = c.y < size.y - 1 ? texelFetch(uObstacle, c + ivec2(0, 1), 0).x : 0.0;
  outColor = vec4(l, r, b, t);
}
