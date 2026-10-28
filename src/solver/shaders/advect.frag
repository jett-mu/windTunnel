#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform sampler2D uObstacle;
uniform vec2 uTexel;
uniform float uDt;
out vec4 outColor;

// Semi-Lagrangian advection: trace this texel's position backward along the
// velocity field by one timestep and sample the source field there. Also run
// with a negated uDt as the reverse half of the MacCormack scheme.
void main() {
  outColor = sampleLinear(uSource, traceBack(uVelocity, uObstacle, vUv, uTexel, uDt));
}
