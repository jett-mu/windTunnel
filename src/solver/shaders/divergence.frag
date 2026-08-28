#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
out vec4 outColor;

void main() {
  float vL = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float vR = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float vB = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  float vT = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
  float div = 0.5 * ((vR - vL) + (vT - vB));
  outColor = vec4(div, 0.0, 0.0, 0.0);
}
