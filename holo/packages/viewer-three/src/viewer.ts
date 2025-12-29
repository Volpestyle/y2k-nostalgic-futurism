import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export type ViewerOptions = {
  canvas: HTMLCanvasElement;
  dpr?: number;
};

export class BasicGltfViewer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private loader: GLTFLoader;
  private current?: THREE.Object3D;

  constructor(opts: ViewerOptions) {
    const { canvas, dpr = Math.min(window.devicePixelRatio || 1, 2) } = opts;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    this.scene = new THREE.Scene();
    this.scene.background = null;

    this.camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.01, 100);
    this.camera.position.set(0, 0, 2.2);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;

    this.loader = new GLTFLoader();

    const light1 = new THREE.DirectionalLight(0xffffff, 1.0);
    light1.position.set(1, 1, 2);
    this.scene.add(light1);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  resize() {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async load(url: string) {
    const gltf = await this.loader.loadAsync(url);
    if (this.current) {
      this.scene.remove(this.current);
    }
    this.current = gltf.scene;
    this.scene.add(gltf.scene);

    // Normalize scale/center
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    gltf.scene.position.sub(center);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = 1.4 / maxDim;
    gltf.scene.scale.setScalar(scale);
  }

  dispose() {
    this.renderer.dispose();
  }

  private animate() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.animate);
  }
}
