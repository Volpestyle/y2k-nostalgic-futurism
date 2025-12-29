import * as THREE from 'three';

const ParticleShader = {
  uniforms: {
    uTime: { value: 0 },
    uSize: { value: 1.2 },
    uSpeed: { value: 0.35 },
    uCurl: { value: 0.65 },
    uBass: { value: 0.0 },
    uLevel: { value: 0.0 },
    uBeat: { value: 0.0 },
    uColorA: { value: new THREE.Color('#a6fffb') },
    uColorB: { value: new THREE.Color('#ff9cf2') },
    uOpacity: { value: 0.75 }
  },
  vertexShader: /* glsl */`
    attribute float aSeed;
    attribute float aMix;
    varying float vMix;

    uniform float uTime;
    uniform float uSize;
    uniform float uSpeed;
    uniform float uCurl;
    uniform float uBass;
    uniform float uLevel;
    uniform float uBeat;

    mat2 rot(float a) {
      float s = sin(a);
      float c = cos(a);
      return mat2(c, -s, s, c);
    }

    void main() {
      vMix = aMix;

      vec3 p = position;

      float t = uTime * uSpeed + aSeed * 6.2831;

      // orbital rotation
      p.xz = rot(t * 0.7 + uBass * 0.6) * p.xz;
      p.xy = rot(t * 0.55 + uLevel * 0.4) * p.xy;

      // curl-ish wobble
      float c = uCurl;
      p.x += sin(t * 1.7 + p.y * 0.35) * 0.25 * c;
      p.y += cos(t * 1.3 + p.z * 0.35) * 0.22 * c;
      p.z += sin(t * 1.1 + p.x * 0.35) * 0.25 * c;

      // beat push (radial)
      float beat = uBeat;
      p *= 1.0 + beat * 0.25;

      vec4 mvPos = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mvPos;

      float size = uSize * (1.0 / max(0.2, -mvPos.z));
      // accent with bass
      size *= (1.0 + uBass * 0.8);
      gl_PointSize = clamp(size, 0.0, 18.0);
    }
  `,
  fragmentShader: /* glsl */`
    varying float vMix;
    uniform vec3 uColorA;
    uniform vec3 uColorB;
    uniform float uOpacity;

    void main() {
      vec2 p = gl_PointCoord - 0.5;
      float r = length(p);

      // soft disc with hot core
      float soft = smoothstep(0.5, 0.0, r);
      float core = smoothstep(0.15, 0.0, r);

      vec3 col = mix(uColorA, uColorB, vMix);
      col += core * 0.35;

      gl_FragColor = vec4(col, soft * uOpacity);
    }
  `
};

export class ParticleOrbitalVisualizer {
  constructor(params) {
    this.params = params;
    this.group = new THREE.Group();
    this.group.name = 'ParticleOrbitalVisualizer';

    this.points = null;
    this._needsRebuild = true;
  }

  init(ctx) {
    this.scene = ctx.scene;
    this.scene.add(this.group);
    this.rebuild();
  }

  setParams(params) {
    this.params = params;
    this._needsRebuild = true;
  }

  rebuild() {
    const p = this.params.particles;

    if (this.points) {
      this.points.geometry.dispose();
      this.points.material.dispose();
      this.group.remove(this.points);
      this.points = null;
    }

    const count = Math.max(100, Math.floor(p.count));
    const spread = p.spread;

    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const mixes = new Float32Array(count);

    // deterministic-ish RNG so preset feels consistent
    let s = 424242;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

    for (let i = 0; i < count; i++) {
      // random point in sphere (biased to shell)
      const u = rand();
      const v = rand();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const rad = spread * (0.35 + Math.pow(rand(), 0.35) * 0.65);

      const x = rad * Math.sin(phi) * Math.cos(theta);
      const y = rad * Math.cos(phi);
      const z = rad * Math.sin(phi) * Math.sin(theta);

      positions[i * 3 + 0] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      seeds[i] = rand();
      mixes[i] = rand();
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geo.setAttribute('aMix', new THREE.BufferAttribute(mixes, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(ParticleShader.uniforms),
      vertexShader: ParticleShader.vertexShader,
      fragmentShader: ParticleShader.fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.group.add(this.points);

    this._needsRebuild = false;
  }

  update(dt, t, audio) {
    if (this._needsRebuild) this.rebuild();
    if (!this.points) return;

    const p = this.params.particles;
    const mat = this.points.material;

    // update uniforms
    mat.uniforms.uTime.value = t;
    mat.uniforms.uSize.value = p.size;
    mat.uniforms.uSpeed.value = p.speed;
    mat.uniforms.uCurl.value = p.curl;
    mat.uniforms.uOpacity.value = p.opacity;
    mat.uniforms.uColorA.value.set(p.colorA);
    mat.uniforms.uColorB.value.set(p.colorB);

    mat.uniforms.uBass.value = audio.frame.bass || 0;
    mat.uniforms.uLevel.value = audio.frame.level || 0;
    mat.uniforms.uBeat.value = audio.frame.beat || 0;

    // slow group drift to keep it alive
    this.group.rotation.y += dt * (0.08 + (audio.frame.bass || 0) * 0.15);
    this.group.rotation.x = Math.sin(t * 0.21) * 0.08;
  }

  dispose() {
    if (this.points) {
      this.points.geometry.dispose();
      this.points.material.dispose();
      this.points = null;
    }
    this.scene?.remove(this.group);
  }
}
