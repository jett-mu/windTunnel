#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform float uDecay;
out vec4 outColor;

// Fades the accumulated trail buffer instead of clearing it each frame,
// producing cheap, convincing fading streamlines.
void main() {
  outColor = texture(uPrev, vUv) * uDecay;
}
