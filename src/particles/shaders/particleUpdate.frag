#version 300 es
precision highp float;
out vec4 outColor;

// Unused: rasterization is disabled during the transform-feedback update
// pass, but WebGL2 still requires a fragment shader to link the program.
void main() {
  outColor = vec4(0.0);
}
