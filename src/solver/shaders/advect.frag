#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uDt;
out vec4 outColor;

// Semi-Lagrangian advection: trace this texel's position backward along the
// velocity field by one timestep and sample the source field there.
void main() {
  vec2 vel = texture(uVelocity, vUv).xy;
  vec2 backUv = vUv - uDt * vel * uTexel;
  backUv = clamp(backUv, vec2(0.0), vec2(1.0));
  outColor = texture(uSource, backUv);
}
