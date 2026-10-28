#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPressure;
uniform sampler2D uObstacle;
uniform sampler2D uTrail;
uniform sampler2D uVelocity;
uniform sampler2D uVorticity;
uniform sampler2D uSmoke;
uniform int uViewMode;
uniform int uShowTrails;
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
const vec3 SMOKE = vec3(0.93, 0.95, 0.97);

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
  } else if (uViewMode == 4) {
    // Pseudo-schlieren. A knife-edge schlieren system images the density
    // gradient across the edge; at low Mach density follows pressure
    // (isentropically), so the nondimensional gradient L * dCp/dy stands in.
    // Grey where the flow is uniform, lighter/darker either side of
    // compressions and expansions, vortex cores as light/dark pairs.
    // Central difference over 4 cells, averaged across 3 columns: the
    // projection leaves cell-scale pressure ripple along the stair-stepped
    // wall that a 1-cell stencil turns into a row of specks.
    vec2 px = 1.0 / vec2(textureSize(uPressure, 0));
    float dp = 0.0;
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i) * 1.5 * px.x, 0.0);
      dp += sampleLinear(uPressure, vUv + o + vec2(0.0, 2.0 * px.y)).x -
            sampleLinear(uPressure, vUv + o - vec2(0.0, 2.0 * px.y)).x;
    }
    float g = dp / (12.0 * max(uDt * 0.5 * uFreestream * uFreestream, 1e-6)) * uRefLength;
    // Square-root response, like a sensitive knife edge: the gentle far-field
    // gradients still show while the leading edge saturates.
    float k = tanh(sign(g) * sqrt(abs(g) * uScale * 0.25));
    // That stencil reaches into the body, where pressure is meaningless;
    // fade to neutral within reach of the wall.
    float wall = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      wall = max(wall, texture(uObstacle, vUv + vec2(cos(a), sin(a)) * 2.5 * px).x);
    }
    k *= 1.0 - wall;
    field = vec3(0.30 + 0.28 * k) * vec3(1.0, 0.98, 0.94);
  } else if (uViewMode == 5) {
    // Smoke streams, lit against a black tunnel. Saturating, so where
    // streams pile up (the separated wake) it reads as dense fog.
    float d = texture(uSmoke, vUv).x;
    field = mix(vec3(0.015, 0.018, 0.024), SMOKE, 1.0 - exp(-3.0 * d * uScale));
  } else {
    field = BACKDROP;
  }

  float solid = texture(uObstacle, vUv).x;
  vec3 base = mix(field, vec3(0.02, 0.03, 0.05), solid);

  // Trails are premultiplied alpha.
  vec4 trail = uShowTrails == 1 ? texture(uTrail, vUv) : vec4(0.0);
  outColor = vec4(base * (1.0 - trail.a) + trail.rgb, 1.0);
}
