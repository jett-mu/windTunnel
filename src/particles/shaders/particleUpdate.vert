#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosAge;

uniform sampler2D uVelocity;
uniform sampler2D uObstacle;
uniform vec2 uVelScale;
uniform float uDt;
uniform float uMaxAge;
uniform int uFrame;

out vec3 vPosAge;

// PCG integer hash. The usual fract(sin(x) * 43758.5) trick loses most of
// its bits on GPUs with low-precision sin for large x, which made respawn
// positions visibly clump into stripes on some mobile parts.
uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

float rand(uint a, uint b) {
  return float(pcg(a ^ pcg(b))) * (1.0 / 4294967295.0);
}

// Advects one particle with a midpoint (RK2) step, sampling the velocity
// texture directly in the vertex shader (vertex texture fetch, core WebGL2),
// so particles follow curved streamlines around the leading edge instead of
// cutting the corner. Respawns it near the inlet if it has left the domain,
// aged out, or ended up deep inside the obstacle.
void main() {
  vec2 pos = aPosAge.xy;
  float age = aPosAge.z;

  vec2 v1 = sampleLinear(uVelocity, pos).xy;
  vec2 mid = clamp(pos + 0.5 * uDt * v1 * uVelScale, 0.0, 1.0);
  vec2 v2 = sampleLinear(uVelocity, mid).xy;
  pos += uDt * v2 * uVelScale;
  age += uDt;

  // A particle that steps into the body's anti-aliased edge (the step can
  // be a couple of cells at speed) is pushed back out along the mask
  // gradient, so it slides along the surface. Killing it instead would
  // strip particles from exactly the streamlines that hug the wall, leaving
  // a misleading empty band around the body.
  for (int k = 0; k < 2; k++) {
    float s = texture(uObstacle, clamp(pos, 0.0, 1.0)).x;
    if (s <= 0.4) break;
    vec2 g = vec2(
      texture(uObstacle, pos + vec2(uVelScale.x, 0.0)).x - texture(uObstacle, pos - vec2(uVelScale.x, 0.0)).x,
      texture(uObstacle, pos + vec2(0.0, uVelScale.y)).x - texture(uObstacle, pos - vec2(0.0, uVelScale.y)).x
    );
    if (dot(g, g) < 1e-8) break;
    pos -= normalize(g) * uVelScale * (s - 0.3) * 2.0;
  }

  float solid = texture(uObstacle, clamp(pos, 0.0, 1.0)).x;
  bool outOfBounds = pos.x > 1.0 || pos.x < 0.0 || pos.y < 0.0 || pos.y > 1.0;
  bool dead = age > uMaxAge || outOfBounds || solid > 0.5;

  if (dead) {
    uint id = uint(gl_VertexID);
    uint frame = uint(uFrame);
    pos = vec2(0.004 + rand(id, frame) * 0.01, rand(id + 0x9e3779b9u, frame));
    age = 0.0;
  }

  vPosAge = vec3(pos, age);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
