#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uPressure;
uniform sampler2D uNeighbors;
uniform vec2 uTexel;
out vec4 outColor;

// Projects the velocity field onto its divergence-free component by
// subtracting the pressure gradient. Same obstacle-mirroring trick as the
// pressure solve so the projection doesn't pull fluid velocity into solids.
void main() {
  float pC = texture(uPressure, vUv).x;
  vec4 solid = texture(uNeighbors, vUv);

  float pL = mix(texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x, pC, solid.x);
  float pR = mix(texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x, pC, solid.y);
  float pB = mix(texture(uPressure, vUv - vec2(0.0, uTexel.y)).x, pC, solid.z);
  float pT = mix(texture(uPressure, vUv + vec2(0.0, uTexel.y)).x, pC, solid.w);

  vec2 grad = 0.5 * vec2(pR - pL, pT - pB);
  vec2 vel = texture(uVelocity, vUv).xy;
  outColor = vec4(vel - grad, 0.0, 0.0);
}
