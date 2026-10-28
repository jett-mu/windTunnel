precision highp float;
precision highp sampler2D;

// Bilinear sampling helper for float textures. Without
// OES_texture_float_linear (common on iOS) float textures can only be
// sampled NEAREST, which breaks semi-Lagrangian advection and particle
// tracing, so filter by hand from four texelFetch taps instead.
#ifdef MANUAL_FILTER
vec4 sampleLinear(sampler2D tex, vec2 uv) {
  ivec2 size = textureSize(tex, 0);
  vec2 st = uv * vec2(size) - 0.5;
  vec2 base = floor(st);
  vec2 f = st - base;
  ivec2 i0 = clamp(ivec2(base), ivec2(0), size - 1);
  ivec2 i1 = clamp(ivec2(base) + 1, ivec2(0), size - 1);
  vec4 a = texelFetch(tex, ivec2(i0.x, i0.y), 0);
  vec4 b = texelFetch(tex, ivec2(i1.x, i0.y), 0);
  vec4 c = texelFetch(tex, ivec2(i0.x, i1.y), 0);
  vec4 d = texelFetch(tex, ivec2(i1.x, i1.y), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
#else
#define sampleLinear(tex, uv) texture(tex, uv)
#endif
