#version 300 es
precision highp float;
uniform sampler2D uFine;
out vec4 outColor;

// Restricts a fine-grid field to the next-coarser grid by averaging each
// 2x2 block. texelFetch rather than one bilinear tap at the block corner,
// since float textures may not be linearly filterable on this device.
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy) * 2;
  float sum =
    texelFetch(uFine, c, 0).x +
    texelFetch(uFine, c + ivec2(1, 0), 0).x +
    texelFetch(uFine, c + ivec2(0, 1), 0).x +
    texelFetch(uFine, c + ivec2(1, 1), 0).x;
  outColor = vec4(0.25 * sum, 0.0, 0.0, 0.0);
}
