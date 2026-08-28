#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform vec2 uForce;
uniform float uDt;
out vec4 outColor;

// Extension point for future interactive forces (mouse gusts, buoyancy, etc).
// In v1 this is effectively a passthrough since uForce defaults to (0,0) —
// the actual driver of flow is the inflow boundary condition in boundary.frag.
void main() {
  vec2 vel = texture(uVelocity, vUv).xy;
  outColor = vec4(vel + uForce * uDt, 0.0, 0.0);
}
