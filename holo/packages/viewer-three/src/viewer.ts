import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { PostProcessing, type PostParams } from "./post/PostProcessing";

export type RenderMode = "mesh" | "points" | "hologram";

export type ViewerOptions = {
  canvas: HTMLCanvasElement;
  dpr?: number;
  renderMode?: RenderMode;
  pointSize?: number;
  pointColor?: string;
  hologramColor?: string;
  hologramOpacity?: number;
  post?: PostParams;
};

export type ViewerControlsOptions = {
  enablePan?: boolean;
  enableZoom?: boolean;
  dampingFactor?: number;
  screenSpacePanning?: boolean;
  minDistance?: number;
  maxDistance?: number;
  target?: [number, number, number];
};

const DEFAULT_POST: Required<PostParams> = {
  enabled: true,
  bloomStrength: 0.35,
  bloomThreshold: 0.2,
  bloomRadius: 0.16,
  scanlines: 0.24,
  chroma: 0.0018,
  noise: 0.05,
  vignette: 0.28,
};

export class BasicGltfViewer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private loader: GLTFLoader;
  private plyLoader: PLYLoader;
  private gltfRoot?: THREE.Object3D;
  private pointCloud?: THREE.Points;
  private pointsOverlay?: THREE.Group;
  private originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private renderMode: RenderMode;
  private pointSize: number;
  private pointColor: THREE.Color;
  private hologramColor: THREE.Color;
  private hologramOpacity: number;
  private hologramMaterial?: THREE.MeshBasicMaterial;
  private post?: PostProcessing;
  private postEnabled = false;

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
    this.plyLoader = new PLYLoader();

    this.renderMode = opts.renderMode ?? "mesh";
    this.pointSize = opts.pointSize ?? 0.006;
    this.pointColor = new THREE.Color(opts.pointColor ?? "#7ffcff");
    this.hologramColor = new THREE.Color(opts.hologramColor ?? "#7ffcff");
    this.hologramOpacity = opts.hologramOpacity ?? 0.55;

    const light1 = new THREE.DirectionalLight(0xffffff, 1.0);
    light1.position.set(1, 1, 2);
    this.scene.add(light1);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    if (this.renderMode === "hologram") {
      this.enablePost(opts.post);
    }

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
    if (this.post) {
      this.post.setSize(w, h);
    }
  }

  setScreenSpacePanning(enabled: boolean) {
    this.setControlsOptions({ screenSpacePanning: enabled });
  }

  setControlsOptions(options: ViewerControlsOptions) {
    if (options.enablePan !== undefined) this.controls.enablePan = options.enablePan;
    if (options.enableZoom !== undefined) this.controls.enableZoom = options.enableZoom;
    if (options.dampingFactor !== undefined) this.controls.dampingFactor = options.dampingFactor;
    if (options.screenSpacePanning !== undefined) {
      this.controls.screenSpacePanning = options.screenSpacePanning;
    }
    if (options.minDistance !== undefined) this.controls.minDistance = options.minDistance;
    if (options.maxDistance !== undefined) this.controls.maxDistance = options.maxDistance;
    if (options.target) {
      this.controls.target.set(options.target[0], options.target[1], options.target[2]);
    }
    this.controls.update();
  }

  panBy(deltaX: number, deltaY: number) {
    if (!this.controls?.enablePan) return;

    const camera = this.camera;
    const element = this.renderer.domElement;
    const target = this.controls.target;

    const panOffset = new THREE.Vector3();
    const offset = new THREE.Vector3();
    const panLeft = new THREE.Vector3();
    const panUp = new THREE.Vector3();

    const applyPan = (distanceX: number, distanceY: number) => {
      panLeft.setFromMatrixColumn(camera.matrix, 0).multiplyScalar(-distanceX);
      if (this.controls.screenSpacePanning) {
        panUp.setFromMatrixColumn(camera.matrix, 1);
      } else {
        panUp.setFromMatrixColumn(camera.matrix, 0).crossVectors(camera.up, panUp);
      }
      panUp.multiplyScalar(distanceY);
      panOffset.add(panLeft).add(panUp);
    };

    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      offset.copy(camera.position).sub(target);
      let targetDistance = offset.length();
      targetDistance *= Math.tan((camera.fov * Math.PI) / 360);

      applyPan(
        (2 * deltaX * targetDistance) / element.clientHeight,
        (2 * deltaY * targetDistance) / element.clientHeight
      );
    } else if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const ortho = camera as THREE.OrthographicCamera;
      applyPan(
        (deltaX * (ortho.right - ortho.left)) / ortho.zoom / element.clientWidth,
        (deltaY * (ortho.top - ortho.bottom)) / ortho.zoom / element.clientHeight
      );
    }

    if (panOffset.lengthSq() === 0) return;
    camera.position.add(panOffset);
    target.add(panOffset);
    this.controls.update();
  }

  async load(url: string, options?: { renderMode?: RenderMode }) {
    const clean = url.split("?")[0].toLowerCase();
    if (clean.endsWith(".ply")) {
      await this.loadPointCloud(url);
    } else {
      await this.loadGltf(url);
    }
    if (options?.renderMode) {
      this.setRenderMode(options.renderMode);
    } else {
      this.applyRenderMode();
    }
  }

  async loadPointCloud(url: string) {
    const geometry = await this.plyLoader.loadAsync(url);
    geometry.computeVertexNormals();

    const hasColors = geometry.getAttribute("color") !== undefined;
    const material = new THREE.PointsMaterial({
      size: this.pointSize,
      color: this.pointColor,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexColors: hasColors,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;

    if (this.pointCloud) {
      this.scene.remove(this.pointCloud);
      this.disposeObject(this.pointCloud);
    }

    this.pointCloud = points;
    this.scene.add(points);
    this.normalizeObject(points);
    this.applyRenderMode();
  }

  setRenderMode(mode: RenderMode) {
    this.renderMode = mode;
    if (mode === "hologram") {
      this.enablePost();
    } else {
      this.postEnabled = false;
    }
    this.applyRenderMode();
  }

  dispose() {
    if (this.post) {
      this.post.dispose();
    }
    this.renderer.dispose();
  }

  private async loadGltf(url: string) {
    const gltf = await this.loader.loadAsync(url);
    if (this.gltfRoot) {
      this.scene.remove(this.gltfRoot);
      this.disposeObject(this.gltfRoot);
      this.originalMaterials.clear();
    }

    this.gltfRoot = gltf.scene;
    this.scene.add(gltf.scene);

    this.normalizeObject(gltf.scene);
    this.cacheMaterials(gltf.scene);

    if (this.pointsOverlay) {
      this.scene.remove(this.pointsOverlay);
      this.disposeObject(this.pointsOverlay);
      this.pointsOverlay = undefined;
    }
  }

  private applyRenderMode() {
    if (this.gltfRoot) {
      if (this.renderMode === "hologram") {
        this.applyHologramMaterial();
      } else {
        this.restoreMaterials();
      }
    }

    if (this.renderMode === "points" || this.renderMode === "hologram") {
      if (!this.pointsOverlay && this.gltfRoot) {
        this.pointsOverlay = this.buildPointsOverlay(this.gltfRoot);
        this.scene.add(this.pointsOverlay);
      }
    }

    if (this.gltfRoot) {
      this.gltfRoot.visible = this.renderMode !== "points";
    }

    if (this.pointsOverlay) {
      this.pointsOverlay.visible = (this.renderMode === "points" || this.renderMode === "hologram") && !this.pointCloud;
    }

    if (this.pointCloud) {
      this.pointCloud.visible = this.renderMode === "points";
    }
  }

  private buildPointsOverlay(root: THREE.Object3D) {
    const group = new THREE.Group();
    root.updateMatrixWorld(true);

    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const geometry = obj.geometry;
      if (!geometry) return;

      const hasColors = geometry.getAttribute("color") !== undefined;
      const material = new THREE.PointsMaterial({
        size: this.pointSize,
        color: this.pointColor,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexColors: hasColors,
      });

      const points = new THREE.Points(geometry, material);
      points.frustumCulled = false;
      points.matrixAutoUpdate = false;
      points.matrix.copy(obj.matrixWorld);
      points.matrixWorld.copy(obj.matrixWorld);
      group.add(points);
    });

    return group;
  }

  private cacheMaterials(root: THREE.Object3D) {
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        this.originalMaterials.set(obj, obj.material);
      }
    });
  }

  private applyHologramMaterial() {
    if (!this.hologramMaterial) {
      this.hologramMaterial = new THREE.MeshBasicMaterial({
        color: this.hologramColor,
        transparent: true,
        opacity: this.hologramOpacity,
        blending: THREE.AdditiveBlending,
        wireframe: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    }

    if (!this.gltfRoot) return;
    this.gltfRoot.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.material = this.hologramMaterial as THREE.Material;
      }
    });
  }

  private restoreMaterials() {
    if (!this.gltfRoot) return;
    for (const [mesh, material] of this.originalMaterials.entries()) {
      mesh.material = material;
    }
  }

  private normalizeObject(obj: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    obj.position.sub(center);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = 1.4 / maxDim;
    obj.scale.setScalar(scale);
  }

  private enablePost(params?: PostParams) {
    this.postEnabled = true;
    if (!this.post) {
      const canvas = this.renderer.domElement;
      this.post = new PostProcessing(this.renderer, this.scene, this.camera, {
        width: canvas.clientWidth,
        height: canvas.clientHeight,
        params: { ...DEFAULT_POST, ...params },
      });
    } else if (params) {
      this.post.setParams(params);
    }
  }

  private disposeObject(obj: THREE.Object3D) {
    obj.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Points) {
        const geometry = child.geometry as THREE.BufferGeometry;
        geometry?.dispose?.();
        const material = child.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material)) {
          material.forEach((mat) => mat.dispose());
        } else {
          material?.dispose?.();
        }
      }
    });
  }

  private animate() {
    this.controls.update();
    if (this.post && this.postEnabled) {
      this.post.setTime(performance.now() * 0.001);
      this.post.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    requestAnimationFrame(this.animate);
  }
}
