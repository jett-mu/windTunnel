#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPressure;
uniform sampler2D uCoarse;
uniform vec2 uTexel;
out vec4 outColor;

// Multigrid coarse-grid correction: adds the bilinearly-interpolated
// coarse-level error estimate back onto this level's iterate.
void main() {
  float p = texture(uPressure, vUv).x;
  if (vUv.x > 1.0 - uTexel.x * 1.5) {
    outColor = vec4(0.0);
    return;
  }
  outColor = vec4(p + sampleLinear(uCoarse, vUv).x, 0.0, 0.0, 0.0);
}
