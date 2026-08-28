#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uX;
uniform sampler2D uX0;
uniform vec2 uTexel;
uniform float uAlpha;
uniform float uInvBeta;
out vec4 outColor;

// One Jacobi iteration solving the implicit diffusion equation
// (I - nu*dt*Laplacian) x = x0 for viscosity. uX0 is the fixed snapshot taken
// before the iteration loop started; uX is the previous iterate.
void main() {
  vec2 xL = texture(uX, vUv - vec2(uTexel.x, 0.0)).xy;
  vec2 xR = texture(uX, vUv + vec2(uTexel.x, 0.0)).xy;
  vec2 xB = texture(uX, vUv - vec2(0.0, uTexel.y)).xy;
  vec2 xT = texture(uX, vUv + vec2(0.0, uTexel.y)).xy;
  vec2 x0 = texture(uX0, vUv).xy;

  vec2 result = (x0 + uAlpha * (xL + xR + xB + xT)) * uInvBeta;
  outColor = vec4(result, 0.0, 0.0);
}
