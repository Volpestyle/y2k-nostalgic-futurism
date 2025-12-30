# img2mesh3d

A **single-image → multi-view → depth → Meshy multi-image-to-3D** toolkit.

- **Input:** one 2D image (file path or bytes)
- **Outputs:** a **GLB** (Three.js-friendly) + all intermediate artifacts (PNG views, depth maps, JSON manifests)
- **Backends:**
  - **Replicate** for background removal, multi-view generation, and depth maps
  - **Meshy** for multi-image-to-3D reconstruction & texturing

> This package is an abstraction/toolkit: you can use it from Python code, a CLI, or mount it behind an API service.

---

## Pipeline (high level)

![Pipeline Diagram](docs/diagrams/pipeline.png)

Artifacts are written to an output folder per run, so you can inspect the result of each step.

---

## Install (editable)

```bash
python -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -e ".[dev,api]"
```

---

## Required secrets (environment variables)

Set these in your shell (or inject them from AWS Secrets Manager in production):

```bash
export REPLICATE_API_TOKEN="..."
export MESHY_API_KEY="..."
```

Notes:
- Replicate's Python client reads `REPLICATE_API_TOKEN`.
- Meshy uses `Authorization: Bearer <api_key>`.

---

## CLI usage

```bash
img2mesh3d run \
  --input ./examples/chair.png \
  --out ./runs/demo \
  --meshy-images 4 \
  --pbr
```

The CLI prints progress and stores a `manifest.json` in the run folder.

---

## Python usage

```python
from img2mesh3d import ImageTo3DPipeline, PipelineConfig

cfg = PipelineConfig.from_env()
pipeline = ImageTo3DPipeline(cfg)

result = pipeline.run(
    input_path="examples/chair.png",
    out_dir="runs/demo",
)

print("GLB:", result.glb_path)
print("Meshy task:", result.meshy_task_id)
print("Views:", result.view_image_paths)
print("Depth maps:", result.depth_image_paths)
```

---

## Three.js snippet (GLB)

```js
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const loader = new GLTFLoader();
loader.load("/assets/model.glb", (gltf) => {
  scene.add(gltf.scene);
});
```

---

## Development scripts

- `scripts/setup_venv.sh` – quick local setup
- `scripts/run_api_dev.sh` – run FastAPI dev server (optional extra)
- `scripts/render_diagrams.sh` – generate docs PNGs from Mermaid (requires Node)
- `scripts/test.sh` – run pytest

---

## Model/version defaults

This repo pins model versions by default for reproducibility. You can override via `PipelineConfig`.

- **Background removal**: `bria/remove-background:1a075954...`
- **Multi-view**: `jd7h/zero123plusplus:c69c6559...`
- **Depth**: `chenxwh/depth-anything-v2:b239ea33...`

---

## Caveats

- This toolkit calls **paid hosted APIs** (Replicate + Meshy). You’ll want to add your own budget/quotas.
- Meshy Multi-Image-to-3D supports **1–4 input images**; this toolkit selects a subset of the 6 Zero123++ views by default.
- Output URLs from Meshy are typically signed/expiring; this toolkit downloads outputs into the run directory.

---
