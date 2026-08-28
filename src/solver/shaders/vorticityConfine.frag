#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uVorticity;
uniform vec2 uTexel;
uniform float uEpsilon;
uniform float uDt;
out vec4 outColor;

// Vorticity confinement: re-injects the small-scale rotational energy that
// numerical dissipation would otherwise damp out, so shed vortices stay
// visible instead of smearing into a featureless wake.
void main() {
  float cL = abs(texture(uVorticity, vUv - vec2(uTexel.x, 0.0)).x);
  float cR = abs(texture(uVorticity, vUv + vec2(uTexel.x, 0.0)).x);
  float cB = abs(texture(uVorticity, vUv - vec2(0.0, uTexel.y)).x);
  float cT = abs(texture(uVorticity, vUv + vec2(0.0, uTexel.y)).x);
  float c = texture(uVorticity, vUv).x;

  vec2 grad = 0.5 * vec2(cR - cL, cT - cB);
  float len = length(grad) + 1e-5;
  vec2 n = grad / len;

  vec2 force = uEpsilon * vec2(n.y * c, -n.x * c);

  vec2 vel = texture(uVelocity, vUv).xy;
  outColor = vec4(vel + force * uDt, 0.0, 0.0);
}
