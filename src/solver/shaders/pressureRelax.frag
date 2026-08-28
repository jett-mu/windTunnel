#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPressure;
uniform float uDecay;
out vec4 outColor;

// The inflow/outflow boundary pair doesn't perfectly conserve mass frame to
// frame (especially with the wing partially blocking the channel), so tiny
// per-frame imbalances otherwise accumulate into a large, slow drift of the
// whole domain's mean pressure over tens of seconds. A gentle multiplicative
// pull toward zero each frame bounds that drift on a several-second time
// constant without washing out the much-faster local dynamics near the wing
// (which re-converge within each frame's Jacobi iterations regardless).
void main() {
  outColor = vec4(texture(uPressure, vUv).x * uDecay, 0.0, 0.0, 0.0);
}
