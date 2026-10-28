#version 300 es
precision highp float;
in float vAlpha;
in vec3 vColor;
out vec4 outColor;

void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  float mask = smoothstep(0.5, 0.15, r);
  outColor = vec4(vColor, vAlpha * mask * 0.935);
}
