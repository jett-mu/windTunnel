#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosAge;

uniform sampler2D uVelocity;
uniform float uPointSize;
uniform vec3 uColor;
uniform int uColorBySpeed;
uniform float uFreestream;

out float vAlpha;
out vec3 vColor;

// Slow (separated/stagnant) -> blue, freestream -> near-white, fast
// (suction peak) -> orange.
vec3 speedRamp(float s) {
  vec3 slow = vec3(0.25, 0.45, 1.0);
  vec3 mid = vec3(0.95, 0.97, 1.0);
  vec3 fast = vec3(1.0, 0.55, 0.12);
  s = clamp(s, 0.0, 2.0);
  return s < 1.0 ? mix(slow, mid, s) : mix(mid, fast, s - 1.0);
}

void main() {
  vec2 pos = aPosAge.xy;
  float age = aPosAge.z;
  // Fade in over a fixed 0.3 sim-seconds after respawn to avoid a hard
  // "pop" at the inlet, independent of the (airspeed-scaled) lifetime.
  vAlpha = clamp(age / 0.3, 0.0, 1.0);
  if (uColorBySpeed == 1) {
    float speed = length(sampleLinear(uVelocity, pos).xy);
    vColor = speedRamp(speed / max(uFreestream, 1e-3));
  } else {
    vColor = uColor;
  }
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = uPointSize;
}
