import * as THREE from 'three';

export class ChromeGridWaveVisualizer {
  constructor(params) {
    this.params = params;
    this.group = new THREE.Group();
    this.group.name = 'ChromeGridWaveVisualizer';

    this.plane = null;
    this.wire = null;

    this._basePositions = null;
    this._frameCounter = 0;
    this._needsRebuild = true;
  }

  /**
   * @param {{scene: THREE.Scene}} ctx
   */
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
    const p = this.params.chromeGrid;

    // cleanup
    if (this.plane) {
      this.plane.geometry.dispose();
      this.plane.material.dispose();
      this.group.remove(this.plane);
      this.plane = null;
    }
    if (this.wire) {
      this.wire.geometry.dispose();
      this.wire.material.dispose();
      this.group.remove(this.wire);
      this.wire = null;
    }

    const size = p.size;
    const seg = Math.max(2, Math.floor(p.segments));

    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);

    // store base positions for stable displacement
    const pos = geo.attributes.position.array;
    this._basePositions = new Float32Array(pos.length);
    this._basePositions.set(pos);

    const baseMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#cfd7ff').multiplyScalar(0.7),
      metalness: p.chromeMetalness,
      roughness: p.chromeRoughness,
      emissive: new THREE.Color(p.glowColor),
      emissiveIntensity: 0.25
    });

    this.plane = new THREE.Mesh(geo, baseMat);
    this.plane.name = 'ChromePlane';
    this.plane.receiveShadow = false;
    this.plane.castShadow = false;
    this.plane.position.y = -1.8;
    this.group.add(this.plane);

    // wire overlay (additive, neon)
    const wireMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(p.accentColor),
      wireframe: true,
      transparent: true,
      opacity: p.lineOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.wire = new THREE.Mesh(geo.clone(), wireMat);
    this.wire.name = 'WireOverlay';
    this.wire.position.copy(this.plane.position);
    this.group.add(this.wire);

    // subtle tilt like a stage
    this.group.rotation.x = -0.12;
    this.group.position.z = 2.2;

    this._needsRebuild = false;
  }

  /**
   * @param {number} dt
   * @param {number} t
   * @param {{freqData: Uint8Array, timeData: Uint8Array, frame: any}} audio
   */
  update(dt, t, audio) {
    if (this._needsRebuild) this.rebuild();

    const p = this.params.chromeGrid;
    if (!this.plane) return;

    // Update material knobs that don't require rebuild
    this.plane.material.metalness = p.chromeMetalness;
    this.plane.material.roughness = p.chromeRoughness;
    this.plane.material.emissive.set(p.glowColor);
    this.wire.material.color.set(p.accentColor);
    this.wire.material.opacity = p.lineOpacity;
    this.wire.material.wireframe = !!p.wireframe;

    const geo = this.plane.geometry;
    const posAttr = geo.attributes.position;
    const arr = posAttr.array;

    const { freqData, frame } = audio;
    const n = freqData.length || 1;
    const height = p.height;

    // Wave parameters (retro-y)
    const speed = p.speed;
    const k1 = 0.55;
    const k2 = 0.72;

    // audio modulation: bass pushes big hills, treble adds shimmer
    const bass = frame.bass || 0;
    const treble = frame.treble || 0;
    const level = frame.level || 0;

    // animate plane
    const time = t * speed;

    // positions are interleaved x,y,z
    for (let i = 0; i < arr.length; i += 3) {
      const x = this._basePositions[i + 0];
      const y0 = this._basePositions[i + 1];
      const z = this._basePositions[i + 2];

      // u in 0..1 for sampling spectrum along x
      const u = (x / p.size) * 0.5 + 0.5;
      const bin = Math.min(n - 1, Math.max(0, Math.floor(u * (n - 1))));
      const s = (freqData[bin] / 255);

      const wave =
        Math.sin((x * k1) + time * 1.7) * 0.55 +
        Math.cos((z * k2) + time * 1.2) * 0.45;

      const ripple = Math.sin((x + z) * 1.05 + time * 2.2) * 0.18;

      const amp = height * (0.35 + bass * 1.1 + s * 0.75);
      const y = y0 + (wave + ripple) * amp + treble * 0.12 * Math.sin((x - z) * 2.2 + time * 4.0);

      arr[i + 1] = y;
    }

    posAttr.needsUpdate = true;

    // Recompute normals occasionally for a chrome-ish shading response.
    // (Not every frame to save CPU.)
    this._frameCounter++;
    if (this._frameCounter % 2 === 0) {
      geo.computeVertexNormals();
      geo.attributes.normal.needsUpdate = true;
    }

    // gently roll the stage with the beat
    const beat = frame.beat || 0;
    this.group.rotation.z = Math.sin(t * 0.45) * 0.05 + beat * 0.05;
    this.group.position.y = Math.sin(t * 0.6) * 0.08 + beat * 0.12;
  }

  dispose() {
    if (this.plane) {
      this.plane.geometry.dispose();
      this.plane.material.dispose();
    }
    if (this.wire) {
      this.wire.geometry.dispose();
      this.wire.material.dispose();
    }
    this.scene?.remove(this.group);
  }
}
