#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uNeighbors;
uniform vec2 uTexel;
out vec4 outColor;

// Divergence as the net flux through this cell's four faces, each face
// carrying the average of the two cell velocities it separates, and zero
// through faces shared with the (stationary) obstacle. Away from walls this
// is exactly the central difference 0.5 * (vR - vL + vT - vB). At a wall it
// keeps the cell's own half of the flux, which the plain central difference
// drops; that's what makes it consistent with the pressure solve's
// zero-gradient wall (and with gradientSubtract). Without it the projection
// can never zero the divergence of wall-adjacent cells, and the residual
// error brakes near-wall flow every step until it separates.
void main() {
  vec2 c = texture(uVelocity, vUv).xy;
  vec4 open = 1.0 - texture(uNeighbors, vUv);
  float fluxL = 0.5 * (c.x + texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x) * open.x;
  float fluxR = 0.5 * (c.x + texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x) * open.y;
  float fluxB = 0.5 * (c.y + texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y) * open.z;
  float fluxT = 0.5 * (c.y + texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y) * open.w;
  outColor = vec4((fluxR - fluxL) + (fluxT - fluxB), 0.0, 0.0, 0.0);
}
