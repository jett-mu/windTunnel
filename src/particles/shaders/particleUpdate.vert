#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosAge;

uniform sampler2D uVelocity;
uniform sampler2D uObstacle;
uniform vec2 uVelScale;
uniform float uDt;
uniform float uMaxAge;
uniform float uSeed;

out vec3 vPosAge;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Advects one particle by sampling the velocity texture directly in the
// vertex shader (vertex texture fetch, core WebGL2), then respawns it near
// the inlet if it has left the domain, aged out, or drifted into the obstacle.
void main() {
  vec2 pos = aPosAge.xy;
  float age = aPosAge.z;

  vec2 vel = texture(uVelocity, pos).xy;
  pos += vel * uDt * uVelScale;
  age += uDt;

  float solid = texture(uObstacle, clamp(pos, 0.0, 1.0)).x;
  bool outOfBounds = pos.x > 1.0 || pos.x < 0.0 || pos.y < 0.0 || pos.y > 1.0;
  bool dead = age > uMaxAge || outOfBounds || solid > 0.5;

  if (dead) {
    float ry = hash(vec2(float(gl_VertexID) * 0.0173, uSeed));
    float rx = hash(vec2(uSeed, float(gl_VertexID) * 0.0313));
    pos = vec2(0.004 + rx * 0.01, ry);
    age = 0.0;
  }

  vPosAge = vec3(pos, age);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
