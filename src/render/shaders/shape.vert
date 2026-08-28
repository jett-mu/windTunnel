#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
uniform vec2 uGridSize;

// Shared by the airfoil outline and force-vector arrows: both are simple
// flat-colored line/triangle geometry expressed in grid-texel coordinates.
void main() {
  vec2 clip = (aPos / uGridSize) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
}
