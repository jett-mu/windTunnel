#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSource;
out vec4 outColor;

void main() {
  outColor = texture(uSource, vUv);
}
