#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPressure;
uniform sampler2D uRhs;
uniform sampler2D uNeighbors;
uniform sampler2D uCoarse;
uniform vec2 uTexel;
uniform float uH2;
/** -1: update every cell (Jacobi). 0/1: update only cells whose (x + y)
 * parity matches, copying the rest (one half-sweep of red-black Gauss-Seidel). */
uniform int uParity;
/** Treat the current iterate as all-zero (first pass on a coarse level),
 * instead of clearing it in a separate pass. */
uniform int uZeroGuess;
/** Add the bilinearly-prolonged coarse-level correction to every value read
 * (multigrid coarse-grid correction fused into the first post-smoothing pass). */
uniform int uCorrect;
out vec4 outColor;

bool isOutlet(vec2 uv) {
  return uv.x > 1.0 - uTexel.x * 1.5;
}

// The current iterate at `uv`, with the optional zero guess / coarse
// correction applied, and the pinned outlet column (see below).
float iterate(vec2 uv) {
  if (isOutlet(uv)) return 0.0;
  float p = uZeroGuess == 1 ? 0.0 : texture(uPressure, uv).x;
  if (uCorrect == 1) p += sampleLinear(uCoarse, uv).x;
  return p;
}

// One Jacobi iteration, or one red-black Gauss-Seidel half-sweep, of the
// pressure Poisson equation Laplacian(p) = rhs, at any multigrid level
// (uH2 = squared grid spacing in fine-grid cells). Solid neighbors are
// mirrored (their tap reads the center value), which enforces a
// zero-gradient (Neumann) pressure boundary at the obstacle surface; solving
// for the center with the mirrored taps moved to the left-hand side
// converges faster than lagging them a step behind. Domain edges get the
// same Neumann behavior via clamp-to-edge sampling.
//
// Red-black ordering makes a half-sweep's updates depend only on the other
// color, which the previous half-sweep just refreshed: true Gauss-Seidel,
// which damps high-frequency error about twice as fast per pass as Jacobi,
// at the same cost.
void main() {
  // With Neumann conditions everywhere else the solve is only defined up to
  // a constant, so pin the outlet column to zero, matching the physical
  // convention that pressure returns to freestream static far downstream.
  float pC = iterate(vUv);
  if (isOutlet(vUv)) {
    outColor = vec4(0.0);
    return;
  }
  if (uParity >= 0) {
    ivec2 c = ivec2(gl_FragCoord.xy);
    if (((c.x + c.y) & 1) != uParity) {
      outColor = vec4(pC, 0.0, 0.0, 0.0);
      return;
    }
  }

  vec4 w = 1.0 - texture(uNeighbors, vUv);
  float sum =
    w.x * iterate(vUv - vec2(uTexel.x, 0.0)) +
    w.y * iterate(vUv + vec2(uTexel.x, 0.0)) +
    w.z * iterate(vUv - vec2(0.0, uTexel.y)) +
    w.w * iterate(vUv + vec2(0.0, uTexel.y));
  float wSum = w.x + w.y + w.z + w.w;

  float result = wSum > 1e-3 ? (sum - uH2 * texture(uRhs, vUv).x) / wSum : pC;
  outColor = vec4(result, 0.0, 0.0, 0.0);
}
