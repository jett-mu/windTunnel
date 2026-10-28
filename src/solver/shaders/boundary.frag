#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uObstacle;
uniform sampler2D uNeighbors;
uniform vec2 uTexel;
uniform float uInflowSpeed;
uniform float uMaxSpeed;
out vec4 outColor;

// Enforces every boundary condition in one pass: no-slip inside the
// obstacle and no-penetration at its surface, Dirichlet inflow at the left
// edge, zero-gradient outflow at the right edge, and free-slip tunnel walls
// at top/bottom. Run twice per step (pre- and post-pressure-projection) so
// the obstacle conditions hold after the projection perturbs near-boundary
// velocities.
void main() {
  vec2 vel = texture(uVelocity, vUv).xy;

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

  float solid = texture(uObstacle, vUv).x;
  // (solidL, solidR, solidB, solidT), packed once per geometry change.
  vec4 nb = texture(uNeighbors, vUv);
  float neighborSolid = max(max(nb.x, nb.y), max(nb.z, nb.w));

  // No-penetration: the mask gradient points into the wall, so strip any
  // velocity component heading that way while leaving tangential flow
  // alone (beyond a light no-slip drag), so flow can stay attached.
  vec2 intoWall = vec2(nb.y - nb.x, nb.w - nb.z);
  float gradLen = length(intoWall);
  if (gradLen > 1e-3) {
    vec2 n = intoWall / gradLen;
    vel -= max(dot(vel, n), 0.0) * n * min(1.0, neighborSolid * 2.0);
  }
  vel *= 1.0 - 0.15 * neighborSolid * (1.0 - solid);
  vel *= 1.0 - solid;

  // Safety clamp: bounds any residual energy injection so a pathological
  // configuration can't compound into a blow-up over a long session, while
  // leaving normal flow speeds (a few times freestream) unaffected.
  float speed = length(vel);
  if (speed > uMaxSpeed) {
    vel = vel * (uMaxSpeed / speed);
  }

  outColor = vec4(vel, 0.0, 0.0);
}
