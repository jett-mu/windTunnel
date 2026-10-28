#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uVorticity;
uniform sampler2D uObstacle;
uniform vec2 uTexel;
uniform float uDt;
uniform float uAlpha;
uniform float uEpsilon;
out vec4 outColor;

// Everything that adds to velocity between advection and projection, in one
// pass:
//  - Viscosity as a single explicit diffusion step, x + nu*dt*Laplacian(x).
//    nu*dt stays far below the explicit stability limit (0.25) over the
//    whole slider range, so this matches the implicit Jacobi solve it
//    replaces for a twentieth of the cost.
//  - Vorticity confinement, which re-injects the small-scale rotational
//    energy numerical dissipation would otherwise damp out, so shed
//    vortices stay visible. It's faded out at the obstacle, where the
//    no-slip velocity jump reads as huge spurious vorticity and confinement
//    would otherwise pump energy into the surface.
void main() {
  vec2 vel = texture(uVelocity, vUv).xy;
  vec2 vL = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).xy;
  vec2 vR = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).xy;
  vec2 vB = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).xy;
  vec2 vT = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).xy;
  vec2 lap = vL + vR + vB + vT - 4.0 * vel;

  float cL = abs(texture(uVorticity, vUv - vec2(uTexel.x, 0.0)).x);
  float cR = abs(texture(uVorticity, vUv + vec2(uTexel.x, 0.0)).x);
  float cB = abs(texture(uVorticity, vUv - vec2(0.0, uTexel.y)).x);
  float cT = abs(texture(uVorticity, vUv + vec2(0.0, uTexel.y)).x);
  float c = texture(uVorticity, vUv).x;
  vec2 grad = 0.5 * vec2(cR - cL, cT - cB);
  vec2 n = grad / (length(grad) + 1e-5);
  vec2 confine = uEpsilon * vec2(n.y * c, -n.x * c);

  // The obstacle mask is linearly filtered, so sampling it a couple of
  // texels out gives a soft "distance to wall" falloff for free.
  float nearSolid = max(
    max(texture(uObstacle, vUv + vec2(2.0 * uTexel.x, 0.0)).x, texture(uObstacle, vUv - vec2(2.0 * uTexel.x, 0.0)).x),
    max(texture(uObstacle, vUv + vec2(0.0, 2.0 * uTexel.y)).x, texture(uObstacle, vUv - vec2(0.0, 2.0 * uTexel.y)).x)
  );
  confine *= 1.0 - max(nearSolid, texture(uObstacle, vUv).x);

  outColor = vec4(vel + uAlpha * lap + confine * uDt, 0.0, 0.0);
}
