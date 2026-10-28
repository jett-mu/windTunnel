#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uObstacle;
uniform sampler2D uSmoke;
uniform sampler2D uForward;
uniform vec2 uTexel;
uniform float uDt;
uniform vec2 uGridSize;
/** Rake: nozzle count, centre and span (uv), nozzle half-width (grid cells). */
uniform int uNozzles;
uniform float uRakeCenter;
uniform float uRakeSpan;
uniform float uNozzleHalfWidth;
/** Inlet band (uv) the nozzles own: clean air plus smoke, every step. */
uniform float uInjectWidth;
out vec4 outColor;

// MacCormack correction for the smoke density, as maccormack.frag does for
// velocity: plain semi-Lagrangian advection smears a thin smoke filament
// into a wide grey band within a chord or two. The backward trace runs
// inline (traceBack with -dt is the forward trace), and the result is
// clamped to the four source texels the forward trace read, which keeps it
// in [0, 1] and stable. Then the rake's nozzles re-emit at the inlet.
void main() {
  float forward = texture(uForward, vUv).x;
  float smoke = forward;
  if (texture(uObstacle, vUv).x <= 0.01) {
    float source = texture(uSmoke, vUv).x;
    float backward = texture(uForward, traceBack(uVelocity, uObstacle, vUv, uTexel, -uDt)).x;
    float corrected = forward + 0.5 * (source - backward);

    vec2 backUv = traceBack(uVelocity, uObstacle, vUv, uTexel, uDt);
    ivec2 size = textureSize(uSmoke, 0);
    ivec2 i0 = clamp(ivec2(floor(backUv * vec2(size) - 0.5)), ivec2(0), size - 1);
    ivec2 i1 = min(i0 + 1, size - 1);
    float a = texelFetch(uSmoke, i0, 0).x;
    float b = texelFetch(uSmoke, ivec2(i1.x, i0.y), 0).x;
    float c = texelFetch(uSmoke, ivec2(i0.x, i1.y), 0).x;
    float d = texelFetch(uSmoke, i1, 0).x;
    smoke = clamp(corrected, min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));
  }

  if (vUv.x < uInjectWidth) {
    // Nearest of uNozzles evenly spaced across the rake span.
    float spacing = uRakeSpan / float(uNozzles);
    float lo = uRakeCenter - 0.5 * uRakeSpan;
    float i = clamp(floor((vUv.y - lo) / spacing), 0.0, float(uNozzles - 1));
    float dist = abs(vUv.y - (lo + (i + 0.5) * spacing)) * uGridSize.y;
    // Overwrite rather than max(): the inlet column's backtrace lands on
    // itself, so anything left there (a nozzle that's since moved) would
    // otherwise keep emitting forever.
    smoke = 1.0 - smoothstep(uNozzleHalfWidth - 0.6, uNozzleHalfWidth + 0.6, dist);
  }

  outColor = vec4(smoke, 0.0, 0.0, 0.0);
}
