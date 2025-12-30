# Local development

This scaffold supports a **"local bake server"** mode:

- Go API runs on `localhost:8080`
- Python worker runs on your machine and polls for jobs
- Artifacts are stored under `./local-data/`

> For serious GPU use on Apple Silicon, prefer running the Python worker **natively** (not in Docker) so you can use PyTorch `mps`.

## 1) Start the Go API

From repo root:

```bash
cd packages/api-go
go run ./cmd/api
```

The API will create a SQLite job DB and local blob folder in `./local-data/`.

## 2) Start the Python worker

In another terminal:

```bash
cd packages/worker-py
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m worker.worker
```

The worker will:

- poll the job DB
- process queued jobs
- write a result (`result.gltf`) back to local storage

## Optional: ai-kit (model registry + captions)

The demo UI pulls model metadata from `/v1/ai/provider-models` (ai-kit). Pipeline model dropdowns
are backed by the ai-kit `catalog` provider, defined in the ai-kit repo at
`models/catalog_models.json`. Vision-capable models still come from configured LLM providers and are
used for captions.

If you only need the catalog (pipeline models), you can run with no provider keys configured.
Set at least one provider key before starting the API and worker to enable captioning:

```bash
export AI_KIT_OPENAI_API_KEY=...
# or: AI_KIT_ANTHROPIC_API_KEY, AI_KIT_GOOGLE_API_KEY, AI_KIT_XAI_API_KEY
```

Optional: point OpenAI-compatible requests at a local server:

```bash
export AI_KIT_OPENAI_BASE_URL=http://localhost:11434/v1
```

If you want Hugging Face-backed cutout/depth/views, set the HF token in **both** the API and
worker environments so model listing and inference succeed:

```bash
export AI_KIT_HUGGINGFACE_TOKEN=...
# or: HUGGINGFACE_TOKEN, HF_TOKEN
```

## 3) Start the demo web app

```bash
cd apps/demo-web
pnpm install
pnpm dev
```

Open the Vite URL (printed in the terminal), upload an image, and wait for the placeholder result.

## Local adapter notes

- Replace the placeholder worker steps with your real pipeline stages (cutout → multi-view → depth → fuse → decimate → export).
- The API does **not** need to change if you preserve the BakeSpec + output conventions.

### Pipeline runner modes

The worker auto-selects local vs api based on the BakeSpec (any stage with a
`provider` uses api runners with local fallback). You can override:

```bash
export HOLO_PIPELINE_RUNNER=local
# export HOLO_PIPELINE_RUNNER=api
# export HOLO_PIPELINE_RUNNER=auto
# for remote stages:
# export HOLO_PIPELINE_RUNNER=remote
# export HOLO_PIPELINE_REMOTE_URL=http://localhost:9090
```

`packages/pipeline-service` provides a minimal FastAPI implementation of the remote runner.
