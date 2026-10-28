#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPressure;
uniform sampler2D uRhs;
uniform sampler2D uNeighbors;
uniform vec2 uTexel;
uniform float uH2;
uniform float uOmega;
out vec4 outColor;

// One (weighted) Jacobi iteration of the pressure Poisson equation
// Laplacian(p) = rhs, at any multigrid level (uH2 = squared grid spacing in
// fine-grid cells). Solid neighbors are mirrored (their tap reads the center
// value), which enforces a zero-gradient (Neumann) pressure boundary at the
// obstacle surface; solving for the center with the mirrored taps moved to
// the left-hand side converges faster than lagging them a step behind.
// Domain edges get the same Neumann behavior via clamp-to-edge sampling.
void main() {
  float pC = texture(uPressure, vUv).x;

  // With Neumann conditions everywhere else the solve is only defined up to
  // a constant, so pin the outlet column to zero, matching the physical
  // convention that pressure returns to freestream static far downstream.
  if (vUv.x > 1.0 - uTexel.x * 1.5) {
    outColor = vec4(0.0);
    return;
  }

  vec4 w = 1.0 - texture(uNeighbors, vUv);
  float sum =
    w.x * texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x +
    w.y * texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x +
    w.z * texture(uPressure, vUv - vec2(0.0, uTexel.y)).x +
    w.w * texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float wSum = w.x + w.y + w.z + w.w;

  float result = pC;
  if (wSum > 1e-3) {
    float jacobi = (sum - uH2 * texture(uRhs, vUv).x) / wSum;
    result = mix(pC, jacobi, uOmega);
  }
  outColor = vec4(result, 0.0, 0.0, 0.0);
}
