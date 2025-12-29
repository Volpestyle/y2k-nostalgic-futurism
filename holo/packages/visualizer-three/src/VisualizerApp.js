import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import { EventEmitter } from './core/EventEmitter.js';
import { deepMerge, deepClone } from './core/deepMerge.js';

import { defaultParams } from './params/defaultParams.js';
import { paramSchema } from './params/paramSchema.js';
import { presets } from './presets.js';

import { AudioAnalyzer } from './audio/AudioAnalyzer.js';
import { BackgroundSystem } from './systems/BackgroundSystem.js';
import { PostProcessing } from './post/PostProcessing.js';

import { NeonRingsVisualizer } from './visualizers/NeonRingsVisualizer.js';
import { ChromeGridWaveVisualizer } from './visualizers/ChromeGridWaveVisualizer.js';
import { ParticleOrbitalVisualizer } from './visualizers/ParticleOrbitalVisualizer.js';

const VISUALIZER_REGISTRY = {
  neonRings: NeonRingsVisualizer,
  chromeGrid: ChromeGridWaveVisualizer,
  particles: ParticleOrbitalVisualizer
};

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

function setByPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function getByPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const k of parts) {
    if (!cur) return undefined;
    cur = cur[k];
  }
  return cur;
}

export class VisualizerApp extends EventEmitter {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{
   *  params?: any,
   *  preset?: string,
   *  antialias?: boolean,
   *  dpr?: number,
   *  background?: boolean,
   *  post?: boolean,
   *  orbit?: boolean
   * }} [options]
   */
  constructor(canvas, options = {}) {
    super();
    this.canvas = canvas;

    /** @type {any} */
    this.params = deepClone(defaultParams);
    if (options.params) deepMerge(this.params, options.params);

    this._running = false;
    this._raf = 0;
    this._t0 = performance.now();
    this._last = this._t0;

    // Scene / Camera / Renderer
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      this.params.global.camera.fov,
      1,
      0.01,
      220
    );
    this.camera.position.set(0, 1.2, 8.4);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: options.antialias ?? true,
      powerPreference: 'high-performance',
      alpha: false
    });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.renderer.setPixelRatio(options.dpr ?? Math.min(window.devicePixelRatio || 1, 2));

    // Environment map for PBR (chrome / glass)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(this.renderer), 0.04);
    this.scene.environment = envRT.texture;
    pmrem.dispose();

    // Orbit controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = false;
    this.controls.target.set(0, 0.2, 0);
    this.controls.update();

    // Lighting (y2k neon)
    this.ambient = new THREE.AmbientLight(0xffffff, 0.25);
    this.key = new THREE.PointLight(new THREE.Color('#ff4fd8'), 1.2, 60, 2);
    this.fill = new THREE.PointLight(new THREE.Color('#00e5ff'), 0.8, 60, 2);
    this.rim = new THREE.PointLight(new THREE.Color('#ffffff'), 1.4, 60, 2);

    this.key.position.set(6, 6, 5);
    this.fill.position.set(-6, 2.5, 6);
    this.rim.position.set(0, 7, -7);

    this.scene.add(this.ambient, this.key, this.fill, this.rim);

    // Systems
    this.background = new BackgroundSystem(this.scene);

    // Audio
    this.audio = new AudioAnalyzer();
    this.audio.setParams(this.params.audio);

    // Post
    this.post = new PostProcessing(this.renderer, this.scene, this.camera, {
      width: 2,
      height: 2,
      params: this.params
    });

    // Visualizer instance
    /** @type {any} */
    this.visualizer = null;

    // Resize
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(this.canvas);

    this.setParams(this.params, { silent: true });

    // Initialize preset
    const preset = options.preset ?? this.params.preset ?? 'neonRings';
    this.setPreset(preset, { silent: true });

    // Start loop by default
    this.start();
  }

  // ---------------------------
  // Public API for UI integration
  // ---------------------------

  /** Returns a deep clone of the current params. */
  getParams() {
    return deepClone(this.params);
  }

  /** A form-friendly schema for building UI controls. */
  getParamSchema() {
    return paramSchema;
  }

  /** Preset list for building a dropdown. */
  getPresets() {
    return presets.map(p => ({ id: p.id, label: p.label }));
  }

  /**
   * Patch params in a single call (recommended).
   * Emits: 'params' with { params, patch }
   * @param {any} patch
   * @param {{silent?: boolean}} [opts]
   */
  setParams(patch, opts = {}) {
    const beforePreset = this.params.preset;
    deepMerge(this.params, patch);

    // Apply camera / controls / lights / systems
    this._applyGlobal();

    // Audio params
    if (patch.audio) this.audio.setParams(this.params.audio);

    // Post params
    if (patch.post) this.post.setParams(this.params);

    // If preset field changed, honor it.
    if (this.params.preset !== beforePreset) {
      this.setPreset(this.params.preset, { silent: true });
    }

    // Pass params to current visualizer
    if (this.visualizer?.setParams) {
      this.visualizer.setParams(this.params);
    }

    if (!opts.silent) this.emit('params', { params: this.getParams(), patch });
  }

  /**
   * Set a single param by dot-path.
   * Useful for generic UI builders.
   * @param {string} path
   * @param {any} value
   */
  setParam(path, value) {
    const patch = {};
    setByPath(patch, path, value);
    this.setParams(patch);
  }

  /**
   * Get param by dot-path.
   * @param {string} path
   */
  getParam(path) {
    return getByPath(this.params, path);
  }

  /**
   * Swap to a different visualizer preset.
   * Emits: 'preset' with { id }
   * @param {string} id
   * @param {{silent?: boolean}} [opts]
   */
  setPreset(id, opts = {}) {
    // find preset definition (optional)
    const def = presets.find(p => p.id === id);
    const visualizerId = def?.visualizer ?? id;
    const Ctor = VISUALIZER_REGISTRY[visualizerId];

    if (!Ctor) {
      console.warn(`[VisualizerApp] Unknown preset/visualizer: ${id}`);
      return;
    }

    // dispose previous
    if (this.visualizer?.dispose) {
      this.visualizer.dispose();
    }
    this.visualizer = new Ctor(this.params);
    this.visualizer.init({ scene: this.scene, camera: this.camera, renderer: this.renderer });

    // Apply preset param patch if provided (without recursively calling setPreset)
    if (def?.params) {
      const patch = deepClone(def.params);
      patch.preset = id;
      // Apply as params but avoid preset loop by silent + internal handling
      deepMerge(this.params, patch);
      this._applyGlobal();
      this.audio.setParams(this.params.audio);
      this.post.setParams(this.params);
      this.visualizer.setParams(this.params);
    } else {
      this.params.preset = id;
    }

    if (!opts.silent) this.emit('preset', { id });
  }

  /**
   * Connect an HTMLAudioElement to the analyzer.
   * @param {HTMLAudioElement} el
   */
  async setAudioElement(el) {
    await this.audio.resume();
    this.audio.connectToAudioElement(el);
    this.emit('audio', { type: 'element', element: el });
  }

  /**
   * Connect microphone input to the analyzer.
   * @param {MediaStream} stream
   */
  async setMicStream(stream) {
    await this.audio.resume();
    this.audio.connectToStream(stream);
    this.emit('audio', { type: 'mic', stream });
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    this._tick();
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(2, Math.floor(rect.width));
    const height = Math.max(2, Math.floor(rect.height));

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(width, height, false);
    this.post.setSize(width, height);

    this.emit('resize', { width, height });
  }

  panBy(deltaX, deltaY) {
    if (!this.controls?.enablePan) return;

    const camera = this.camera;
    const element = this.renderer.domElement;
    const target = this.controls.target;

    const panOffset = new THREE.Vector3();
    const offset = new THREE.Vector3();
    const panLeft = new THREE.Vector3();
    const panUp = new THREE.Vector3();

    const applyPan = (distanceX, distanceY) => {
      panLeft.setFromMatrixColumn(camera.matrix, 0).multiplyScalar(-distanceX);
      if (this.controls.screenSpacePanning) {
        panUp.setFromMatrixColumn(camera.matrix, 1);
      } else {
        panUp.setFromMatrixColumn(camera.matrix, 0).crossVectors(camera.up, panUp);
      }
      panUp.multiplyScalar(distanceY);
      panOffset.add(panLeft).add(panUp);
    };

    if (camera.isPerspectiveCamera) {
      offset.copy(camera.position).sub(target);
      let targetDistance = offset.length();
      targetDistance *= Math.tan((camera.fov * Math.PI) / 360);

      applyPan(
        (2 * deltaX * targetDistance) / element.clientHeight,
        (2 * deltaY * targetDistance) / element.clientHeight
      );
    } else if (camera.isOrthographicCamera) {
      applyPan(
        (deltaX * (camera.right - camera.left)) / camera.zoom / element.clientWidth,
        (deltaY * (camera.top - camera.bottom)) / camera.zoom / element.clientHeight
      );
    }

    if (panOffset.lengthSq() === 0) return;
    camera.position.add(panOffset);
    target.add(panOffset);
    this.controls.update();
  }

  dispose() {
    this.stop();
    this._resizeObserver?.disconnect();

    this.visualizer?.dispose?.();
    this.background?.dispose?.();
    this.post?.dispose?.();
    this.audio?.disconnect?.();

    this.renderer.dispose();

    this.emit('dispose', {});
  }

  // ---------------------------
  // Internal
  // ---------------------------

  _applyGlobal() {
    // camera / controls
    const cam = this.params.global.camera;
    this.camera.fov = cam.fov;
    this.camera.updateProjectionMatrix();

    this.controls.minDistance = cam.minDistance;
    this.controls.maxDistance = cam.maxDistance;
    this.controls.autoRotate = !!cam.autoRotate;
    this.controls.autoRotateSpeed = cam.autoRotateSpeed;

    const ctr = this.params.global.controls;
    this.controls.enablePan = !!ctr.enablePan;
    this.controls.enableZoom = !!ctr.enableZoom;
    this.controls.dampingFactor = ctr.dampingFactor;

    // lights
    const l = this.params.global.lighting;
    this.key.intensity = l.keyIntensity;
    this.fill.intensity = l.fillIntensity;
    this.rim.intensity = l.rimIntensity;

    // background system
    this.background.setParams(this.params.global.background);

    // clamp a few dangerous params
    this.params.post.chroma = clamp(this.params.post.chroma, 0, 0.02);
    this.params.post.noise = clamp(this.params.post.noise, 0, 0.8);
    this.params.post.scanlines = clamp(this.params.post.scanlines, 0, 1);

    this.post.setParams(this.params);
  }

  _tick = () => {
    if (!this._running) return;

    this._raf = requestAnimationFrame(this._tick);

    const now = performance.now();
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;

    const t = (now - this._t0) / 1000;

    // Update
    const audio = this.audio.update();
    this.background.update(dt, t);
    this.controls.update();

    if (this.visualizer?.update) {
      this.visualizer.update(dt, t, audio);
    }

    // Render
    this.post.setTime(t);
    this.post.render();
  };
}
