export const ScanlineChromaticShader = {
  name: "ScanlineChromaticShader",
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: [1, 1] },
    uScanlines: { value: 0.2 },
    uChroma: { value: 0.0018 },
    uNoise: { value: 0.05 },
    uVignette: { value: 0.28 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uScanlines;
    uniform float uChroma;
    uniform float uNoise;
    uniform float uVignette;
    varying vec2 vUv;

    float rand(vec2 co) {
      return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;

      vec2 off = vec2(uChroma, 0.0);
      float r = texture2D(tDiffuse, uv + off).r;
      float g = texture2D(tDiffuse, uv).g;
      float b = texture2D(tDiffuse, uv - off).b;
      vec3 col = vec3(r, g, b);

      float y = uv.y * uResolution.y;
      float scan = 0.5 + 0.5 * sin(y * 1.25 + uTime * 20.0);
      scan = mix(1.0, scan, uScanlines);
      col *= scan;

      float n = rand(uv * (uResolution.xy / 3.0) + uTime * 0.05);
      col += (n - 0.5) * uNoise;

      vec2 p = uv - 0.5;
      float v = smoothstep(0.85, 0.25, dot(p, p));
      col *= mix(1.0, v, uVignette);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
