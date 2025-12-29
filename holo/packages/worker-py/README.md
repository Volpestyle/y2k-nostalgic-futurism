# worker-py

This is the **GPU worker** package (Python).

In the scaffold, the worker:

- polls the shared job DB (`local-data/jobs.db`)
- pulls input blobs from the blob store (local filesystem)
- writes a placeholder glTF output

Replace the `worker/pipeline.py` steps with your actual pipeline:

cutout → multi-view → depth → fuse → reconstruct mesh → decimate → export (GLB)

## ai-kit (optional)

The placeholder pipeline can generate an optional caption with ai-kit if you enable it in the
`BakeSpec` (`ai.caption.enabled=true`). Pipeline model dropdowns are driven by the ai-kit catalog
defined in the ai-kit repo at `models/catalog_models.json`.

Novel-view models (Zero123/Stable Zero123/Zero123++) rely on remote pipeline code. Set
`AI_KIT_TRUST_REMOTE_CODE=1` when running the worker so diffusers can load them.

The requirements file installs ai-kit from a local path. If your directory layout differs, update:

```
../../../../ai-kit/packages/python
```

Provide provider keys via env (one is enough) if you want captioning:

```bash
export AI_KIT_OPENAI_API_KEY=...
# or: AI_KIT_ANTHROPIC_API_KEY, AI_KIT_GOOGLE_API_KEY, AI_KIT_XAI_API_KEY
```

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m worker.worker
```

## Pipeline runner mode

The worker can dispatch pipeline stages to local, api, or remote runners:

```bash
export HOLO_PIPELINE_RUNNER=local
# export HOLO_PIPELINE_RUNNER=api
# export HOLO_PIPELINE_RUNNER=remote
# export HOLO_PIPELINE_REMOTE_URL=http://localhost:9090
```

The remote runner can be served by `packages/pipeline-service`.
