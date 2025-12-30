# Local development

This repo runs on **img2mesh3d** for both the API and pipeline execution.

## 1) Install img2mesh3d (API extras)

```bash
cd packages/img2mesh3d
python -m venv .venv
source .venv/bin/activate
pip install -e ".[api]"
```

Make sure these env vars are set (see `holo/.env`):

- `REPLICATE_API_TOKEN`
- `MESHY_API_KEY`

## 2) Start the API (local mode)

```bash
export IMG2MESH3D_LOCAL_MODE=1
uvicorn img2mesh3d.api.app:app --host 0.0.0.0 --port 8080
```

Local mode runs the pipeline in-process and writes artifacts under
`./local-data/img2mesh3d`.

## 3) Start the demo web app

```bash
cd apps/demo-web
pnpm install
pnpm dev
```

Open the Vite URL (printed in the terminal), upload an image, and wait for the model.

## Optional: AWS async mode

To use SQS/DynamoDB/S3 + worker:

```bash
export IMG2MESH3D_QUEUE_URL=...
export IMG2MESH3D_DDB_TABLE=...
export IMG2MESH3D_S3_BUCKET=...
export IMG2MESH3D_S3_PREFIX=img2mesh3d
img2mesh3d-worker
```

The API can run without `IMG2MESH3D_LOCAL_MODE` when those AWS values are present.
