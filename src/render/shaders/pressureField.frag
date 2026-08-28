#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPressure;
uniform sampler2D uObstacle;
uniform sampler2D uTrail;
uniform float uPressureScale;
uniform float uDynamicPressure;
out vec4 outColor;

vec3 colormap(float t) {
  vec3 c0 = vec3(0.06, 0.10, 0.55); // low pressure - blue
  vec3 c1 = vec3(0.03, 0.55, 0.45); // green
  vec3 c2 = vec3(0.90, 0.85, 0.15); // yellow
  vec3 c3 = vec3(0.95, 0.50, 0.06); // orange
  vec3 c4 = vec3(0.85, 0.06, 0.06); // high pressure - red
  t = clamp(t, 0.0, 1.0);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}

void main() {
  float p = texture(uPressure, vUv).x;
  float solid = texture(uObstacle, vUv).x;

  // Normalize by dynamic pressure (i.e. display pressure coefficient Cp),
  // since raw solver pressure scales with q = 0.5*rho*V^2. This is a fixed,
  // linear mapping: a given Cp value always lands on the same color,
  // regardless of what's happening elsewhere in the domain. (A signed-sqrt
  // "contrast boost" was tried here previously, but it amplified small
  // ambient noise far from the wing into large, distracting whole-field
  // color swings — plain linear scaling keeps quiet regions quiet.)
  float cp = p / max(uDynamicPressure, 1e-4);
  float t = 0.5 + cp * uPressureScale * 6.0;
  vec3 field = colormap(t);
  vec3 base = mix(field, vec3(0.02, 0.03, 0.05), solid);

  vec4 trail = texture(uTrail, vUv);
  vec3 composited = mix(base, trail.rgb, trail.a);

  outColor = vec4(composited, 1.0);
}
