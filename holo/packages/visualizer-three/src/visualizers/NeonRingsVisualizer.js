import * as THREE from 'three';

export class NeonRingsVisualizer {
  constructor(params) {
    this.params = params;
    this.group = new THREE.Group();
    this.group.name = 'NeonRingsVisualizer';

    this.rings = [];
    this._tmpColorA = new THREE.Color();
    this._tmpColorB = new THREE.Color();
    this._tmpColor = new THREE.Color();

    // A subtle central orb for Y2K "chrome bubble" vibes
    this.orb = null;

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

  /**
   * @param {any} params
   */
  setParams(params) {
    this.params = params;
    // Rebuild for structural changes
    this._needsRebuild = true;
  }

  rebuild() {
    const p = this.params.neonRings;

    // clear existing
    for (const m of this.rings) {
      m.geometry.dispose();
      m.material.dispose();
      this.group.remove(m);
    }
    this.rings.length = 0;

    if (this.orb) {
      this.orb.geometry.dispose();
      this.orb.material.dispose();
      this.group.remove(this.orb);
      this.orb = null;
    }

    const ringCount = Math.max(1, Math.floor(p.ringCount));
    const radius = p.radius;
    const thickness = p.thickness;

    this._tmpColorA.set(p.colorA);
    this._tmpColorB.set(p.colorB);

    for (let i = 0; i < ringCount; i++) {
      const t = ringCount <= 1 ? 0.5 : i / (ringCount - 1);
      this._tmpColor.copy(this._tmpColorA).lerp(this._tmpColorB, t);

      const geo = new THREE.TorusGeometry(radius, thickness, 18, 96);
      const mat = new THREE.MeshStandardMaterial({
        color: this._tmpColor,
        emissive: this._tmpColor,
        emissiveIntensity: p.emissive,
        metalness: 0.55,
        roughness: 0.25
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = false;

      // stack along Z like a tunnel / halo chamber
      const z = (i - (ringCount - 1) / 2) * p.spacing;
      mesh.position.set(0, 0, z);

      // alternating tilt adds depth
      mesh.rotation.x = (i % 2 === 0 ? 1 : -1) * 0.12;
      mesh.rotation.y = (i % 3 - 1) * 0.08;

      this.group.add(mesh);
      this.rings.push(mesh);
    }

    // Central orb (glass + chrome mix)
    const orbGeo = new THREE.SphereGeometry(Math.max(0.25, radius * 0.35), 64, 48);
    const orbMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#ffffff'),
      metalness: 0.65,
      roughness: 0.06,
      transmission: 0.75,
      thickness: 1.2,
      ior: 1.35,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
      emissive: new THREE.Color('#11112a'),
      emissiveIntensity: 0.7
    });
    this.orb = new THREE.Mesh(orbGeo, orbMat);
    this.orb.position.set(0, 0, 0);
    this.group.add(this.orb);

    this._needsRebuild = false;
  }

  /**
   * @param {number} dt
   * @param {number} t
   * @param {{freqData: Uint8Array, timeData: Uint8Array, frame: any}} audio
   */
  update(dt, t, audio) {
    if (this._needsRebuild) this.rebuild();

    const p = this.params.neonRings;
    const { freqData, frame } = audio;
    const ringCount = this.rings.length;
    const n = freqData.length || 1;

    const rot = p.rotationSpeed;
    this.group.rotation.z += dt * rot * 0.35;
    this.group.rotation.y += dt * rot * 0.25;

    // Orb reacts to beat
    if (this.orb) {
      const beat = frame.beat || 0;
      const s = 1.0 + beat * 0.12 + (frame.level || 0) * 0.05;
      this.orb.scale.setScalar(s);
      this.orb.rotation.y += dt * 0.35;
      this.orb.rotation.x += dt * 0.22;
    }

    // helper: map ring index to frequency bin
    const spectrumMode = p.spectrum || 'log';
    const idxToBin = (i) => {
      const u = ringCount <= 1 ? 0.5 : i / (ringCount - 1);
      const shaped = spectrumMode === 'linear' ? u : Math.pow(u, 2.2);
      return Math.min(n - 1, Math.max(0, Math.floor(shaped * (n - 1))));
    };

    for (let i = 0; i < ringCount; i++) {
      const mesh = this.rings[i];

      const bin = idxToBin(i);
      const band = 3;
      let acc = 0;
      let cnt = 0;
      for (let j = -band; j <= band; j++) {
        const k = Math.min(n - 1, Math.max(0, bin + j));
        acc += freqData[k];
        cnt++;
      }
      const amp = (acc / cnt) / 255; // 0..1

      const wobble = p.wobble;
      const baseZ = (i - (ringCount - 1) / 2) * p.spacing;

      // scale "breath"
      const scale = 1.0 + amp * 0.45 + (frame.bass || 0) * 0.12;
      mesh.scale.set(scale, scale, 1.0);

      // gentle wobble in tunnel
      mesh.position.x = Math.sin(t * 0.9 + i * 0.35) * wobble * (0.15 + amp * 0.45);
      mesh.position.y = Math.cos(t * 0.8 + i * 0.28) * wobble * (0.10 + amp * 0.35);
      mesh.position.z = baseZ + Math.sin(t * 0.7 + i * 0.2) * wobble * 0.05;

      mesh.rotation.z += dt * rot * (0.25 + amp * 1.2) * (i % 2 ? -1 : 1);

      // emissive pumping (bloom loves this)
      mesh.material.emissiveIntensity = p.emissive * (0.55 + amp * 1.6 + (frame.beat || 0) * 0.7);
    }
  }

  dispose() {
    for (const m of this.rings) {
      m.geometry.dispose();
      m.material.dispose();
    }
    this.rings.length = 0;

    if (this.orb) {
      this.orb.geometry.dispose();
      this.orb.material.dispose();
      this.orb = null;
    }

    this.scene?.remove(this.group);
  }
}
