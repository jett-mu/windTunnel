#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSampleUV;
uniform sampler2D uPressure;
out vec4 outColor;

// Batches all surface-pressure lookups into one small NxA1 target: texel i's
// vUv (from the shared fullscreen-quad passthrough vertex shader, exactly
// aligned to this buffer's texel centers) indexes uSampleUV to find where on
// the pressure field that surface sample point actually lives.
void main() {
  vec2 samplePos = texture(uSampleUV, vUv).xy;
  float p = texture(uPressure, samplePos).x;
  outColor = vec4(p, 0.0, 0.0, 0.0);
}
