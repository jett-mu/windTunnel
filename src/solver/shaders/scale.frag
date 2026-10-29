#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSource;
uniform float uScale;
out vec4 outColor;

// Multiplies a field by a constant (used to rescale the flow when the
// freestream airspeed changes).
void main() {
  outColor = texture(uSource, vUv) * uScale;
}
