#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPressure;
uniform sampler2D uRhs;
uniform sampler2D uNeighbors;
uniform sampler2D uObstacle;
uniform vec2 uTexel;
uniform float uH2;
out vec4 outColor;

// Multigrid residual r = rhs - Laplacian(p), using exactly the operator the
// Jacobi smoother solves (mirrored solid taps, pinned outlet column).
// Masked to zero inside the obstacle so solid interiors don't leak a bogus
// correction onto the coarser grids.
void main() {
  if (vUv.x > 1.0 - uTexel.x * 1.5) {
    outColor = vec4(0.0);
    return;
  }
  float pC = texture(uPressure, vUv).x;
  vec4 w = 1.0 - texture(uNeighbors, vUv);
  float lap =
    w.x * (texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x - pC) +
    w.y * (texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x - pC) +
    w.z * (texture(uPressure, vUv - vec2(0.0, uTexel.y)).x - pC) +
    w.w * (texture(uPressure, vUv + vec2(0.0, uTexel.y)).x - pC);
  float r = texture(uRhs, vUv).x - lap / uH2;
  outColor = vec4(r * (1.0 - texture(uObstacle, vUv).x), 0.0, 0.0, 0.0);
}
