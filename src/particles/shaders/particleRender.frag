#version 300 es
precision highp float;
in float vAlpha;
in vec3 vColor;
in float vAcross;
out vec4 outColor;

void main() {
  // Soft edge across the streak's width.
  float mask = smoothstep(1.0, 0.3, abs(vAcross));
  outColor = vec4(vColor, vAlpha * mask * 0.935);
}
