#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosAge;

uniform float uMaxAge;
uniform float uPointSize;

out float vAlpha;

void main() {
  vec2 pos = aPosAge.xy;
  float age = aPosAge.z;
  // Fade in just after respawn to avoid a hard "pop" at the inlet.
  vAlpha = clamp(age / (0.08 * uMaxAge), 0.0, 1.0);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = uPointSize;
}
