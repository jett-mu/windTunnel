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

// Semi-Lagrangian backtrace shared by the advection passes: where did the
// fluid now at `uv` come from `dt` seconds ago? Uses the midpoint (RK2)
// velocity so parcels follow curved streamlines (vortices, the leading
// edge) instead of cutting across them, and marches the displacement in
// steps of at most one cell, stopping at the last point still in fluid. At
// high airspeed a single straight trace spans 5-10+ cells per step and
// would otherwise reach clean through a thin trailing edge or flat plate,
// pulling flow from the far side straight through the solid.
const int MAX_TRACE_STEPS = 8;

vec2 traceBack(sampler2D velocity, sampler2D obstacle, vec2 uv, vec2 texel, float dt) {
  vec2 v0 = texture(velocity, uv).xy;
  vec2 vMid = sampleLinear(velocity, uv - 0.5 * dt * v0 * texel).xy;
  vec2 disp = dt * vMid * texel;
  float cells = length(disp / texel);
  int n = clamp(int(ceil(cells)), 1, MAX_TRACE_STEPS);
  vec2 stepUv = disp / float(n);
  vec2 pos = uv;
  for (int i = 0; i < MAX_TRACE_STEPS; i++) {
    if (i >= n) break;
    vec2 next = pos - stepUv;
    if (texture(obstacle, next).x > 0.5) break;
    pos = next;
  }
  return clamp(pos, vec2(0.0), vec2(1.0));
}
