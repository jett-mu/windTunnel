#version 300 es
precision highp float;
// Per-instance (one particle): position+age after and before the latest step.
layout(location = 0) in vec3 aCurr;
layout(location = 1) in vec3 aPrev;

uniform sampler2D uVelocity;
uniform vec2 uViewport;
uniform float uHalfWidth;
/** Streak length (px) that gets full opacity; longer streaks are dimmer. */
uniform float uInkLength;
uniform vec3 uColor;
uniform int uColorBySpeed;
uniform float uFreestream;

out float vAlpha;
out vec3 vColor;
out float vAcross;

// Slow (separated/stagnant) -> blue, freestream -> near-white, fast
// (suction peak) -> orange.
vec3 speedRamp(float s) {
  vec3 slow = vec3(0.25, 0.45, 1.0);
  vec3 mid = vec3(0.95, 0.97, 1.0);
  vec3 fast = vec3(1.0, 0.55, 0.12);
  s = clamp(s, 0.0, 2.0);
  return s < 1.0 ? mix(slow, mid, s) : mix(mid, fast, s - 1.0);
}

// Draws each particle as a streak from where it was before the last step to
// where it is now: a 4-vertex quad (triangle strip, gl_VertexID 0..3),
// capped by half its width at both ends. Drawn after every solver step,
// consecutive streaks join into continuous streamlines however far a
// particle moves per step; point sprites drawn once per frame turned into
// separated dots at high airspeed or sim speed.
void main() {
  vec2 b = aCurr.xy * uViewport;
  // A particle respawned this step has a reset age; don't streak it across
  // the domain from its old position.
  vec2 a = aCurr.z < aPrev.z ? b : aPrev.xy * uViewport;
  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 1e-3 ? d / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float side = (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
  vec2 p = (gl_VertexID < 2 ? a - dir * uHalfWidth : b + dir * uHalfWidth) + normal * (uHalfWidth * side);
  vAcross = side;

  // Fade in over a fixed 0.3 sim-seconds after respawn to avoid a hard
  // "pop" at the inlet, independent of the (airspeed-scaled) lifetime.
  vAlpha = clamp(aCurr.z / 0.3, 0.0, 1.0);
  // Like a long-exposure photo: each particle lays down a fixed amount of
  // "ink" per step, spread along its streak. Otherwise faster flow (longer
  // streaks) would flood the trail buffer and wash out the field beneath.
  vAlpha *= clamp(uInkLength / (len + 2.0 * uHalfWidth), 0.02, 1.0);
  if (uColorBySpeed == 1) {
    float speed = length(sampleLinear(uVelocity, aCurr.xy).xy);
    vColor = speedRamp(speed / max(uFreestream, 1e-3));
  } else {
    vColor = uColor;
  }
  gl_Position = vec4(p / uViewport * 2.0 - 1.0, 0.0, 1.0);
}
