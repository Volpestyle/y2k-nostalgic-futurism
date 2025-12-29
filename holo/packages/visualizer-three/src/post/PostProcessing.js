import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { ScanlineChromaticShader } from './shaders/ScanlineChromaticShader.js';

export class PostProcessing {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {{ width: number, height: number, params: any }} options
   */
  constructor(renderer, scene, camera, options) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;

    const { width, height } = options;
    this.composer = new EffectComposer(renderer);
    this.composer.setSize(width, height);

    this.renderPass = new RenderPass(scene, camera);

    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 1.2, 0.35, 0.06);
    this.scanPass = new ShaderPass(ScanlineChromaticShader);

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.scanPass);

    this.setParams(options.params);
    this.setSize(width, height);
  }

  /**
   * @param {any} params
   */
  setParams(params) {
    if (!params) return;
    const p = params.post || params;

    this.enabled = !!p.enabled;

    this.bloomPass.strength = p.bloomStrength ?? this.bloomPass.strength;
    this.bloomPass.threshold = p.bloomThreshold ?? this.bloomPass.threshold;
    this.bloomPass.radius = p.bloomRadius ?? this.bloomPass.radius;

    this.scanPass.uniforms.uScanlines.value = p.scanlines ?? this.scanPass.uniforms.uScanlines.value;
    this.scanPass.uniforms.uChroma.value = p.chroma ?? this.scanPass.uniforms.uChroma.value;
    this.scanPass.uniforms.uNoise.value = p.noise ?? this.scanPass.uniforms.uNoise.value;
    this.scanPass.uniforms.uVignette.value = p.vignette ?? this.scanPass.uniforms.uVignette.value;
  }

  /**
   * @param {number} width
   * @param {number} height
   */
  setSize(width, height) {
    this.composer.setSize(width, height);
    this.bloomPass.setSize(width, height);

    this.scanPass.uniforms.uResolution.value[0] = width;
    this.scanPass.uniforms.uResolution.value[1] = height;
  }

  /**
   * @param {number} t
   */
  setTime(t) {
    this.scanPass.uniforms.uTime.value = t;
  }

  render() {
    if (!this.enabled) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.composer.render();
  }

  dispose() {
    // EffectComposer has no dispose, but passes do.
    this.renderPass.dispose?.();
    this.bloomPass.dispose?.();
    this.scanPass.dispose?.();
  }
}
