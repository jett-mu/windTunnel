#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPressure;
uniform sampler2D uObstacle;
uniform sampler2D uTrail;
uniform sampler2D uVelocity;
uniform sampler2D uVorticity;
uniform int uViewMode;
uniform float uScale;
uniform float uDt;
uniform float uFreestream;
uniform float uRefLength;
out vec4 outColor;

vec3 colormap(float t) {
  vec3 c0 = vec3(0.06, 0.10, 0.55); // low - blue
  vec3 c1 = vec3(0.03, 0.55, 0.45); // green
  vec3 c2 = vec3(0.90, 0.85, 0.15); // yellow
  vec3 c3 = vec3(0.95, 0.50, 0.06); // orange
  vec3 c4 = vec3(0.85, 0.06, 0.06); // high - red
  t = clamp(t, 0.0, 1.0);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}

const vec3 BACKDROP = vec3(0.045, 0.055, 0.075);

void main() {
  vec3 field;
  if (uViewMode == 0) {
    // Pressure coefficient Cp = P / q. The solver's pressure is the
    // projection potential (P * dt / rho), so Cp = p / (dt * V^2 / 2) with
    // density cancelling. A fixed, linear mapping: a given Cp always lands
    // on the same color regardless of what's happening elsewhere in the
    // domain, which keeps quiet regions quiet.
    float p = sampleLinear(uPressure, vUv).x;
    float cp = p / max(uDt * 0.5 * uFreestream * uFreestream, 1e-6);
    field = colormap(0.5 + cp * uScale * 0.15);
  } else if (uViewMode == 1) {
    // Speed relative to freestream: freestream sits mid-scale, stagnant
    // and separated flow goes blue, accelerated (suction-side) flow red.
    float s = length(sampleLinear(uVelocity, vUv).xy) / max(uFreestream, 1e-3);
    field = colormap(0.5 + (s - 1.0) * uScale * 0.5);
  } else if (uViewMode == 2) {
    // Nondimensional vorticity w*L/V on a dark diverging map, so shed
    // vortices and shear layers stand out against irrotational flow:
    // counter-clockwise red, clockwise blue.
    float w = sampleLinear(uVorticity, vUv).x * uRefLength / max(uFreestream, 1e-3);
    float k = tanh(w * uScale * 0.04);
    field = mix(BACKDROP, k > 0.0 ? vec3(0.95, 0.32, 0.18) : vec3(0.22, 0.55, 1.0), abs(k));
  } else {
    field = BACKDROP;
  }

  float solid = texture(uObstacle, vUv).x;
  vec3 base = mix(field, vec3(0.02, 0.03, 0.05), solid);

  // Trails are premultiplied alpha.
  vec4 trail = texture(uTrail, vUv);
  outColor = vec4(base * (1.0 - trail.a) + trail.rgb, 1.0);
}
