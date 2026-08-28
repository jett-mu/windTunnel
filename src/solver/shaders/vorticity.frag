#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
out vec4 outColor;

// curl(v) = dv_y/dx - dv_x/dy, central differences.
void main() {
  float vL = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
  float vR = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
  float vB = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
  float vT = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
  float curl = 0.5 * ((vR - vL) - (vT - vB));
  outColor = vec4(curl, 0.0, 0.0, 0.0);
}
