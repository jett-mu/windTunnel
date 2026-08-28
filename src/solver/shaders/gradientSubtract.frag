#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uPressure;
uniform sampler2D uObstacle;
uniform vec2 uTexel;
out vec4 outColor;

// Projects the velocity field onto its divergence-free component by
// subtracting the pressure gradient. Same obstacle-mirroring trick as the
// pressure solve so the projection doesn't pull fluid velocity into solids.
void main() {
  float pC = texture(uPressure, vUv).x;

  vec2 offL = vUv - vec2(uTexel.x, 0.0);
  vec2 offR = vUv + vec2(uTexel.x, 0.0);
  vec2 offB = vUv - vec2(0.0, uTexel.y);
  vec2 offT = vUv + vec2(0.0, uTexel.y);

  float solidL = texture(uObstacle, offL).x;
  float solidR = texture(uObstacle, offR).x;
  float solidB = texture(uObstacle, offB).x;
  float solidT = texture(uObstacle, offT).x;

  float pL = mix(texture(uPressure, offL).x, pC, solidL);
  float pR = mix(texture(uPressure, offR).x, pC, solidR);
  float pB = mix(texture(uPressure, offB).x, pC, solidB);
  float pT = mix(texture(uPressure, offT).x, pC, solidT);

  vec2 grad = 0.5 * vec2(pR - pL, pT - pB);
  vec2 vel = texture(uVelocity, vUv).xy;
  outColor = vec4(vel - grad, 0.0, 0.0);
}
