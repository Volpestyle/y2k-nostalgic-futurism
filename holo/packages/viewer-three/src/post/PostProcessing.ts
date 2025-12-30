import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { ScanlineChromaticShader } from "./ScanlineChromaticShader";

export type PostParams = {
  enabled?: boolean;
  bloomStrength?: number;
  bloomThreshold?: number;
  bloomRadius?: number;
  scanlines?: number;
  chroma?: number;
  noise?: number;
  vignette?: number;
};

type PostOptions = {
  width: number;
  height: number;
  params?: PostParams;
};

export class PostProcessing {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloomPass: UnrealBloomPass;
  private scanPass: ShaderPass;
  enabled: boolean;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, options: PostOptions) {
    const { width, height } = options;
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;

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

  setParams(params?: PostParams) {
    if (!params) return;
    this.enabled = params.enabled ?? this.enabled;

    this.bloomPass.strength = params.bloomStrength ?? this.bloomPass.strength;
    this.bloomPass.threshold = params.bloomThreshold ?? this.bloomPass.threshold;
    this.bloomPass.radius = params.bloomRadius ?? this.bloomPass.radius;

    this.scanPass.uniforms.uScanlines.value = params.scanlines ?? this.scanPass.uniforms.uScanlines.value;
    this.scanPass.uniforms.uChroma.value = params.chroma ?? this.scanPass.uniforms.uChroma.value;
    this.scanPass.uniforms.uNoise.value = params.noise ?? this.scanPass.uniforms.uNoise.value;
    this.scanPass.uniforms.uVignette.value = params.vignette ?? this.scanPass.uniforms.uVignette.value;
  }

  setSize(width: number, height: number) {
    this.composer.setSize(width, height);
    this.bloomPass.setSize(width, height);
    this.scanPass.uniforms.uResolution.value[0] = width;
    this.scanPass.uniforms.uResolution.value[1] = height;
  }

  setTime(t: number) {
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
    this.renderPass.dispose?.();
    this.bloomPass.dispose?.();
    this.scanPass.dispose?.();
  }
}
