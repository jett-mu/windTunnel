#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uNeighbors;
uniform vec2 uTexel;
out vec4 outColor;

// Central-difference divergence, treating solid neighbors as zero velocity
// (the obstacle is stationary) so the projection sees the true wall flux.
void main() {
  vec4 open = 1.0 - texture(uNeighbors, vUv);
  float vL = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x * open.x;
  float vR = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x * open.y;
  float vB = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y * open.z;
  float vT = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y * open.w;
  float div = 0.5 * ((vR - vL) + (vT - vB));
  outColor = vec4(div, 0.0, 0.0, 0.0);
}
