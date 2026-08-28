#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform sampler2D uObstacle;
uniform vec2 uTexel;
out vec4 outColor;

// One Jacobi iteration of the pressure Poisson equation. Where a neighbor
// texel is solid, its pressure tap is replaced with the center value (the
// standard "mirror" trick), which enforces a zero-gradient (Neumann) pressure
// boundary at the obstacle surface without a separate pass.
void main() {
  float pC = texture(uPressure, vUv).x;

  vec2 offL = vUv - vec2(uTexel.x, 0.0);
  vec2 offR = vUv + vec2(uTexel.x, 0.0);
  vec2 offB = vUv - vec2(0.0, uTexel.y);
  vec2 offT = vUv + vec2(0.0, uTexel.y);

  float solidL = texture(uObstacle, offL).x;
  float solidR = texture(uObstacle, offR).x;
  float solidB = texture(uObstacle, offB).x;
  float solidT = texture(uObstacle, offT).x;

  float pL = mix(texture(uPressure, offL).x, pC, solidL);
  float pR = mix(texture(uPressure, offR).x, pC, solidR);
  float pB = mix(texture(uPressure, offB).x, pC, solidB);
  float pT = mix(texture(uPressure, offT).x, pC, solidT);

  float div = texture(uDivergence, vUv).x;
  float result = (pL + pR + pB + pT - div) * 0.25;

  // With Neumann conditions on every boundary the Poisson solve is only
  // defined up to an additive constant, which drifts unboundedly under
  // frame-to-frame warm-starting. Anchor it to zero at the outlet column,
  // matching the physical convention that pressure returns to freestream
  // static pressure far downstream.
  if (vUv.x > 1.0 - uTexel.x * 1.5) {
    result = 0.0;
  }

  outColor = vec4(result, 0.0, 0.0, 0.0);
}
