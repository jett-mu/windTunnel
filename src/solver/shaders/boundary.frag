#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uObstacle;
uniform sampler2D uNeighbors;
uniform vec2 uTexel;
uniform float uInflowSpeed;
uniform float uMaxSpeed;
/** Obstacle wall slip, 0 (no-slip) .. 1 (free-slip); see wallModel.ts. */
uniform float uSlip;
out vec4 outColor;

// Enforces every boundary condition in one pass: the obstacle wall
// (Reynolds-dependent slip via ghost cells), Dirichlet inflow at the left
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

  // Obstacle. Fluid cells are left alone: no-penetration is already exact
  // in the projection (zero flux through wall faces + zero-gradient wall
  // pressure). Clipping "into-wall" velocity here as well, along a normal
  // estimated from a few mask texels, misjudged flow running along sloped
  // surfaces as heading into them and bled its momentum every step, which
  // made flow peel off the aft upper surface of an airfoil at small angles
  // of attack.
  if (texture(uObstacle, vUv).x >= 0.5) {
    // Ghost cell inside the body. Everything that interpolates velocity
    // near the wall (advection, particles, vorticity) reads these, so they
    // set the effective wall condition: the adjacent fluid's velocity
    // scaled by the slip factor, 0 being classic no-slip. See wallModel.ts
    // for why a coarse grid needs slip at high Reynolds numbers. Ghost
    // values never create flux through the wall: the divergence pass gives
    // wall faces zero flux.
    // (solidL, solidR, solidB, solidT), packed once per geometry change.
    vec4 open = 1.0 - texture(uNeighbors, vUv);
    float wSum = open.x + open.y + open.z + open.w;
    vec2 ghost = vec2(0.0);
    if (wSum > 1e-3 && uSlip > 0.0) {
      ghost = (open.x * texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).xy +
               open.y * texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).xy +
               open.z * texture(uVelocity, vUv - vec2(0.0, uTexel.y)).xy +
               open.w * texture(uVelocity, vUv + vec2(0.0, uTexel.y)).xy) / wSum * uSlip;
    }
    vel = ghost;
  }

  // Safety clamp: bounds any residual energy injection so a pathological
  // configuration can't compound into a blow-up over a long session, while
  // leaving normal flow speeds (a few times freestream) unaffected.
  float speed = length(vel);
  if (speed > uMaxSpeed) {
    vel = vel * (uMaxSpeed / speed);
  }

  outColor = vec4(vel, 0.0, 0.0);
}
