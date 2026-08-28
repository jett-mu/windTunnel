#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uObstacle;
uniform vec2 uTexel;
uniform float uInflowSpeed;
uniform float uMaxSpeed;
out vec4 outColor;

// Enforces every boundary condition in one pass: no-slip inside/at the
// obstacle, Dirichlet inflow at the left edge, zero-gradient outflow at the
// right edge, and free-slip tunnel walls at top/bottom. Run twice per frame
// (pre- and post-pressure-projection) so obstacle no-slip is guaranteed to
// hold after the projection perturbs near-boundary velocities.
void main() {
  vec2 vel = texture(uVelocity, vUv).xy;
  float solid = texture(uObstacle, vUv).x;

  // Left inlet: forced freestream velocity.
  if (vUv.x < uTexel.x * 1.5) {
    vel = vec2(uInflowSpeed, 0.0);
  }
  // Right outlet: zero-gradient (copy interior neighbor) so flow exits freely.
  else if (vUv.x > 1.0 - uTexel.x * 1.5) {
    vel = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).xy;
  }
  // Top/bottom walls: free-slip — kill the perpendicular component only.
  else if (vUv.y < uTexel.y * 1.5) {
    vec2 inner = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).xy;
    vel = vec2(inner.x, 0.0);
  } else if (vUv.y > 1.0 - uTexel.y * 1.5) {
    vec2 inner = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).xy;
    vel = vec2(inner.x, 0.0);
  }

  // Obstacle: no-slip. Also lightly damp velocity in cells adjacent to the
  // obstacle to approximate no-penetration without a full SDF.
  float solidL = texture(uObstacle, vUv - vec2(uTexel.x, 0.0)).x;
  float solidR = texture(uObstacle, vUv + vec2(uTexel.x, 0.0)).x;
  float solidB = texture(uObstacle, vUv - vec2(0.0, uTexel.y)).x;
  float solidT = texture(uObstacle, vUv + vec2(0.0, uTexel.y)).x;
  float neighborSolid = max(max(solidL, solidR), max(solidB, solidT));

  vel = mix(vel, vec2(0.0), solid);
  vel = mix(vel, vel * 0.5, neighborSolid * (1.0 - solid));

  // Safety clamp: vorticity confinement can inject more energy than the
  // (deliberately light, user-tunable) diffusion pass removes, especially
  // right at the obstacle boundary. Bounding speed prevents that from
  // compounding into an unbounded blow-up over a long-running session while
  // leaving normal flow speeds (a few times freestream) unaffected.
  float speed = length(vel);
  if (speed > uMaxSpeed) {
    vel = vel * (uMaxSpeed / speed);
  }

  outColor = vec4(vel, 0.0, 0.0);
}
