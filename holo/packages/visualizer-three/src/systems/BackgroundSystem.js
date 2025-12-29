import * as THREE from 'three';

const DomeShader = {
  uniforms: {
    uTime: { value: 0 },
    uColorTop: { value: new THREE.Color('#050015') },
    uColorBottom: { value: new THREE.Color('#070a26') },
    uNoise: { value: 0.06 }
  },
  vertexShader: /* glsl */`
    varying vec3 vPos;
    void main() {
      vPos = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    varying vec3 vPos;
    uniform float uTime;
    uniform vec3 uColorTop;
    uniform vec3 uColorBottom;
    uniform float uNoise;

    // cheap hash noise
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      vec2 u = f*f*(3.0-2.0*f);
      return mix(a, b, u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
    }

    void main() {
      // Map y to 0..1 gradient (sphere is centered)
      float h = normalize(vPos).y * 0.5 + 0.5;
      vec3 col = mix(uColorBottom, uColorTop, smoothstep(0.0, 1.0, h));

      // subtle animated noise for "CRT haze"
      float n = noise(vPos.xz * 0.25 + uTime * 0.03) - 0.5;
      col += n * uNoise;

      gl_FragColor = vec4(col, 1.0);
    }
  `
};

const StarsShader = {
  uniforms: {
    uTime: { value: 0 },
    uOpacity: { value: 1.0 },
    uTwinkle: { value: 0.35 },
    uSize: { value: 1.6 }
  },
  vertexShader: /* glsl */`
    attribute float aPhase;
    varying float vPhase;
    uniform float uTime;
    uniform float uSize;

    void main() {
      vPhase = aPhase;
      vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPos;

      // Point size with perspective scaling
      float size = uSize * (1.0 / max(0.2, -mvPos.z));
      gl_PointSize = clamp(size, 0.0, 10.0);
    }
  `,
  fragmentShader: /* glsl */`
    varying float vPhase;
    uniform float uTime;
    uniform float uOpacity;
    uniform float uTwinkle;

    void main() {
      vec2 p = gl_PointCoord - 0.5;
      float r = length(p);

      // soft disc
      float d = smoothstep(0.5, 0.0, r);

      // twinkle
      float tw = 0.65 + 0.35 * sin(uTime * 2.5 + vPhase * 6.2831);
      tw = mix(1.0, tw, uTwinkle);

      gl_FragColor = vec4(vec3(1.0), d * uOpacity * tw);
    }
  `
};

export class BackgroundSystem {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'BackgroundSystem';
    scene.add(this.group);

    // Gradient dome (inverted sphere)
    const domeGeo = new THREE.SphereGeometry(60, 48, 32);
    this.domeMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(DomeShader.uniforms),
      vertexShader: DomeShader.vertexShader,
      fragmentShader: DomeShader.fragmentShader,
      side: THREE.BackSide,
      depthWrite: false
    });
    this.dome = new THREE.Mesh(domeGeo, this.domeMat);
    this.dome.name = 'GradientDome';
    this.group.add(this.dome);

    // Stars
    this.maxStars = 9000;
    const starGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(this.maxStars * 3);
    const phases = new Float32Array(this.maxStars);
    const rng = (seed) => {
      // tiny deterministic-ish PRNG for repeatability
      let s = seed >>> 0;
      return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    };
    const r = rng(1337);

    for (let i = 0; i < this.maxStars; i++) {
      // random direction on sphere
      const u = r();
      const v = r();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const rad = 35 + r() * 22;

      const x = rad * Math.sin(phi) * Math.cos(theta);
      const y = rad * Math.cos(phi);
      const z = rad * Math.sin(phi) * Math.sin(theta);

      positions[i * 3 + 0] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      phases[i] = r();
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    starGeo.setDrawRange(0, Math.floor(this.maxStars * 0.75));

    this.starMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(StarsShader.uniforms),
      vertexShader: StarsShader.vertexShader,
      fragmentShader: StarsShader.fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.name = 'Stars';
    this.group.add(this.stars);

    this._starRotation = 0;
    this.params = {
      colorTop: '#050015',
      colorBottom: '#070a26',
      starDensity: 0.75,
      starSpeed: 0.06,
      starTwinkle: 0.35,
      haze: 0.08
    };

    this.setParams(this.params);
  }

  /**
   * @param {Partial<typeof this.params>} patch
   */
  setParams(patch) {
    Object.assign(this.params, patch);

    this.domeMat.uniforms.uColorTop.value.set(this.params.colorTop);
    this.domeMat.uniforms.uColorBottom.value.set(this.params.colorBottom);
    this.domeMat.uniforms.uNoise.value = 0.04 + this.params.haze * 0.22;

    const drawCount = Math.max(0, Math.min(this.maxStars, Math.floor(this.maxStars * this.params.starDensity)));
    this.stars.geometry.setDrawRange(0, drawCount);

    this.starMat.uniforms.uTwinkle.value = this.params.starTwinkle;
    this.starMat.uniforms.uOpacity.value = 0.9;
    this.starMat.uniforms.uSize.value = 1.4 + this.params.starDensity * 1.3;

    // Scene fog for haze. (We keep it subtle, and you can disable by haze=0.)
    const haze = this.params.haze;
    if (haze > 0.0001) {
      this.scene.fog = new THREE.FogExp2(new THREE.Color(this.params.colorBottom), 0.012 + haze * 0.055);
    } else {
      this.scene.fog = null;
    }
  }

  /**
   * @param {number} dt
   * @param {number} t
   */
  update(dt, t) {
    this.domeMat.uniforms.uTime.value = t;
    this.starMat.uniforms.uTime.value = t;

    this._starRotation += dt * this.params.starSpeed;
    this.stars.rotation.y = this._starRotation;
    this.stars.rotation.x = Math.sin(t * 0.05) * 0.08;
  }

  dispose() {
    this.scene.remove(this.group);
    this.dome.geometry.dispose();
    this.domeMat.dispose();
    this.stars.geometry.dispose();
    this.starMat.dispose();
  }
}
