#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uObstacle;
uniform sampler2D uSmoke;
/** Solver grid texel: velocities are in grid cells/s, whatever the smoke resolution. */
uniform vec2 uTexel;
uniform float uDt;
out vec4 outColor;

// Forward half of the smoke's MacCormack advection: plain semi-Lagrangian.
// Half-float smoke is always filterable, so no sampleLinear needed.
void main() {
  outColor = vec4(texture(uSmoke, traceBack(uVelocity, uObstacle, vUv, uTexel, uDt)).x, 0.0, 0.0, 0.0);
}
