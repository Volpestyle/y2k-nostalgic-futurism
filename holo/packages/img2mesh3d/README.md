# img2mesh3d (AWS async job runner edition)

A **2D image → 3D model** pipeline toolkit:

1. **Background removal** (Replicate: `bria/remove-background`)
2. **Multi-view generation** (Replicate: `jd7h/zero123plusplus`)
3. **Depth maps** for each view (Replicate: `chenxwh/depth-anything-v2`)
4. **Local reconstruction** (Open3D fusion → Poisson/alpha mesh + UV/texture bake → **GLB**)

Local reconstruction uses **Open3D + trimesh**, with optional **pyxatlas** or **Blender CLI** for UV/texture baking.

To enable texture baking on systems where pyxatlas is available:

```bash
pip install -e ".[texture]"
```

To bake textures with Blender instead:

```bash
export IMG2MESH3D_TEXTURE_BACKEND=blender
export IMG2MESH3D_BLENDER_PATH=/Applications/Blender.app/Contents/MacOS/Blender
```

This repo is intentionally an **abstraction / toolkit**:
- run the pipeline **locally** (sync CLI / Python API)
- or run it **asynchronously on AWS** using **SQS + worker**, with:
  - **job IDs**
  - **polling endpoints**
  - **SSE log/progress streaming**
  - **S3 artifact sink**
  - **configurable concurrency** for depth-map generation

> Secrets are loaded from environment variables (e.g. `REPLICATE_API_TOKEN`, `MESHY_API_KEY`).
> In AWS, inject them from Secrets Manager into your task/container environment.

---

## Install

```bash
python -m venv .venv
source .venv/bin/activate
pip install -U pip

# clients live in ai-kit
pip install -e /path/to/ai-kit/packages/python
pip install -e /path/to/ai-kit/packages/python-inference

# base toolkit (sync pipeline + AWS job runner primitives)
pip install -e .

# API server extras
pip install -e ".[api]"

# dev/test tools
pip install -e ".[dev]"
```

---

## Required environment variables

### AI providers
- `REPLICATE_API_TOKEN`

### AWS async runner (API + worker)
- `IMG2MESH3D_QUEUE_URL` (SQS queue URL)
- `IMG2MESH3D_DDB_TABLE` (DynamoDB table name)
- `IMG2MESH3D_S3_BUCKET` (S3 bucket for artifacts)
- `IMG2MESH3D_S3_PREFIX` (optional, default: `img2mesh3d`)

Optional:
- `AWS_REGION` (or standard AWS env/SDK region resolution)
- `IMG2MESH3D_JOB_TTL_DAYS` (default: 7; only used if your table has TTL enabled)
- `IMG2MESH3D_MAX_DEPTH_CONCURRENCY` (default: 2)

---

## Local sync run (CLI)

```bash
export REPLICATE_API_TOKEN="..."
export MESHY_API_KEY="..."

img2mesh3d run \
  --input ./examples/chair.png \
  --out ./runs/demo \
  --depth-concurrency 2 \
  --recon-method poisson \
  --texture
```

Artifacts are written to the `--out` folder.

---

## AWS async mode (SQS + worker)

### 1) Provision AWS resources

A CloudFormation template is included at:

- `infra/cloudformation.yml`

It creates:
- SQS queue (+ DLQ)
- DynamoDB table (PK=`job_id` string, SK=`sort` number)
- S3 bucket for artifacts

### 2) Run the API server

```bash
pip install -e ".[api]"
IMG2MESH3D_LOCAL_MODE=1 uvicorn img2mesh3d.api.app:app --host 0.0.0.0 --port 8080
```

Endpoints:
- `POST /v1/jobs` (multipart upload) → returns `job_id`
- `GET /v1/jobs/{job_id}` → current status + artifact pointers
- `GET /v1/jobs/{job_id}/events` → **SSE** stream of logs/progress
- `GET /healthz`

### 3) Run the worker

```bash
img2mesh3d-worker
```

The worker:
- long-polls SQS
- downloads the input image from S3
- runs the pipeline
- uploads artifacts to S3
- writes job state + events to DynamoDB
- deletes the SQS message on success

---

## Three.js consumption

The job artifacts include a `model.glb` rendered locally, directly usable in Three.js with `GLTFLoader`.
The API returns S3 keys; you can generate presigned URLs (helper provided in `img2mesh3d.aws.s3`).

---

## Repo layout

- `src/pipeline.py` — pipeline orchestrator
- `src/jobs/runner_sqs.py` — enqueue jobs
- `src/jobs/store_dynamodb.py` — job state + events store
- `src/worker_main.py` — SQS worker process
- `src/api/app.py` — FastAPI server
- `infra/cloudformation.yml` — AWS resources template
- `docs/` — diagrams + usage

---

## Development

```bash
pytest -q
ruff check .
```
