#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSampleUV;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
out vec4 outColor;

// Batches all surface lookups into one small Nx1 target: texel i's vUv
// (from the shared fullscreen-quad passthrough vertex shader, exactly aligned
// to this buffer's texel centers) indexes uSampleUV to find where in the
// field that surface sample point lives. Returns (pressure, velocity.xy):
// pressure for the normal force, velocity for wall shear (skin friction).
void main() {
  vec2 samplePos = texture(uSampleUV, vUv).xy;
  float p = sampleLinear(uPressure, samplePos).x;
  vec2 v = sampleLinear(uVelocity, samplePos).xy;
  outColor = vec4(p, v, 0.0);
}
