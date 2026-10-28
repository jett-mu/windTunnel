#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSource;
uniform sampler2D uForward;
uniform sampler2D uBackward;
uniform sampler2D uObstacle;
uniform vec2 uTexel;
uniform float uDt;
out vec4 outColor;

// MacCormack correction: the forward semi-Lagrangian result plus half the
// round-trip error (forward then backward) estimates and cancels most of the
// scheme's numerical diffusion, keeping shed vortices sharp. The result is
// clamped to the range of the four source texels the forward trace
// interpolated between, which keeps it unconditionally stable, and plain
// semi-Lagrangian is used right at the obstacle where the round trip
// crosses solid cells and the error estimate is meaningless.
void main() {
  vec2 forward = texture(uForward, vUv).xy;
  if (texture(uObstacle, vUv).x > 0.01) {
    outColor = vec4(forward, 0.0, 0.0);
    return;
  }

  vec2 source = texture(uSource, vUv).xy;
  vec2 backward = texture(uBackward, vUv).xy;
  vec2 corrected = forward + 0.5 * (source - backward);

  // uSource is the velocity field itself (self-advection); retrace exactly
  // as the forward pass did, to find the texels it interpolated between.
  vec2 backUv = traceBack(uSource, uObstacle, vUv, uTexel, uDt);
  ivec2 size = textureSize(uSource, 0);
  ivec2 i0 = clamp(ivec2(floor(backUv * vec2(size) - 0.5)), ivec2(0), size - 1);
  ivec2 i1 = min(i0 + 1, size - 1);
  vec2 a = texelFetch(uSource, i0, 0).xy;
  vec2 b = texelFetch(uSource, ivec2(i1.x, i0.y), 0).xy;
  vec2 c = texelFetch(uSource, ivec2(i0.x, i1.y), 0).xy;
  vec2 d = texelFetch(uSource, i1, 0).xy;
  vec2 lo = min(min(a, b), min(c, d));
  vec2 hi = max(max(a, b), max(c, d));

  outColor = vec4(clamp(corrected, lo, hi), 0.0, 0.0);
}
